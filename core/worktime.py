"""工时统计：由排班记录按统计周期（日/周/月）汇总工时。

单一数据源原则：工时不落库，由排班记录实时推导，保证排班与统计口径一致。
跨日班次整体归属开始日期所在周期。
"""
from __future__ import annotations

from datetime import date as Date

from core.scheduling import effective_minutes, shift_span_minutes

TYPE_LABELS = {"fulltime": "全职", "parttime": "兼职"}


def summarize(rows: list[dict], start: Date, end: Date) -> list[dict]:
    """按员工汇总 [start, end] 区间内的工时。

    rows 中每条记录需含：employee_id、employee_name、position、employment_type、
    work_date(Date)、start_time、end_time、break_minutes。
    返回按姓名排序的汇总列表，含逐日明细 by_date（ISO 日期字符串 → 有效分钟）。
    """
    out: dict[int, dict] = {}
    for row in rows:
        d: Date = row["work_date"]
        if not (start <= d <= end):
            continue
        span = shift_span_minutes(row["start_time"], row["end_time"])
        brk = int(row["break_minutes"] or 0)
        eff = max(0, span - brk)
        item = out.setdefault(row["employee_id"], {
            "employee_id": row["employee_id"],
            "name": row["employee_name"],
            "position": row["position"] or "",
            "employment_type": row["employment_type"],
            "type_label": TYPE_LABELS.get(row["employment_type"], "全职"),
            "shifts": 0,
            "scheduled_minutes": 0,   # 含休息的排班时长
            "break_minutes": 0,
            "effective_minutes": 0,
            "by_date": {},            # 日期字符串 -> 当日有效工时（分钟）
        })
        item["shifts"] += 1
        item["scheduled_minutes"] += span
        item["break_minutes"] += brk
        item["effective_minutes"] += eff
        key = d.isoformat()
        item["by_date"][key] = item["by_date"].get(key, 0) + eff
    return sorted(out.values(), key=lambda x: x["name"])


def hours(minutes: float) -> float:
    """分钟转小时（保留一位小数）。"""
    return round(minutes / 60, 1)
