"""生成 Python↔JS 业务核心对齐测试的 fixture。

用法：python scripts/gen_parity_fixture.py
输出：cloudflare/test/fixture.json（含冲突检测与工时汇总的输入及 Python 版预期输出）

fixture 覆盖：五类冲突规则、跨日班次、可用时间窗口、日/周上限、
周界（周日跨夜班次归属）、fmtHours 舍入平局（minutes ≡ 15 mod 60）等场景。
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import scheduling, worktime  # noqa: E402

SETTINGS = {
    "rest_minutes_min": 600,
    "daily_max_minutes_fulltime": 600,
    "daily_max_minutes_parttime": 480,
    "weekly_max_minutes_fulltime": 2640,
    "weekly_max_minutes_parttime": 1440,
}


def ex(d, start, end, brk=0, rid=100):
    return {"id": rid, "work_date": d, "start_time": start, "end_time": end, "break_minutes": brk}


def cand(d="2026-03-10", start="09:00", end="17:00", brk=0, cid=None):
    return {"id": cid, "work_date": d, "start_time": start, "end_time": end, "break_minutes": brk}


ANYTIME = {"employment_type": "fulltime", "available_days": [1, 2, 3, 4, 5, 6, 7],
           "available_from": "", "available_to": ""}

cases = []
def to_py_dates(row):
    return {**row, "work_date": date.fromisoformat(row["work_date"])}


def add_conflict_case(name, candidate, existing, employee):
    found = scheduling.check_conflicts(
        to_py_dates(candidate), [to_py_dates(r) for r in existing],
        {**employee, "available_days": set(employee["available_days"])},
        SETTINGS)
    cases.append({
        "name": name, "candidate": candidate, "existing": existing,
        "employee": employee, "settings": SETTINGS,
        "expected": [c.as_dict() for c in found],
    })

add_conflict_case("无冲突", cand(), [ex("2026-03-09", "09:00", "17:00")], ANYTIME)
add_conflict_case("完全重叠", cand(), [ex("2026-03-10", "09:00", "17:00")], ANYTIME)
add_conflict_case("部分重叠", cand(start="15:00", end="20:00"), [ex("2026-03-10", "09:00", "17:00")], ANYTIME)
add_conflict_case("首尾相接", cand(start="17:00", end="21:00"), [ex("2026-03-10", "09:00", "17:00")], ANYTIME)
add_conflict_case("跨日与次日重叠", cand(start="19:00", end="01:00"), [ex("2026-03-11", "00:30", "04:30")], ANYTIME)
add_conflict_case("跨日休息不足", cand(start="19:00", end="01:00"), [ex("2026-03-11", "07:00", "15:00")], ANYTIME)
add_conflict_case("编辑排除自身", cand(cid=7), [ex("2026-03-10", "09:00", "17:00", rid=7)], ANYTIME)
add_conflict_case("不可排班日", cand(d="2026-03-14"), [],
                  {**ANYTIME, "available_days": [1, 2, 3, 4, 5]})
add_conflict_case("超出可用时段", cand(start="17:00", end="21:00"), [],
                  {**ANYTIME, "available_from": "09:00", "available_to": "18:00"})
add_conflict_case("可用时段内正常", cand(start="09:00", end="17:00"), [],
                  {**ANYTIME, "available_from": "09:00", "available_to": "18:00"})
add_conflict_case("每日上限", cand(start="17:00", end="21:00"), [ex("2026-03-10", "09:00", "17:00")], ANYTIME)
add_conflict_case("兼职每日上限", cand(start="09:00", end="21:00"), [],
                  {"employment_type": "parttime", "available_days": [1, 2, 3, 4, 5, 6, 7],
                   "available_from": "", "available_to": ""})
add_conflict_case("每周上限", cand(d="2026-03-13"),
                  [ex(f"2026-03-{d:02d}", "09:00", "17:00") for d in (9, 10, 11, 12)],
                  {"employment_type": "parttime", "available_days": [1, 2, 3, 4, 5, 6, 7],
                   "available_from": "", "available_to": ""})
add_conflict_case("周日跨夜归属开始周", cand(d="2026-03-15", start="21:00", end="01:00"),
                  [ex(f"2026-03-{d:02d}", "09:00", "17:00") for d in (9, 10, 11, 12, 13)],
                  {"employment_type": "parttime", "available_days": [1, 2, 3, 4, 5, 6, 7],
                   "available_from": "", "available_to": ""})

summary_cases = []
def add_summary_case(name, rows, start, end):
    result = worktime.summarize(
        [{**r, "work_date": date.fromisoformat(r["work_date"])} for r in rows],
        date.fromisoformat(start), date.fromisoformat(end))
    summary_cases.append({"name": name, "rows": rows, "start": start, "end": end, "expected": result})

add_summary_case("单班次含休息", [
    {"employee_id": 1, "employee_name": "张三", "position": "前厅", "employment_type": "fulltime",
     "work_date": "2026-03-10", "start_time": "09:00", "end_time": "17:00", "break_minutes": 30},
], "2026-03-09", "2026-03-15")
add_summary_case("跨日归属开始日", [
    {"employee_id": 1, "employee_name": "张三", "position": "", "employment_type": "fulltime",
     "work_date": "2026-03-10", "start_time": "21:00", "end_time": "01:00", "break_minutes": 0},
], "2026-03-01", "2026-03-31")
add_summary_case("周日跨夜周界归属", [
    {"employee_id": 1, "employee_name": "张三", "position": "", "employment_type": "fulltime",
     "work_date": "2026-03-15", "start_time": "21:00", "end_time": "01:00", "break_minutes": 0},
], "2026-03-09", "2026-03-15")
add_summary_case("多人排序与逐日", [
    {"employee_id": 2, "employee_name": "李四", "position": "后厨", "employment_type": "parttime",
     "work_date": "2026-03-10", "start_time": "09:00", "end_time": "17:00", "break_minutes": 30},
    {"employee_id": 1, "employee_name": "张三", "position": "前厅", "employment_type": "fulltime",
     "work_date": "2026-03-10", "start_time": "11:00", "end_time": "19:00", "break_minutes": 30},
    {"employee_id": 1, "employee_name": "张三", "position": "前厅", "employment_type": "fulltime",
     "work_date": "2026-03-11", "start_time": "11:00", "end_time": "19:00", "break_minutes": 30},
], "2026-03-09", "2026-03-15")

fmt_hours = [
    {"minutes": m, "expected": scheduling._fmt_hours(m)}
    for m in (0, 15, 45, 75, 105, 135, 450, 480, 630, 1440, 2640, 2700)
]

fixture = {"conflictCases": cases, "summaryCases": summary_cases, "fmtHoursCases": fmt_hours}
out = ROOT / "cloudflare" / "test" / "fixture.json"
out.write_text(json.dumps(fixture, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"fixture 已写入：{out}（冲突用例 {len(cases)}，汇总用例 {len(summary_cases)}，格式化用例 {len(fmt_hours)}）")
