"""演示数据脚本：初始化示例门店“青禾轻食·大学城店”的员工、班次模板与两周排班。

用法：
    python seed.py           # 数据库为空时写入演示数据（已存在数据则跳过）
    python seed.py --force   # 清空业务数据后重新写入演示数据

演示数据在当前周刻意安排了三类冲突，用于展示冲突检测能力：
  1. 周六 周杰 早班与中班时间重叠（错误级）；
  2. 周日 赵磊 排班但周日不在其可排班日（错误级）；
  3. 多名员工触达每日/每周工时上限或班间休息不足（提示级）。
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db as database  # noqa: E402

# 员工：(姓名, 岗位, 类型, 电话, 可排班日(ISO星期), 可用开始, 可用结束, 备注)
EMPLOYEES = [
    ("陈静", "前厅", "fulltime", "13800000001", [1, 2, 3, 4, 5, 6], "07:00", "22:00", "店长，负责排班审核"),
    ("李慧", "后厨", "fulltime", "13800000002", [1, 2, 3, 4, 5], "06:30", "20:00", ""),
    ("王强", "后厨", "fulltime", "13800000003", [1, 2, 3, 4, 5, 6], "06:00", "23:30", ""),
    ("赵磊", "收银", "fulltime", "13800000004", [1, 2, 3, 4, 5], "09:00", "21:00", ""),
    ("孙娜", "外卖打包", "fulltime", "13800000005", [2, 3, 4, 5, 6], "09:00", "20:00", ""),
    ("周杰", "前厅", "parttime", "13800000006", [1, 2, 3, 4, 5, 6, 7], "", "", "大学生兼职，时段灵活"),
    ("吴敏", "收银", "parttime", "13800000007", [1, 2, 3, 4, 5, 6, 7], "", "", ""),
    ("郑浩", "后厨", "parttime", "13800000008", [5, 6, 7], "08:00", "23:00", "周末兼职"),
    ("冯婷", "前厅", "parttime", "13800000009", [1, 2, 3, 4, 5], "07:00", "19:00", ""),
    ("许阳", "外卖打包", "parttime", "13800000010", [1, 2, 6, 7], "06:30", "21:30", ""),
]

# 班次模板：(名称, 开始, 结束, 休息分钟, 建议岗位, 配色)
TEMPLATES = [
    ("早班", "07:00", "15:00", 30, "", "primary"),
    ("中班", "11:00", "19:00", 30, "", "secondary"),
    ("晚班", "15:00", "23:00", 30, "", "tertiary"),
    ("打烊班", "19:00", "01:00", 0, "", "warning"),
]

# 本周排班：星期(1=周一) -> {模板简称: [员工姓名]}；m=早班 t=中班 e=晚班 n=打烊班
WEEK_PLAN = {
    1: {"m": ["李慧", "冯婷"], "t": ["陈静", "赵磊"], "e": ["王强", "吴敏"], "n": ["周杰"]},
    2: {"m": ["李慧", "许阳"], "t": ["陈静", "孙娜"], "e": ["王强", "吴敏"], "n": ["周杰"]},
    3: {"m": ["李慧", "冯婷"], "t": ["周杰", "孙娜"], "e": ["王强", "吴敏"], "n": ["周杰"]},
    4: {"m": ["李慧", "冯婷"], "t": ["陈静", "赵磊"], "e": ["王强", "吴敏"], "n": ["周杰"]},
    5: {"m": ["李慧", "冯婷"], "t": ["陈静", "孙娜"], "e": ["王强", "周杰"], "n": ["吴敏"]},
    6: {"m": ["许阳", "周杰"], "t": ["陈静", "孙娜", "周杰"], "e": ["王强"], "n": ["吴敏"]},
    7: {"m": ["许阳"], "t": ["赵磊", "郑浩"], "e": ["周杰"], "n": ["吴敏"]},
}

# 下周排班（前三天，模拟“下周班表已初步编制”状态）
NEXT_WEEK_PLAN = {
    1: {"m": ["李慧", "冯婷"], "t": ["陈静", "赵磊"], "e": ["王强", "吴敏"], "n": ["周杰"]},
    2: {"m": ["李慧", "许阳"], "t": ["陈静", "孙娜"], "e": ["王强", "吴敏"]},
    3: {"m": ["李慧", "冯婷"], "t": ["陈静", "孙娜"], "e": ["王强", "吴敏"]},
}

KEY_TO_TEMPLATE = {"m": "早班", "t": "中班", "e": "晚班", "n": "打烊班"}


def force_seed(db_path=None) -> None:
    path = database.init_db(db_path)
    conn = database.get_connection(path)
    try:
        conn.execute("DELETE FROM schedules")
        conn.execute("DELETE FROM shift_templates")
        conn.execute("DELETE FROM employees")
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN "
                     "('schedules', 'shift_templates', 'employees')")
        conn.commit()

        emp_ids: dict[str, int] = {}
        emp_pos: dict[str, str] = {}
        for name, position, etype, phone, days, a_from, a_to, note in EMPLOYEES:
            cur = conn.execute(
                """INSERT INTO employees(name, position, employment_type, phone,
                   available_days, available_from, available_to, status, note)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)""",
                (name, position, etype, phone, json.dumps(days), a_from, a_to, note))
            emp_ids[name] = cur.lastrowid
            emp_pos[name] = position

        tpl_ids: dict[str, int] = {}
        tpl_by_name: dict[str, tuple] = {}
        for name, start, end, brk, position, color in TEMPLATES:
            cur = conn.execute(
                """INSERT INTO shift_templates(name, start_time, end_time,
                   break_minutes, position, color, note) VALUES (?, ?, ?, ?, ?, ?, '')""",
                (name, start, end, brk, position, color))
            tpl_ids[name] = cur.lastrowid
            tpl_by_name[name] = (start, end, brk)

        today = date.today()
        monday = today - timedelta(days=today.isoweekday() - 1)

        def write_week(plan: dict, week_monday: date) -> int:
            count = 0
            for weekday, slots in plan.items():
                work_date = week_monday + timedelta(days=weekday - 1)
                for key, names in slots.items():
                    tpl_name = KEY_TO_TEMPLATE[key]
                    start, end, brk = tpl_by_name[tpl_name]
                    for emp_name in names:
                        conn.execute(
                            """INSERT INTO schedules(employee_id, work_date, start_time,
                               end_time, break_minutes, position, template_id, note)
                               VALUES (?, ?, ?, ?, ?, ?, ?, '')""",
                            (emp_ids[emp_name], work_date.isoformat(),
                             start, end, brk, emp_pos[emp_name], tpl_ids[tpl_name]))
                        count += 1
            conn.commit()
            return count

        total = write_week(WEEK_PLAN, monday)
        total += write_week(NEXT_WEEK_PLAN, monday + timedelta(days=7))
        print(f"演示数据已写入：{len(EMPLOYEES)} 名员工，{len(TEMPLATES)} 个班次模板，"
              f"{total} 条排班（数据库：{path}）")
    finally:
        conn.close()


def seed_if_empty(db_path=None) -> bool:
    path = database.init_db(db_path)
    conn = database.get_connection(path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM employees").fetchone()[0]
        if count:
            return False
    finally:
        conn.close()
    force_seed(path)
    return True


if __name__ == "__main__":
    if "--force" in sys.argv:
        force_seed()
    else:
        if seed_if_empty():
            pass
        else:
            print("数据库已有数据，未写入演示数据；如需重置请使用：python seed.py --force")
