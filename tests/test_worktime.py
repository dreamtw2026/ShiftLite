"""工时统计汇总单元测试。"""
from __future__ import annotations

from datetime import date

from core import worktime


def row(emp=1, name="张三", d="2026-03-10", start="09:00", end="17:00", brk=30,
        etype="fulltime", pos="前厅"):
    return {"employee_id": emp, "employee_name": name, "position": pos,
            "employment_type": etype, "work_date": date.fromisoformat(d),
            "start_time": start, "end_time": end, "break_minutes": brk}


def test_single_shift_summary():
    result = worktime.summarize([row()], date(2026, 3, 10), date(2026, 3, 10))
    assert len(result) == 1
    item = result[0]
    assert item["name"] == "张三"
    assert item["shifts"] == 1
    assert item["scheduled_minutes"] == 480
    assert item["break_minutes"] == 30
    assert item["effective_minutes"] == 450
    assert item["by_date"] == {"2026-03-10": 450}


def test_cross_midnight_counts_by_start_date():
    # 3 月 10 日 21:00 至次日 01:00（240 分钟）计入 3 月 10 日
    result = worktime.summarize([row(d="2026-03-10", start="21:00", end="01:00", brk=0)],
                                date(2026, 3, 1), date(2026, 3, 31))
    assert result[0]["by_date"] == {"2026-03-10": 240}
    assert result[0]["effective_minutes"] == 240


def test_period_boundary_excluded():
    rows = [row(d="2026-03-09"), row(d="2026-03-16")]
    result = worktime.summarize(rows, date(2026, 3, 10), date(2026, 3, 15))
    assert result == []


def test_week_boundary_sunday_overnight():
    # 2026-03-15 是周日：跨日班次计入周日所在周（3/9–3/15），而非下一周
    rows = [row(d="2026-03-15", start="21:00", end="01:00", brk=0)]
    in_week = worktime.summarize(rows, date(2026, 3, 9), date(2026, 3, 15))
    next_week = worktime.summarize(rows, date(2026, 3, 16), date(2026, 3, 22))
    assert len(in_week) == 1
    assert next_week == []


def test_multiple_employees_sorted_and_grouped():
    rows = [row(emp=2, name="李四", d="2026-03-10"),
            row(emp=1, name="张三", d="2026-03-10"),
            row(emp=1, name="张三", d="2026-03-11", start="11:00", end="19:00")]
    result = worktime.summarize(rows, date(2026, 3, 9), date(2026, 3, 15))
    assert [r["name"] for r in result] == ["张三", "李四"]
    zhang = result[0]
    assert zhang["shifts"] == 2
    assert zhang["effective_minutes"] == 450 + 450
    assert zhang["by_date"] == {"2026-03-10": 450, "2026-03-11": 450}


def test_hours_conversion():
    assert worktime.hours(450) == 7.5
    assert worktime.hours(0) == 0.0
    assert worktime.hours(60) == 1.0
