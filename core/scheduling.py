"""排班核心逻辑：时间区间计算与冲突检测。

本模块为纯函数实现，不依赖 Flask 与数据库连接，便于单元测试。
约定：
- 时间均为 "HH:MM" 文本；结束时间早于或等于开始时间表示班次跨日（次日结束）。
- 排班记录按“开始日期”归属统计周期（日 / 周 / 月）。
- 冲突分为 error（硬冲突，保存时需二次确认）与 warning（提示，可直接保存）。
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date as Date
from datetime import datetime, time as Time, timedelta

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"]
TYPE_LABELS = {"fulltime": "全职", "parttime": "兼职"}

RULE_LABELS = {
    "overlap": "班次重叠",
    "availability": "可用时间冲突",
    "rest": "班间休息不足",
    "daily_limit": "超出每日工时上限",
    "weekly_limit": "超出每周工时上限",
}


@dataclass
class Conflict:
    rule: str            # overlap / availability / rest / daily_limit / weekly_limit
    severity: str        # error / warning
    message: str
    related_schedule_id: int | None = None

    def as_dict(self) -> dict:
        data = asdict(self)
        data["rule_label"] = RULE_LABELS.get(self.rule, self.rule)
        return data


def parse_hhmm(value: str) -> Time:
    """解析严格两位的 HH:MM 文本（如 09:30），非法格式或数值越界抛出 ValueError。"""
    text = str(value).strip()
    if len(text) != 5 or text[2] != ":" or not text[:2].isdigit() or not text[3:].isdigit():
        raise ValueError(f"时间格式应为 HH:MM：{value!r}")
    hour, minute = int(text[:2]), int(text[3:])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"时间数值越界：{value!r}")
    return Time(hour, minute)


def shift_span_minutes(start_hhmm: str, end_hhmm: str) -> int:
    """班次跨度（分钟），跨日自动加 24 小时；起止相同视为非法。"""
    start, end = parse_hhmm(start_hhmm), parse_hhmm(end_hhmm)
    if start == end:
        raise ValueError("班次开始与结束时间相同")
    span = end.hour * 60 + end.minute - (start.hour * 60 + start.minute)
    if span < 0:
        span += 24 * 60
    return span


def effective_minutes(start_hhmm: str, end_hhmm: str, break_minutes: int) -> int:
    """有效工时（分钟）= 跨度 − 休息时长，下限 0。"""
    brk = int(break_minutes or 0)
    if brk < 0:
        raise ValueError("休息时长不能为负数")
    return max(0, shift_span_minutes(start_hhmm, end_hhmm) - brk)


def shift_datetime_range(work_date: Date, start_hhmm: str, end_hhmm: str):
    """把“日期 + 起止时间”展开为绝对时间区间，跨日班次结束时间落到次日。"""
    start = datetime.combine(work_date, parse_hhmm(start_hhmm))
    end = datetime.combine(work_date, parse_hhmm(end_hhmm))
    if end <= start:
        end += timedelta(days=1)
    return start, end


def overlap_minutes(a_start: datetime, a_end: datetime,
                    b_start: datetime, b_end: datetime) -> int:
    """两个时间区间的重叠分钟数，无重叠返回 0。"""
    minutes = (min(a_end, b_end) - max(a_start, b_start)).total_seconds() / 60
    return max(0, int(minutes))


def week_range(d: Date) -> tuple[Date, Date]:
    """返回 d 所在周的周一与周日。"""
    monday = d - timedelta(days=d.isoweekday() - 1)
    return monday, monday + timedelta(days=6)


def month_range(year: int, month: int) -> tuple[Date, Date]:
    """返回某自然月的第一天与最后一天。"""
    first = Date(year, month, 1)
    if month == 12:
        last = Date(year, 12, 31)
    else:
        last = Date(year, month + 1, 1) - timedelta(days=1)
    return first, last


def _fmt_hours(minutes: int) -> str:
    """把分钟数格式化为可读的小时文本，如 7.5 小时。"""
    hours = minutes / 60
    text = f"{hours:.1f}".rstrip("0").rstrip(".")
    return f"{text} 小时"


def check_conflicts(candidate: dict, existing: list[dict],
                    employee: dict, settings: dict) -> list[Conflict]:
    """检测一条候选排班与该员工其他排班之间的冲突。

    参数
    ----
    candidate : 候选排班，含 work_date(Date)、start_time、end_time、break_minutes，
                可含 id（编辑时排除自身）。
    existing  : 同一员工的其他排班（调用方负责圈定候选日期 ±1 天范围），
                每条含 id、work_date、start_time、end_time、break_minutes。
    employee  : 含 employment_type、available_days(set[int])、available_from、available_to。
    settings  : 含 rest_minutes_min、daily/weekly_max_minutes_{fulltime,parttime}。
    """
    conflicts: list[Conflict] = []
    c_date: Date = candidate["work_date"]
    c_start, c_end = shift_datetime_range(
        c_date, candidate["start_time"], candidate["end_time"])
    c_eff = effective_minutes(
        candidate["start_time"], candidate["end_time"], candidate["break_minutes"])

    spans: list[tuple[datetime, datetime, dict]] = []
    for row in existing:
        if candidate.get("id") is not None and row.get("id") == candidate["id"]:
            continue  # 编辑时排除自身
        s, e = shift_datetime_range(row["work_date"], row["start_time"], row["end_time"])
        spans.append((s, e, row))

    # 规则一：班次时间重叠（硬冲突）
    for s, e, row in spans:
        ov = overlap_minutes(c_start, c_end, s, e)
        if ov > 0:
            conflicts.append(Conflict(
                "overlap", SEVERITY_ERROR,
                f"与已有班次（{row['work_date'].strftime('%m月%d日')} "
                f"{row['start_time']}–{row['end_time']}）重叠 {ov} 分钟",
                row.get("id")))

    # 规则二：不在可排班日 / 超出每日可用时间段（硬冲突）
    weekday = c_date.isoweekday()
    days: set[int] = employee.get("available_days") or set()
    if days and weekday not in days:
        allowed = "、".join(WEEKDAY_NAMES[d] for d in sorted(days))
        conflicts.append(Conflict(
            "availability", SEVERITY_ERROR,
            f"{c_date.strftime('%m月%d日')}为{WEEKDAY_NAMES[weekday]}，"
            f"不在该员工的可排班日（{allowed}）"))
    a_from, a_to = employee.get("available_from") or "", employee.get("available_to") or ""
    if a_from and a_to:
        win_start = datetime.combine(c_date, parse_hhmm(a_from))
        win_end = datetime.combine(c_date, parse_hhmm(a_to))
        if c_start < win_start or c_end > win_end:
            conflicts.append(Conflict(
                "availability", SEVERITY_ERROR,
                f"班次 {candidate['start_time']}–{candidate['end_time']} "
                f"超出其每日可用时间段（{a_from}–{a_to}）"))

    # 规则三：与前后班次的休息间隔低于配置值（提示）
    rest = int(settings.get("rest_minutes_min") or 0)
    if rest > 0:
        for s, e, row in spans:
            if overlap_minutes(c_start, c_end, s, e) > 0:
                continue  # 重叠已由规则一报告
            if e <= c_start:                       # 前一班
                gap = int((c_start - e).total_seconds() // 60)
                if gap < rest:
                    conflicts.append(Conflict(
                        "rest", SEVERITY_WARNING,
                        f"与前一班次（{row['work_date'].strftime('%m月%d日')} "
                        f"{row['start_time']}–{row['end_time']}）之间仅休息 "
                        f"{gap // 60} 小时 {gap % 60} 分钟，"
                        f"低于设置的最小间隔 {rest // 60} 小时",
                        row.get("id")))
            elif s >= c_end:                       # 后一班
                gap = int((s - c_end).total_seconds() // 60)
                if gap < rest:
                    conflicts.append(Conflict(
                        "rest", SEVERITY_WARNING,
                        f"与后一班次（{row['work_date'].strftime('%m月%d日')} "
                        f"{row['start_time']}–{row['end_time']}）之间仅休息 "
                        f"{gap // 60} 小时 {gap % 60} 分钟，"
                        f"低于设置的最小间隔 {rest // 60} 小时",
                        row.get("id")))

    # 规则四：每日有效工时上限（提示）
    emp_type = employee.get("employment_type") or "fulltime"
    type_label = TYPE_LABELS.get(emp_type, "全职")
    same_day = [row for row in existing
                if row["work_date"] == c_date
                and (candidate.get("id") is None or row.get("id") != candidate["id"])]
    day_total = c_eff + sum(
        effective_minutes(r["start_time"], r["end_time"], r["break_minutes"])
        for r in same_day)
    daily_limit = int(settings.get(
        "daily_max_minutes_fulltime" if emp_type == "fulltime"
        else "daily_max_minutes_parttime") or 0)
    if daily_limit > 0 and day_total > daily_limit:
        conflicts.append(Conflict(
            "daily_limit", SEVERITY_WARNING,
            f"当日有效工时合计 {_fmt_hours(day_total)}，"
            f"超过{type_label}每日上限 {_fmt_hours(daily_limit)}"))

    # 规则五：每周（周一至周日）有效工时上限，按班次开始日期归属（提示）
    w_start, w_end = week_range(c_date)
    week_rows = [row for row in existing
                 if w_start <= row["work_date"] <= w_end
                 and (candidate.get("id") is None or row.get("id") != candidate["id"])]
    week_total = c_eff + sum(
        effective_minutes(r["start_time"], r["end_time"], r["break_minutes"])
        for r in week_rows)
    weekly_limit = int(settings.get(
        "weekly_max_minutes_fulltime" if emp_type == "fulltime"
        else "weekly_max_minutes_parttime") or 0)
    if weekly_limit > 0 and week_total > weekly_limit:
        conflicts.append(Conflict(
            "weekly_limit", SEVERITY_WARNING,
            f"本周（{w_start.strftime('%m月%d日')}–{w_end.strftime('%m月%d日')}）"
            f"有效工时合计 {_fmt_hours(week_total)}，"
            f"超过{type_label}每周上限 {_fmt_hours(weekly_limit)}"))

    return conflicts
