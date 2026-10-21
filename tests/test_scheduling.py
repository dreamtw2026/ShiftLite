"""时间区间与冲突检测单元测试。"""
from __future__ import annotations

from datetime import date

import pytest

from core import scheduling

SETTINGS = {
    "rest_minutes_min": 600,
    "daily_max_minutes_fulltime": 600,
    "daily_max_minutes_parttime": 480,
    "weekly_max_minutes_fulltime": 2640,
    "weekly_max_minutes_parttime": 1440,
}

FULLTIME_ANYTIME = {
    "employment_type": "fulltime",
    "available_days": {1, 2, 3, 4, 5, 6, 7},
    "available_from": "", "available_to": "",
}


def cand(d="2026-03-10", start="09:00", end="17:00", brk=0, cid=None):
    return {"id": cid, "work_date": date.fromisoformat(d),
            "start_time": start, "end_time": end, "break_minutes": brk}


def ex(d, start, end, brk=0, rid=100):
    return {"id": rid, "work_date": date.fromisoformat(d),
            "start_time": start, "end_time": end, "break_minutes": brk}


def rules(found):
    return [c.rule for c in found]


# ---------- 时间计算 ----------

def test_span_same_day():
    assert scheduling.shift_span_minutes("09:00", "17:00") == 480


def test_span_cross_midnight():
    assert scheduling.shift_span_minutes("19:00", "01:00") == 360


def test_span_equal_invalid():
    with pytest.raises(ValueError):
        scheduling.shift_span_minutes("09:00", "09:00")


def test_effective_minutes_with_break():
    assert scheduling.effective_minutes("09:00", "17:00", 30) == 450


def test_effective_minutes_cross_midnight_with_break():
    assert scheduling.effective_minutes("19:00", "01:00", 60) == 300


def test_break_not_negative():
    with pytest.raises(ValueError):
        scheduling.effective_minutes("09:00", "17:00", -10)


def test_invalid_time_format():
    with pytest.raises(ValueError):
        scheduling.shift_span_minutes("25:00", "17:00")
    with pytest.raises(ValueError):
        scheduling.shift_span_minutes("9:00", "17:00")   # 非两位小时
    with pytest.raises(ValueError):
        scheduling.shift_span_minutes("09:00", "0900")


def test_week_range():
    monday, sunday = scheduling.week_range(date(2026, 10, 15))
    assert (monday, sunday) == (date(2026, 10, 12), date(2026, 10, 18))


def test_month_range():
    assert scheduling.month_range(2026, 2) == (date(2026, 2, 1), date(2026, 2, 28))
    assert scheduling.month_range(2024, 2) == (date(2024, 2, 1), date(2024, 2, 29))
    assert scheduling.month_range(2026, 12) == (date(2026, 12, 1), date(2026, 12, 31))


def test_shift_datetime_range_cross_midnight():
    s, e = scheduling.shift_datetime_range(date(2026, 3, 10), "19:00", "01:00")
    assert (s.year, s.month, s.day, s.hour) == (2026, 3, 10, 19)
    assert (e.year, e.month, e.day, e.hour) == (2026, 3, 11, 1)


# ---------- 冲突检测 ----------

def test_no_conflict_clean():
    found = scheduling.check_conflicts(cand(), [ex("2026-03-09", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert found == []


def test_overlap_full():
    # 重叠班次的工时按记录重复计入当日汇总，因此同时触发每日上限提示（见报告“已知简化”）
    found = scheduling.check_conflicts(cand(), [ex("2026-03-10", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert "overlap" in rules(found)
    assert [c.severity for c in found if c.rule == "overlap"] == ["error"]


def test_overlap_partial_minutes_in_message():
    found = scheduling.check_conflicts(cand(start="15:00", end="20:00"),
                                       [ex("2026-03-10", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert "overlap" in rules(found)
    assert "120 分钟" in [c for c in found if c.rule == "overlap"][0].message


def test_touching_shifts_not_overlap():
    found = scheduling.check_conflicts(cand(start="17:00", end="21:00"),
                                       [ex("2026-03-10", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    # 首尾相接不重叠，但间隔 0 触发休息不足提示；当日合计 12 小时同时触发每日上限
    assert rules(found) == ["rest", "daily_limit"]
    assert [c for c in found if c.rule == "rest"][0].severity == "warning"


def test_cross_midnight_overlap_with_next_morning():
    found = scheduling.check_conflicts(cand(start="19:00", end="01:00"),
                                       [ex("2026-03-11", "00:30", "04:30")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert rules(found) == ["overlap"]


def test_cross_midnight_rest_gap():
    # 跨日班次次日 01:00 结束，同员工次日 07:00 早班：休息 6 小时 → 提示
    found = scheduling.check_conflicts(cand(start="19:00", end="01:00"),
                                       [ex("2026-03-11", "07:00", "15:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert rules(found) == ["rest"]


def test_rest_gap_sufficient_no_conflict():
    found = scheduling.check_conflicts(cand(start="19:00", end="23:00"),
                                       [ex("2026-03-11", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert found == []


def test_exclude_self_when_editing():
    found = scheduling.check_conflicts(cand(cid=7), [ex("2026-03-10", "09:00", "17:00", rid=7)],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert found == []


def test_availability_weekday():
    emp = {**FULLTIME_ANYTIME, "available_days": {1, 2, 3, 4, 5}}
    found = scheduling.check_conflicts(cand(d="2026-03-14"), [], emp, SETTINGS)  # 周六
    assert rules(found) == ["availability"]
    assert found[0].severity == "error"
    assert "周六" in found[0].message


def test_availability_time_window():
    emp = {**FULLTIME_ANYTIME, "available_from": "09:00", "available_to": "18:00"}
    found = scheduling.check_conflicts(cand(start="17:00", end="21:00"), [], emp, SETTINGS)
    assert rules(found) == ["availability"]
    # 跨日班次必然超出当日窗口
    found2 = scheduling.check_conflicts(cand(start="19:00", end="01:00"), [], emp, SETTINGS)
    assert rules(found2) == ["availability"]


def test_availability_window_ok():
    emp = {**FULLTIME_ANYTIME, "available_from": "09:00", "available_to": "18:00"}
    found = scheduling.check_conflicts(cand(start="09:00", end="17:00"), [], emp, SETTINGS)
    assert found == []


def test_daily_limit_fulltime():
    # 已有 09:00–17:00（480 分钟），再加 17:00–21:00（240 分钟）→ 720 > 600
    found = scheduling.check_conflicts(cand(start="17:00", end="21:00"),
                                       [ex("2026-03-10", "09:00", "17:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert "daily_limit" in rules(found)
    daily = [c for c in found if c.rule == "daily_limit"][0]
    assert daily.severity == "warning"
    assert "12 小时" in daily.message


def test_daily_limit_parttime_uses_own_limit():
    emp = {"employment_type": "parttime", "available_days": {1, 2, 3, 4, 5, 6, 7},
           "available_from": "", "available_to": ""}
    found = scheduling.check_conflicts(cand(start="09:00", end="21:00"), [], emp, SETTINGS)
    assert "daily_limit" in rules(found)
    assert "兼职" in found[0].message


def test_weekly_limit():
    # 周内已排 4 天 × 8 小时 = 1920 分钟，再加 8 小时 → 2400 > 1440（兼职口径示例）
    existing = [ex(f"2026-03-{d:02d}", "09:00", "17:00") for d in (9, 10, 11, 12)]
    emp = {"employment_type": "parttime", "available_days": {1, 2, 3, 4, 5, 6, 7},
           "available_from": "", "available_to": ""}
    found = scheduling.check_conflicts(cand(d="2026-03-13"), existing, emp, SETTINGS)
    assert "weekly_limit" in rules(found)
    weekly = [c for c in found if c.rule == "weekly_limit"][0]
    assert "40 小时" in weekly.message


def test_weekly_limit_counts_by_start_date():
    # 周日 21:00 跨日至周一 01:00（240 分钟）计入开始日期所在周
    emp = {"employment_type": "parttime", "available_days": {1, 2, 3, 4, 5, 6, 7},
           "available_from": "", "available_to": ""}
    existing = [ex("2026-03-09", "09:00", "17:00"), ex("2026-03-10", "09:00", "17:00"),
                ex("2026-03-11", "09:00", "17:00"), ex("2026-03-12", "09:00", "17:00"),
                ex("2026-03-13", "09:00", "17:00")]  # 5 × 480 = 2400 分钟
    found = scheduling.check_conflicts(cand(d="2026-03-15", start="21:00", end="01:00"),
                                       existing, emp, SETTINGS)
    weekly = [c for c in found if c.rule == "weekly_limit"][0]
    assert "44 小时" in weekly.message  # 2400 + 240 = 2640 分钟 = 44 小时


def test_severity_error_blocks_warning_does_not():
    found = scheduling.check_conflicts(cand(), [ex("2026-03-10", "10:00", "12:00")],
                                       FULLTIME_ANYTIME, SETTINGS)
    assert all(c.severity == "error" for c in found if c.rule == "overlap")
