"""轻排班 —— Flask 应用：页面路由与 JSON API。

启动：python app.py（开发服务器，默认 http://127.0.0.1:5001）
环境变量：SHIFTLITE_DB 数据库路径；SHIFTLITE_SECRET 会话密钥（部署时务必设置）
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import urllib.parse
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import (Flask, Response, abort, g, jsonify, redirect,
                   render_template, request, send_file, session, url_for)

import db as database
from core import exporter, scheduling, worktime

TIME_RE = re.compile(r"^\d{2}:\d{2}$")

# 头像允许的图片格式（按文件头魔数校验，而非仅扩展名）
IMAGE_MAGIC = {
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".gif": b"GIF8",
    ".webp": b"RIFF",
}
AVATAR_MAX_BYTES = 2 * 1024 * 1024  # 2MB

# ---------- 认证（单管理员账号） ----------
DEFAULT_ADMIN_PASSWORD = "shiftlite123"   # 演示默认密码，登录后请在设置页修改
PBKDF2_ITERATIONS = 200_000
_LOGIN_MAX_ATTEMPTS = 5
_LOGIN_WINDOW = timedelta(minutes=15)
_login_failures = {}          # ip -> [失败次数, 窗口起点]（进程内限速，重启即清零）
_login_lock = threading.Lock()


def hash_password(password: str, salt_hex: str | None = None) -> str:
    """PBKDF2-SHA256 加盐哈希，存储格式 salt_hex$digest_hex。"""
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = str(stored).split("$", 1)
    except ValueError:
        return False
    candidate = hash_password(password, salt_hex).split("$", 1)[1]
    return hmac.compare_digest(candidate, digest_hex)


def _throttle_remaining(ip: str) -> int:
    """登录失败限速：窗口内失败达上限则返回剩余等待秒数，否则 0。"""
    with _login_lock:
        entry = _login_failures.get(ip)
        if not entry:
            return 0
        count, started = entry
        elapsed = datetime.now() - started
        if elapsed > _LOGIN_WINDOW:
            _login_failures.pop(ip, None)
            return 0
        if count >= _LOGIN_MAX_ATTEMPTS:
            return int((_LOGIN_WINDOW - elapsed).total_seconds())
        return 0


def _throttle_fail(ip: str) -> None:
    with _login_lock:
        entry = _login_failures.get(ip)
        now = datetime.now()
        if not entry or now - entry[1] > _LOGIN_WINDOW:
            _login_failures[ip] = [1, now]
        else:
            entry[0] += 1


def _throttle_reset(ip: str) -> None:
    with _login_lock:
        _login_failures.pop(ip, None)

UPLOAD_DIR = Path(__file__).resolve().parent / "static" / "uploads"


def _detect_image_ext(data: bytes) -> str | None:
    """按文件头识别图片类型，返回规范扩展名；不识别返回 None。"""
    for ext, magic in IMAGE_MAGIC.items():
        if data[:len(magic)] == magic:
            # webp 需进一步确认 RIFF 容器标记
            if ext == ".webp" and data[8:12] != b"WEBP":
                continue
            return ".jpg" if ext == ".jpeg" else ext
    return None


def _invalid_clock(value: str) -> bool:
    """HH:MM 文本数值越界（如 99:00）时返回 True。"""
    try:
        scheduling.parse_hhmm(value)
        return False
    except ValueError:
        return True


def create_app(db_path=None) -> Flask:
    app = Flask(__name__)
    import os
    app.config["SECRET_KEY"] = os.environ.get("SHIFTLITE_SECRET", "shiftlite-prototype")
    app.config["DB_PATH"] = str(db_path or database.DB_PATH)
    database.init_db(app.config["DB_PATH"])
    app.jinja_env.globals["range_duration"] = scheduling.shift_span_minutes

    # 会话密钥：优先环境变量，否则持久化随机密钥到 settings（改密后旧会话仍有效属原型口径）
    boot_conn = database.get_connection(app.config["DB_PATH"])
    try:
        boot = database.load_settings(boot_conn)
        if not boot.get("session_secret"):
            database.save_settings(boot_conn, {"session_secret": secrets.token_hex(32)})
            boot = database.load_settings(boot_conn)
        app.secret_key = os.environ.get("SHIFTLITE_SECRET") or boot["session_secret"]
        # 管理员密码自举：首次运行写入默认密码的哈希
        if not boot.get("admin_password_hash"):
            database.save_settings(boot_conn, {"admin_password_hash": hash_password(DEFAULT_ADMIN_PASSWORD)})
    finally:
        boot_conn.close()
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
    )

    @app.before_request
    def require_login():
        """登录保护：未登录访问页面跳转 /login，API 返回 401 JSON。"""
        if request.endpoint in ("login", "static"):
            return None
        if request.path.startswith("/static/"):
            return None
        if session.get("user"):
            return None
        if request.path.startswith("/api/"):
            return Response('{"errors": ["登录已过期，请重新登录"]}', 401, mimetype="application/json")
        nxt = request.path if request.method == "GET" else "/"
        return redirect(url_for("login", next=nxt))

    def resolve_brand_avatar(settings) -> str:
        """校验品牌头像可用性：Data URL 直接可用；文件路径须存在，失效则自愈清空
        （历史遗留的失效值会让侧边栏与站点图标指向 404）。"""
        value = settings.get("brand_avatar") or ""
        if not value:
            return ""
        if value.startswith("data:"):
            return value
        if (UPLOAD_DIR / Path(value).name).is_file():
            return value
        conn = get_db()
        database.save_settings(conn, {"brand_avatar": ""})
        return ""

    @app.context_processor
    def inject_brand():
        """向所有模板注入品牌信息（系统标题与头像），供侧边栏/标签页/站点图标使用。"""
        s = database.load_settings(get_db())
        return {"app_title": s.get("app_title") or "轻排班",
                "brand_avatar": resolve_brand_avatar(s)}

    @app.after_request
    def no_cache_html(response):
        """动态页面禁止启发式缓存，避免界面/图标更新后浏览器仍显示旧版本。"""
        if response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-cache"
        return response

    # ---------- 通用工具 ----------

    def get_db():
        if "db" not in g:
            g.db = database.get_connection(app.config["DB_PATH"])
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def parse_date(text, fallback=None):
        try:
            return date.fromisoformat(str(text))
        except (TypeError, ValueError):
            return fallback

    def load_employees(conn, active_only=False):
        sql = "SELECT * FROM employees"
        if active_only:
            sql += " WHERE status = 'active'"
        sql += " ORDER BY employment_type DESC, name"
        rows = [dict(r) for r in conn.execute(sql).fetchall()]
        for row in rows:
            row["available_day_list"] = sorted(database.parse_available_days(row["available_days"]))
        return rows

    def fetch_schedules(conn, start: date, end: date, with_names=True) -> list[dict]:
        """取 work_date 落在 [start, end] 的排班，含员工与模板冗余信息。"""
        sql = """
            SELECT s.*, e.name AS employee_name, e.employment_type,
                   t.name AS template_name, t.color AS template_color
            FROM schedules s
            JOIN employees e ON e.id = s.employee_id
            LEFT JOIN shift_templates t ON t.id = s.template_id
            WHERE s.work_date >= ? AND s.work_date <= ?
            ORDER BY s.work_date, s.start_time, s.id
        """
        rows = []
        for r in conn.execute(sql, (start.isoformat(), end.isoformat())).fetchall():
            row = dict(r)
            row["work_date"] = date.fromisoformat(row["work_date"])
            rows.append(row)
        return rows

    def week_conflicts(conn, start: date, end: date, settings) -> list[dict]:
        """计算一周内全部排班的冲突列表（含与相邻周界班次的间隔/重叠）。

        展示层去重：每日工时上限提示按“员工+日期”只报一次，
        每周工时上限提示按“员工+周”只报一次，班间休息按“员工+两班组合”只报一次，
        避免同一条件随班次数量重复刷屏。
        """
        employees = {e["id"]: e for e in load_employees(conn)}
        rows = fetch_schedules(conn, start - timedelta(days=2), end + timedelta(days=2))
        by_employee: dict[int, list[dict]] = {}
        for row in rows:
            by_employee.setdefault(row["employee_id"], []).append(row)
        results = []
        seen_daily, seen_weekly, seen_rest = set(), set(), set()
        for row in rows:
            if not (start <= row["work_date"] <= end):
                continue
            emp = employees.get(row["employee_id"])
            if emp is None:
                continue
            # 传入该员工获取范围内的全部班次：重叠/休息只受邻近班次影响，
            # 每日/每周工时上限则需要对完整统计周期求和
            neighbors = [r for r in by_employee[row["employee_id"]]
                         if r["id"] != row["id"]]
            found = scheduling.check_conflicts(
                {"id": row["id"], "work_date": row["work_date"],
                 "start_time": row["start_time"], "end_time": row["end_time"],
                 "break_minutes": row["break_minutes"]},
                neighbors,
                {"employment_type": emp["employment_type"],
                 "available_days": emp["available_day_list"],
                 "available_from": emp["available_from"],
                 "available_to": emp["available_to"]},
                settings)
            for conflict in found:
                if conflict.rule == "daily_limit":
                    key = (row["employee_id"], row["work_date"])
                    if key in seen_daily:
                        continue
                    seen_daily.add(key)
                elif conflict.rule == "weekly_limit":
                    key = (row["employee_id"], scheduling.week_range(row["work_date"]))
                    if key in seen_weekly:
                        continue
                    seen_weekly.add(key)
                elif conflict.rule == "rest":
                    pair = frozenset({row["id"], conflict.related_schedule_id})
                    key = (row["employee_id"], pair)
                    if key in seen_rest:
                        continue
                    seen_rest.add(key)
                results.append({
                    "schedule_id": row["id"],
                    "employee_name": emp["name"],
                    "date": row["work_date"].isoformat(),
                    "weekday": scheduling.WEEKDAY_NAMES[row["work_date"].isoweekday()],
                    "time": f"{row['start_time']}–{row['end_time']}",
                    **conflict.as_dict(),
                })
        severity_order = {"error": 0, "warning": 1}
        results.sort(key=lambda c: (c["date"], severity_order[c["severity"]]))
        return results

    def period_from_args(args, default_period="week"):
        """从查询参数解析统计周期与日期，返回 (period, anchor_date)。"""
        period = args.get("period", default_period)
        if period not in ("day", "week", "month"):
            period = default_period
        anchor = parse_date(args.get("date"), date.today())
        return period, anchor

    # ---------- 认证路由 ----------

    @app.route("/login", methods=["GET", "POST"])
    def login():
        from flask import flash, session
        if session.get("user"):
            return redirect(url_for("dashboard"))
        conn = get_db()
        settings = database.load_settings(conn)
        error = None
        if request.method == "POST":
            ip = request.remote_addr or "unknown"
            wait = _throttle_remaining(ip)
            if wait > 0:
                error = f"尝试过于频繁，请约 {max(1, wait // 60) + 1} 分钟后再试"
            else:
                username = request.form.get("username", "").strip()
                password = request.form.get("password", "")
                if username and username != "admin":
                    error = "用户名不存在，请重试"
                else:
                    if verify_password(password, settings.get("admin_password_hash", "")):
                        _throttle_reset(ip)
                        session.clear()
                        session["user"] = "admin"
                        session.permanent = True
                        nxt = request.form.get("next") or request.args.get("next") or "/"
                        if not nxt.startswith("/") or nxt.startswith("//"):
                            nxt = "/"
                        return redirect(nxt)
                    _throttle_fail(ip)
                    error = "密码错误，请重试"
        brand_avatar = resolve_brand_avatar(settings)
        return render_template("login.html", app_title=settings.get("app_title") or "轻排班",
                               brand_avatar=brand_avatar, error=error,
                               next=request.args.get("next") or "")

    @app.route("/logout", methods=["POST"])
    def logout():
        from flask import session
        session.clear()
        return redirect(url_for("login"))

    @app.route("/settings/password", methods=["POST"])
    def change_password():
        from flask import flash
        conn = get_db()
        settings = database.load_settings(conn)
        current = request.form.get("current_password", "")
        new = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        if not verify_password(current, settings.get("admin_password_hash", "")):
            flash("修改失败：当前密码不正确。", "error")
            return redirect(url_for("settings_page"))
        if len(new) < 6:
            flash("修改失败：新密码至少 6 位。", "error")
            return redirect(url_for("settings_page"))
        if new != confirm:
            flash("修改失败：两次输入的新密码不一致。", "error")
            return redirect(url_for("settings_page"))
        database.save_settings(conn, {"admin_password_hash": hash_password(new)})
        flash("密码已更新，下次登录请使用新密码。", "success")
        return redirect(url_for("settings_page"))

    # ---------- 页面路由 ----------

    @app.route("/")
    def dashboard():
        conn = get_db()
        settings = database.load_settings(conn)
        today = date.today()
        w_start, w_end = scheduling.week_range(today)
        employees = load_employees(conn, active_only=True)
        week_rows = fetch_schedules(conn, w_start, w_end)
        conflicts = week_conflicts(conn, w_start, w_end, settings)
        summary = worktime.summarize(week_rows, w_start, w_end)
        week_minutes = sum(item["effective_minutes"] for item in summary)
        today_rows = [r for r in week_rows if r["work_date"] == today]
        month_start, month_end = scheduling.month_range(today.year, today.month)
        month_rows = fetch_schedules(conn, month_start, month_end)
        return render_template(
            "dashboard.html",
            week_start=w_start, week_end=w_end, today=today,
            employee_count=len(employees),
            week_shift_count=len(week_rows),
            week_hours=worktime.hours(week_minutes),
            conflict_errors=[c for c in conflicts if c["severity"] == "error"],
            conflict_warnings=[c for c in conflicts if c["severity"] == "warning"],
            today_rows=today_rows, weekday_name=scheduling.WEEKDAY_NAMES[today.isoweekday()],
            month_shift_count=len(month_rows),
        )

    @app.route("/schedule")
    def schedule_page():
        conn = get_db()
        settings = database.load_settings(conn)
        anchor = parse_date(request.args.get("date"), date.today())
        w_start, w_end = scheduling.week_range(anchor)
        days = [w_start + timedelta(days=i) for i in range(7)]
        employees = load_employees(conn, active_only=True)
        templates = [dict(r) for r in conn.execute(
            "SELECT * FROM shift_templates ORDER BY start_time").fetchall()]
        rows = fetch_schedules(conn, w_start, w_end)
        conflicts = week_conflicts(conn, w_start, w_end, settings)

        # 当周有历史班次的停用员工仍显示在网格中，避免记录看似“消失”；
        # 新增/编辑下拉框仍只提供在职员工。
        active_ids = {employee["id"] for employee in employees}
        inactive_ids = {row["employee_id"] for row in rows if row["employee_id"] not in active_ids}
        if inactive_ids:
            placeholders = ",".join("?" for _ in inactive_ids)
            inactive_rows = conn.execute(
                f"SELECT * FROM employees WHERE id IN ({placeholders}) ORDER BY name",
                tuple(sorted(inactive_ids))).fetchall()
            inactive_employees = [dict(row) for row in inactive_rows]
        else:
            inactive_employees = []
        grid_employees = employees + inactive_employees

        grid: dict[tuple[int, str], list[dict]] = {}
        conflict_by_schedule: dict[int, list[dict]] = {}
        employee_week_minutes = {employee["id"]: 0 for employee in grid_employees}
        day_staff = {day.isoformat(): set() for day in days}
        day_shift_counts = {day.isoformat(): 0 for day in days}
        for row in rows:
            day_iso = row["work_date"].isoformat()
            grid.setdefault((row["employee_id"], day_iso), []).append(row)
            employee_week_minutes[row["employee_id"]] = (
                employee_week_minutes.get(row["employee_id"], 0) +
                scheduling.effective_minutes(
                    row["start_time"], row["end_time"], row["break_minutes"]))
            day_staff[day_iso].add(row["employee_id"])
            day_shift_counts[day_iso] += 1
        day_counts = {day_iso: len(employee_ids) for day_iso, employee_ids in day_staff.items()}
        for c in conflicts:
            conflict_by_schedule.setdefault(c["schedule_id"], []).append(c)

        # 移动端“按日”视图：anchor 当日全部班次，按开始时间排序并预计算工时概览，
        # 手机上以班次卡片展示（员工、岗位、时间、休息时长、有效工时）。
        day_shifts: list[dict] = []
        for row in rows:
            if row["work_date"] != anchor:
                continue
            item = dict(row)
            brk = int(item.get("break_minutes") or 0)
            span = scheduling.shift_span_minutes(item["start_time"], item["end_time"])
            item["effective_minutes"] = max(0, span - brk)
            item["effective_hours"] = worktime.hours(item["effective_minutes"])
            item["cross_day"] = item["end_time"] <= item["start_time"]
            day_shifts.append(item)
        day_shifts.sort(key=lambda i: (i["start_time"], i["employee_name"]))

        return render_template(
            "schedule.html",
            days=days, week_start=w_start, week_end=w_end,
            anchor=anchor, prev_week=w_start - timedelta(days=7),
            next_week=w_start + timedelta(days=7), today=date.today(),
            employees=employees, grid_employees=grid_employees, templates=templates,
            grid=grid, conflicts=conflicts,
            conflict_by_schedule=conflict_by_schedule,
            employee_week_minutes=employee_week_minutes,
            day_counts=day_counts, day_shift_counts=day_shift_counts,
            day_shifts=day_shifts,
            weekday_names=scheduling.WEEKDAY_NAMES,
            weekday_name=scheduling.WEEKDAY_NAMES,
        )

    @app.route("/employees", methods=["GET", "POST"])
    def employees_page():
        conn = get_db()
        if request.method == "POST":
            action = request.form.get("action", "create")
            emp_id = request.form.get("id")
            form = _employee_form(request.form)
            errors = _validate_employee(form)
            if action in ("update", "delete") and not emp_id:
                errors.append("缺少员工编号")
            if action == "delete":
                used = conn.execute(
                    "SELECT COUNT(*) FROM schedules WHERE employee_id = ?",
                    (emp_id,)).fetchone()[0]
                if used:
                    conn.execute(
                        "UPDATE employees SET status = 'inactive' WHERE id = ?", (emp_id,))
                    conn.commit()
                    from flask import flash
                    flash("该员工已有排班记录，已改为“离职（停用）”以保留历史数据。", "warning")
                    return redirect(url_for("employees_page"))
                conn.execute("DELETE FROM employees WHERE id = ?", (emp_id,))
                conn.commit()
                from flask import flash
                flash("员工已删除。", "success")
                return redirect(url_for("employees_page"))
            if errors:
                from flask import flash
                flash("保存失败：" + "；".join(errors), "error")
                return redirect(url_for("employees_page"))
            if action == "update":
                conn.execute(
                    """UPDATE employees SET name=?, position=?, employment_type=?,
                       phone=?, available_days=?, available_from=?, available_to=?,
                       status=?, note=? WHERE id=?""",
                    (*form, emp_id))
                from flask import flash
                flash("员工信息已更新。", "success")
            else:
                conn.execute(
                    """INSERT INTO employees(name, position, employment_type, phone,
                       available_days, available_from, available_to, status, note)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", form)
                from flask import flash
                flash("员工已新增。", "success")
            conn.commit()
            return redirect(url_for("employees_page"))
        rows = load_employees(conn)
        counts = {r["employee_id"]: r["n"] for r in conn.execute(
            "SELECT employee_id, COUNT(*) AS n FROM schedules GROUP BY employee_id")}
        return render_template("employees.html", employees=rows, schedule_counts=counts,
                               weekday_names=scheduling.WEEKDAY_NAMES)

    @app.route("/shift-templates", methods=["GET", "POST"])
    def shift_templates_page():
        conn = get_db()
        if request.method == "POST":
            action = request.form.get("action", "create")
            tpl_id = request.form.get("id")
            name = request.form.get("name", "").strip()
            start = request.form.get("start_time", "").strip()
            end = request.form.get("end_time", "").strip()
            brk = request.form.get("break_minutes", "0")
            position = request.form.get("position", "").strip()
            color = request.form.get("color", "primary")
            note = request.form.get("note", "").strip()
            errors = []
            if not name:
                errors.append("请填写班次名称")
            for label, value in (("开始时间", start), ("结束时间", end)):
                if not TIME_RE.match(value):
                    errors.append(f"{label}格式应为 HH:MM")
            span = None
            if not errors:
                try:
                    span = scheduling.shift_span_minutes(start, end)
                except ValueError as exc:
                    errors.append(str(exc))
            if not re.match(r"^\d+$", brk or "") or not (0 <= int(brk) <= 720):
                errors.append("休息时长应为 0–720 的整数分钟")
            elif span is not None and int(brk) >= span:
                errors.append("休息时长必须小于班次总时长")
            if errors:
                from flask import flash
                flash("保存失败：" + "；".join(errors), "error")
                return redirect(url_for("shift_templates_page"))
            if action == "update" and tpl_id:
                conn.execute(
                    """UPDATE shift_templates SET name=?, start_time=?, end_time=?,
                       break_minutes=?, position=?, color=?, note=? WHERE id=?""",
                    (name, start, end, int(brk), position, color, note, tpl_id))
                from flask import flash
                flash("班次模板已更新。", "success")
            else:
                conn.execute(
                    """INSERT INTO shift_templates(name, start_time, end_time,
                       break_minutes, position, color, note) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (name, start, end, int(brk), position, color, note))
                from flask import flash
                flash("班次模板已新增。", "success")
            conn.commit()
            return redirect(url_for("shift_templates_page"))
        templates = [dict(r) for r in conn.execute(
            "SELECT * FROM shift_templates ORDER BY start_time").fetchall()]
        usage = {r["template_id"]: r["n"] for r in conn.execute(
            "SELECT template_id, COUNT(*) AS n FROM schedules WHERE template_id IS NOT NULL "
            "GROUP BY template_id")}
        return render_template("shift_templates.html", templates=templates, usage=usage)

    @app.route("/shift-templates/<int:tpl_id>/delete", methods=["POST"])
    def delete_template(tpl_id):
        conn = get_db()
        conn.execute("DELETE FROM shift_templates WHERE id = ?", (tpl_id,))
        conn.commit()
        from flask import flash
        flash("模板已删除；使用该模板的历史排班已保留为自定义时间。", "success")
        return redirect(url_for("shift_templates_page"))

    @app.route("/hours")
    def hours_page():
        conn = get_db()
        settings = database.load_settings(conn)
        period, anchor = period_from_args(request.args)
        if period == "day":
            start = end = anchor
        elif period == "month":
            start, end = scheduling.month_range(anchor.year, anchor.month)
        else:
            start, end = scheduling.week_range(anchor)
        rows = fetch_schedules(conn, start, end)
        summary = worktime.summarize(rows, start, end)
        day_columns = None
        if period == "week":
            day_columns = [((start + timedelta(days=i)).isoformat(),
                            scheduling.WEEKDAY_NAMES[i + 1]) for i in range(7)]
        # 超限统计（周视图：周上限；月视图：各周汇总后判断）
        for item in summary:
            key = ("weekly_max_minutes_fulltime" if item["employment_type"] == "fulltime"
                   else "weekly_max_minutes_parttime")
            item["weekly_limit_hours"] = worktime.hours(int(settings.get(key) or 0))
        prev_step = 1 if period in ("day", "month") else 7
        prev_link = url_for("hours_page", period=period,
                            date=(start - timedelta(days=prev_step)).isoformat())
        next_link = url_for("hours_page", period=period,
                            date=(end + timedelta(days=1 if period == "month" else 1)).isoformat())
        period_label = {"day": f"{start.isoformat()}（{scheduling.WEEKDAY_NAMES[start.isoweekday()]}）",
                        "week": f"{start.isoformat()} 至 {end.isoformat()}",
                        "month": f"{anchor.year} 年 {anchor.month} 月"}[period]
        return render_template("hours.html", period=period, anchor=anchor,
                               start=start, end=end, summary=summary,
                               day_columns=day_columns, period_label=period_label,
                               prev_link=prev_link, next_link=next_link,
                               hours=worktime.hours, weekday_name=scheduling.WEEKDAY_NAMES)

    @app.route("/settings", methods=["GET", "POST"])
    def settings_page():
        conn = get_db()
        from flask import flash
        if request.method == "POST":
            values = {}
            errors = []
            store_name = request.form.get("store_name", "").strip()
            if not store_name:
                errors.append("门店名称不能为空")
            values["store_name"] = store_name
            # 系统标题：空值回落到默认，避免误清空品牌名
            values["app_title"] = (request.form.get("app_title") or "").strip()[:24] or "轻排班"
            for key in database.MINUTE_KEYS:
                raw = request.form.get(key, "").strip()
                if not re.match(r"^\d+$", raw) or int(raw) > 7 * 24 * 60:
                    errors.append("工时规则数值不合法")
                    break
                values[key] = str(int(raw))
            if errors:
                flash("保存失败：" + "；".join(errors), "error")
            else:
                database.save_settings(conn, values)
                flash("设置已保存。", "success")
            return redirect(url_for("settings_page"))
        settings = database.load_settings(conn)
        settings["brand_avatar"] = resolve_brand_avatar(settings)
        return render_template("settings.html", settings=settings)

    @app.route("/settings/avatar", methods=["POST"])
    def upload_avatar():
        """上传品牌头像：校验类型与大小后存入 static/uploads，并记录相对路径。"""
        from flask import flash
        conn = get_db()
        file = request.files.get("avatar")
        if file is None or not file.filename:
            flash("请选择图片文件（PNG / JPG / GIF / WebP）。", "error")
            return redirect(url_for("settings_page"))
        data = file.read()
        if len(data) > AVATAR_MAX_BYTES:
            flash("图片不能超过 2MB，请压缩后重试。", "error")
            return redirect(url_for("settings_page"))
        ext = _detect_image_ext(data)
        if ext is None:
            flash("不支持的图片格式，请使用 PNG / JPG / GIF / WebP。", "error")
            return redirect(url_for("settings_page"))
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        _remove_avatar_files()
        filename = f"avatar{ext}"
        (UPLOAD_DIR / filename).write_bytes(data)
        database.save_settings(conn, {"brand_avatar": f"uploads/{filename}"})
        flash("品牌头像已更新。", "success")
        return redirect(url_for("settings_page"))

    @app.route("/settings/avatar/remove", methods=["POST"])
    def remove_avatar():
        """移除品牌头像，恢复默认字标。"""
        from flask import flash
        conn = get_db()
        _remove_avatar_files()
        database.save_settings(conn, {"brand_avatar": ""})
        flash("已恢复默认字标。", "success")
        return redirect(url_for("settings_page"))

    def _remove_avatar_files():
        if UPLOAD_DIR.exists():
            for old in UPLOAD_DIR.glob("avatar.*"):
                old.unlink(missing_ok=True)

    @app.route("/brand-avatar")
    def brand_avatar_file():
        """品牌头像：读入内存后返回，请求结束即释放文件句柄，保证头像文件可随时安全替换/删除。"""
        rel = database.load_settings(get_db()).get("brand_avatar") or ""
        path = UPLOAD_DIR / Path(rel).name
        if not rel or not path.is_file():
            abort(404)
        mimetype = {".png": "image/png", ".jpg": "image/jpeg",
                    ".gif": "image/gif", ".webp": "image/webp"}.get(path.suffix, "application/octet-stream")
        resp = send_file(__import__("io").BytesIO(path.read_bytes()), mimetype=mimetype, max_age=300)
        return resp

    # ---------- 排班 JSON API ----------

    def _schedule_payload(data: dict) -> tuple[dict | None, list[str]]:
        errors = []
        employee_id = data.get("employee_id")
        work_date = parse_date(data.get("work_date"))
        start, end = (data.get("start_time") or "").strip(), (data.get("end_time") or "").strip()
        try:
            brk = int(data.get("break_minutes") or 0)
        except (TypeError, ValueError):
            brk = -1
        if not employee_id or not str(employee_id).isdigit():
            errors.append("请选择员工")
        if work_date is None:
            errors.append("日期格式应为 YYYY-MM-DD")
        if not TIME_RE.match(start):
            errors.append("开始时间格式应为 HH:MM")
        elif _invalid_clock(start):
            errors.append("开始时间数值越界")
        if not TIME_RE.match(end):
            errors.append("结束时间格式应为 HH:MM")
        elif _invalid_clock(end):
            errors.append("结束时间数值越界")
        span = None
        if not errors:
            try:
                span = scheduling.shift_span_minutes(start, end)
            except ValueError as exc:
                errors.append(str(exc))
        if not (0 <= brk <= 720):
            errors.append("休息时长应为 0–720 的整数分钟")
        elif span is not None and brk >= span:
            errors.append("休息时长必须小于班次总时长")
        if errors:
            return None, errors
        return {"employee_id": int(employee_id), "work_date": work_date,
                "start_time": start, "end_time": end, "break_minutes": brk,
                "position": (data.get("position") or "").strip(),
                "template_id": data.get("template_id") or None,
                "note": (data.get("note") or "").strip()}, []

    def _active_employee(conn, employee_id: int):
        employee = conn.execute(
            "SELECT * FROM employees WHERE id = ?", (employee_id,)).fetchone()
        if employee is None:
            return None, "员工不存在"
        if employee["status"] != "active":
            return None, "该员工已离职，不能排班"
        return employee, None

    def _conflicts_for(conn, payload: dict, schedule_id=None,
                       pending_rows=None) -> list[dict]:
        emp = conn.execute("SELECT * FROM employees WHERE id = ?",
                           (payload["employee_id"],)).fetchone()
        if emp is None:
            return []
        emp = dict(emp)
        w_start, w_end = scheduling.week_range(payload["work_date"])
        week_rows = fetch_schedules(conn, w_start - timedelta(days=2),
                                    w_end + timedelta(days=2))
        neighbors = [r for r in week_rows if r["employee_id"] == payload["employee_id"]]
        if pending_rows:
            neighbors.extend(row for row in pending_rows
                             if row["employee_id"] == payload["employee_id"])
        found = scheduling.check_conflicts(
            {**payload, "id": schedule_id},
            neighbors,
            {"employment_type": emp["employment_type"],
             "available_days": database.parse_available_days(emp["available_days"]),
             "available_from": emp["available_from"], "available_to": emp["available_to"]},
            database.load_settings(conn))
        return [c.as_dict() for c in found]

    @app.route("/api/schedules", methods=["POST"])
    def api_create_schedule():
        conn = get_db()
        payload, errors = _schedule_payload(request.get_json(silent=True) or {})
        if errors:
            return jsonify({"errors": errors}), 400
        emp, employee_error = _active_employee(conn, payload["employee_id"])
        if employee_error:
            return jsonify({"errors": [employee_error]}), 400
        if not payload["position"]:
            payload["position"] = emp["position"]
        conflicts = _conflicts_for(conn, payload)
        hard = [c for c in conflicts if c["severity"] == "error"]
        if hard and not request.args.get("force"):
            return jsonify({"conflicts": conflicts}), 409
        cur = conn.execute(
            """INSERT INTO schedules(employee_id, work_date, start_time, end_time,
               break_minutes, position, template_id, note) VALUES (?,?,?,?,?,?,?,?)""",
            (payload["employee_id"], payload["work_date"].isoformat(),
             payload["start_time"], payload["end_time"], payload["break_minutes"],
             payload["position"], payload["template_id"], payload["note"]))
        conn.commit()
        return jsonify({"id": cur.lastrowid, "conflicts": conflicts}), 201

    @app.route("/api/schedules/<int:schedule_id>", methods=["PUT", "DELETE"])
    def api_schedule_item(schedule_id: int):
        conn = get_db()
        row = conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
        if row is None:
            return jsonify({"errors": ["排班记录不存在"]}), 404
        if request.method == "DELETE":
            conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
            conn.commit()
            return jsonify({"ok": True})
        payload, errors = _schedule_payload(request.get_json(silent=True) or {})
        if errors:
            return jsonify({"errors": errors}), 400
        emp, employee_error = _active_employee(conn, payload["employee_id"])
        if employee_error:
            return jsonify({"errors": [employee_error]}), 400
        if not payload["position"]:
            payload["position"] = emp["position"]
        conflicts = _conflicts_for(conn, payload, schedule_id=schedule_id)
        hard = [c for c in conflicts if c["severity"] == "error"]
        if hard and not request.args.get("force"):
            return jsonify({"conflicts": conflicts}), 409
        conn.execute(
            """UPDATE schedules SET employee_id=?, work_date=?, start_time=?, end_time=?,
               break_minutes=?, position=?, template_id=?, note=? WHERE id=?""",
            (payload["employee_id"], payload["work_date"].isoformat(),
             payload["start_time"], payload["end_time"], payload["break_minutes"],
             payload["position"], payload["template_id"], payload["note"], schedule_id))
        conn.commit()
        return jsonify({"id": schedule_id, "conflicts": conflicts})

    @app.route("/api/schedules/copy-week", methods=["POST"])
    def api_copy_week():
        """将目标周的前一周排班复制过来；默认仅预检，confirm=true 时写入。"""
        conn = get_db()
        data = request.get_json(silent=True) or {}
        anchor = parse_date(data.get("target_date"))
        if anchor is None:
            return jsonify({"errors": ["目标日期格式应为 YYYY-MM-DD"]}), 400
        target_start, target_end = scheduling.week_range(anchor)
        source_start = target_start - timedelta(days=7)
        source_end = target_end - timedelta(days=7)
        source_rows = fetch_schedules(conn, source_start, source_end)
        active_ids = {row["id"] for row in load_employees(conn, active_only=True)}
        existing = fetch_schedules(conn, target_start, target_end)
        existing_keys = {
            (row["employee_id"], row["work_date"], row["start_time"], row["end_time"])
            for row in existing
        }

        candidates = []
        skipped_existing = 0
        skipped_inactive = 0
        conflict_details = []
        error_count = 0
        warning_count = 0
        for row in source_rows:
            if row["employee_id"] not in active_ids:
                skipped_inactive += 1
                continue
            target_date = row["work_date"] + timedelta(days=7)
            key = (row["employee_id"], target_date, row["start_time"], row["end_time"])
            if key in existing_keys:
                skipped_existing += 1
                continue
            payload = {
                "employee_id": row["employee_id"],
                "work_date": target_date,
                "start_time": row["start_time"],
                "end_time": row["end_time"],
                "break_minutes": row["break_minutes"],
                "position": row["position"],
                "template_id": row["template_id"],
                "note": row["note"],
            }
            conflicts = _conflicts_for(conn, payload, pending_rows=candidates)
            error_count += sum(c["severity"] == "error" for c in conflicts)
            warning_count += sum(c["severity"] == "warning" for c in conflicts)
            if conflicts:
                conflict_details.append({
                    "employee_name": row["employee_name"],
                    "date": target_date.isoformat(),
                    "time": f"{row['start_time']}–{row['end_time']}",
                    "conflicts": conflicts,
                })
            candidates.append(payload)
            existing_keys.add(key)

        result = {
            "source_start": source_start.isoformat(),
            "source_end": source_end.isoformat(),
            "target_start": target_start.isoformat(),
            "target_end": target_end.isoformat(),
            "copy_count": len(candidates),
            "skipped_existing": skipped_existing,
            "skipped_inactive": skipped_inactive,
            "error_count": error_count,
            "warning_count": warning_count,
            "conflict_details": conflict_details,
        }
        if not data.get("confirm"):
            return jsonify(result)
        for payload in candidates:
            conn.execute(
                """INSERT INTO schedules(employee_id, work_date, start_time, end_time,
                   break_minutes, position, template_id, note) VALUES (?,?,?,?,?,?,?,?)""",
                (payload["employee_id"], payload["work_date"].isoformat(),
                 payload["start_time"], payload["end_time"], payload["break_minutes"],
                 payload["position"], payload["template_id"], payload["note"]))
        conn.commit()
        result["created"] = len(candidates)
        return jsonify(result), 201

    @app.route("/api/conflicts")
    def api_conflicts():
        conn = get_db()
        settings = database.load_settings(conn)
        anchor = parse_date(request.args.get("date"), date.today())
        w_start, w_end = scheduling.week_range(anchor)
        return jsonify({"conflicts": week_conflicts(conn, w_start, w_end, settings)})

    # ---------- 导出与备份 ----------

    def _xlsx_response(data: bytes, filename: str) -> Response:
        quoted = urllib.parse.quote(filename)
        return Response(
            data,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"})

    @app.route("/export/schedule")
    def export_schedule():
        conn = get_db()
        settings = database.load_settings(conn)
        anchor = parse_date(request.args.get("date"), date.today())
        w_start, w_end = scheduling.week_range(anchor)
        rows = fetch_schedules(conn, w_start, w_end)
        conflicts = week_conflicts(conn, w_start, w_end, settings)
        conflict_count: dict[int, int] = {}
        for c in conflicts:
            conflict_count[c["schedule_id"]] = conflict_count.get(c["schedule_id"], 0) + 1
        export_rows = []
        for row in rows:
            eff = scheduling.effective_minutes(
                row["start_time"], row["end_time"], row["break_minutes"])
            note_parts = []
            if row.get("note"):
                note_parts.append(row["note"])
            if row["id"] in conflict_count:
                note_parts.append(f"冲突提示 {conflict_count[row['id']]} 条")
            export_rows.append({
                "work_date": row["work_date"],
                "weekday": scheduling.WEEKDAY_NAMES[row["work_date"].isoweekday()],
                "employee_name": row["employee_name"],
                "position": row["position"],
                "start_time": row["start_time"], "end_time": row["end_time"],
                "break_minutes": row["break_minutes"],
                "effective_hours": eff / 60,
                "note": "；".join(note_parts),
            })
        data = exporter.export_schedule(export_rows, settings["store_name"], w_start, w_end)
        return _xlsx_response(data, f"{settings['store_name']}_排班表_{w_start.isoformat()}.xlsx")

    @app.route("/export/hours")
    def export_hours():
        conn = get_db()
        settings = database.load_settings(conn)
        period, anchor = period_from_args(request.args)
        if period == "month":
            start, end = scheduling.month_range(anchor.year, anchor.month)
            label = f"{anchor.year}年{anchor.month}月"
        elif period == "day":
            start = end = anchor
            label = start.isoformat()
        else:
            start, end = scheduling.week_range(anchor)
            label = f"{start.isoformat()}至{end.isoformat()}"
        rows = fetch_schedules(conn, start, end)
        summary = worktime.summarize(rows, start, end)
        day_columns = None
        if period == "week":
            day_columns = [((start + timedelta(days=i)).isoformat(),
                            scheduling.WEEKDAY_NAMES[i + 1]) for i in range(7)]
        data = exporter.export_hours(settings["store_name"], label, summary, day_columns)
        return _xlsx_response(data, f"{settings['store_name']}_工时统计_{label}.xlsx")

    @app.route("/backup")
    def backup():
        path = app.config["DB_PATH"]
        with open(path, "rb") as f:
            data = f.read()
        filename = f"shiftlite-backup-{date.today().isoformat()}.db"
        return send_file(__import__("io").BytesIO(data), as_attachment=True,
                         download_name=filename, mimetype="application/octet-stream")

    @app.route("/api/reset-demo", methods=["POST"])
    def reset_demo():
        import seed
        seed.force_seed(app.config["DB_PATH"])
        return jsonify({"ok": True})

    return app


def _employee_form(form) -> tuple:
    days = form.getlist("available_days") or []
    day_values = []
    for d in days:
        try:
            if 1 <= int(d) <= 7:
                day_values.append(int(d))
        except (TypeError, ValueError):
            continue
    day_values = sorted(set(day_values))
    return (
        form.get("name", "").strip(),
        form.get("position", "").strip(),
        form.get("employment_type", "fulltime"),
        form.get("phone", "").strip(),
        json_dumps(day_values),
        form.get("available_from", "").strip(),
        form.get("available_to", "").strip(),
        form.get("status", "active"),
        form.get("note", "").strip(),
    )


def json_dumps(value) -> str:
    import json
    return json.dumps(value, ensure_ascii=False)


def _validate_employee(form: tuple) -> list[str]:
    name, _pos, emp_type, _phone, _days, a_from, a_to, status, _note = form
    errors = []
    if not name:
        errors.append("请填写姓名")
    if emp_type not in ("fulltime", "parttime"):
        errors.append("用工类型不合法")
    if status not in ("active", "inactive"):
        errors.append("在职状态不合法")
    valid_clocks = True
    for label, value in (("可用开始时间", a_from), ("可用结束时间", a_to)):
        if value and (not TIME_RE.match(value) or _invalid_clock(value)):
            errors.append(f"{label}应为有效的 HH:MM 时间")
            valid_clocks = False
    if a_from and a_to and valid_clocks:
        if scheduling.parse_hhmm(a_from) >= scheduling.parse_hhmm(a_to):
            errors.append("每日可用时间段的开始需早于结束")
    return errors


app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)
