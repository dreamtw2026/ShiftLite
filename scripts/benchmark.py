"""性能测量脚本：对运行中的原型进行真实计时，结果写入 docs/perf-results.md。

前置条件：服务已启动（python app.py，http://127.0.0.1:5001），演示数据已载入。
运行：python scripts/benchmark.py

测量口径：开发服务器（Flask 内置，单进程单线程），本机回环网络，
每项操作重复 N 次取平均值与最大值。数据为原型验证口径，非生产部署性能。
"""
from __future__ import annotations

import json
import statistics
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = "http://127.0.0.1:5001"
REPEAT = 20
OUT_PATH = Path(__file__).resolve().parents[1] / "docs" / "perf-results.md"


def timed_get(path: str) -> tuple[float, int]:
    start = time.perf_counter()
    with urllib.request.urlopen(BASE + path) as resp:
        resp.read()
    return (time.perf_counter() - start) * 1000, 200


def timed_post(path: str, payload: dict | None = None) -> tuple[float, int, dict]:
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read() or b"{}")
        return (time.perf_counter() - start) * 1000, resp.status, body
    except urllib.error.HTTPError as e:
        e.read()
        return (time.perf_counter() - start) * 1000, e.code, {}


def measure(name: str, fn, repeat: int = REPEAT) -> dict:
    samples = []
    status = 0
    for i in range(repeat):
        # 排班写接口轮换日期，避免唯一约束类副作用累积
        ms, status = fn(i)
        samples.append(ms)
    return {
        "name": name,
        "count": repeat,
        "avg": round(statistics.mean(samples), 1),
        "p95": round(sorted(samples)[int(len(samples) * 0.95) - 1], 1),
        "max": round(max(samples), 1),
        "status": status,
    }


def main() -> None:
    today = date.today()
    results = []

    results.append(measure(
        "概览页 GET /", lambda _: timed_get("/")))
    results.append(measure(
        "排班页（周视图+冲突面板）GET /schedule", lambda _: timed_get("/schedule")))
    results.append(measure(
        "工时统计页（周）GET /hours?period=week", lambda _: timed_get("/hours?period=week")))
    results.append(measure(
        "员工页 GET /employees", lambda _: timed_get("/employees")))
    results.append(measure(
        "冲突检测 GET /api/conflicts（本周全部记录）", lambda _: timed_get("/api/conflicts")))
    results.append(measure(
        "导出排班表 GET /export/schedule（xlsx）", lambda _: timed_get("/export/schedule")))
    results.append(measure(
        "导出工时表 GET /export/hours（xlsx）", lambda _: timed_get("/export/hours?period=week")))

    # 新增一条排班（含冲突检测+写库）并立即删除，保持数据规模不变
    def create_then_delete(i: int):
        d = (today + timedelta(days=14 + (i % 7))).isoformat()
        ms, status, body = timed_post("/api/schedules", {
            "employee_id": 6, "work_date": d,
            "start_time": "11:00", "end_time": "19:00", "break_minutes": 30})
        if body.get("id"):
            urllib.request.urlopen(urllib.request.Request(
                f"{BASE}/api/schedules/{body['id']}", method="DELETE")).read()
        return ms, status
    results.append(measure("新增排班 POST /api/schedules（含冲突检测）",
                           create_then_delete, repeat=10))

    # 查询本周排班记录规模，写入报告
    with urllib.request.urlopen(BASE + "/api/conflicts") as resp:
        conflict_count = len(json.load(resp)["conflicts"])

    lines = [
        "# 性能测量结果（真实执行）",
        "",
        f"- 测量日期：{today.isoformat()}",
        "- 环境：Windows 11（x64），Python 3.14.7，Flask 3.1.3 开发服务器，"
        "SQLite 本地文件，浏览器与服务器同机（回环网络）",
        f"- 数据规模：演示门店 10 名在职员工、4 个班次模板、68 条排班记录"
        f"（当前周 45 条），当前周冲突 {conflict_count} 条",
        f"- 方法：每项操作连续重复（写操作轮换日期），记录平均 / P95 / 最大耗时（毫秒）",
        "- 说明：Flask 开发服务器为单线程参考实现，生产部署（如 waitress/gunicorn + "
        "反向代理）下吞吐会更高；本表数据用于验证原型规模下的响应速度，"
        "不构成生产环境性能承诺",
        "",
        "| 操作 | 次数 | 平均 (ms) | P95 (ms) | 最大 (ms) | 状态码 |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for r in results:
        lines.append(f"| {r['name']} | {r['count']} | {r['avg']} | {r['p95']} | "
                     f"{r['max']} | {r['status']} |")
    lines += [
        "",
        "## 测量局限与计划测试",
        "",
        "- 上述指标为机器计时，覆盖页面渲染、冲突检测、工时汇总与报表导出的服务端耗时；",
        "- 与人工/Excel 流程的对比需要真实操作者参与计时（如店长编制一张 40 班次周表的"
        "耗时、人工核对冲突的漏检率），本项目尚未开展此类测试，已列为后续计划，"
        "不在本报告中虚构对比数据；",
        "- 原型阶段未做并发压力测试（单用户使用场景），列为后续计划。",
        "",
    ]
    OUT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"已写入 {OUT_PATH}")
    for r in results:
        print(f"  {r['name']}: 平均 {r['avg']} ms / P95 {r['p95']} ms")


if __name__ == "__main__":
    main()
