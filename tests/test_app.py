"""功能测试：通过 Flask 测试客户端验证页面与 API 的端到端行为。"""
from __future__ import annotations

import json
from datetime import date, timedelta
from io import BytesIO

from openpyxl import load_workbook


def _post_json(client, url, data):
    return client.post(url, data=json.dumps(data), content_type="application/json")


def _seed_day(iso_weekday: int, week_offset: int = 0) -> str:
    monday = date.today() - timedelta(days=date.today().isoweekday() - 1)
    return (monday + timedelta(days=iso_weekday - 1, weeks=week_offset)).isoformat()


def test_pages_render(client):
    for url in ["/", "/schedule", "/employees", "/shift-templates",
                "/hours?period=week", "/settings"]:
        resp = client.get(url)
        assert resp.status_code == 200, f"{url} 渲染失败"
        assert "轻排班".encode() in resp.data


def test_employee_crud_and_validation(client):
    # 新增
    resp = client.post("/employees", data={
        "action": "create", "name": "测试员工", "position": "前厅",
        "employment_type": "parttime", "phone": "13900000000",
        "available_days": ["1", "2", "3"], "available_from": "09:00",
        "available_to": "18:00", "status": "active", "note": ""})
    assert resp.status_code == 302
    page = client.get("/employees").data.decode()
    assert "测试员工" in page
    # 校验：可用时间段开始晚于结束
    resp = client.post("/employees", data={
        "action": "create", "name": "时间非法", "position": "",
        "employment_type": "fulltime", "phone": "", "available_days": ["1"],
        "available_from": "18:00", "available_to": "09:00", "status": "active"})
    assert resp.status_code == 302
    page = client.get("/employees").data.decode()
    assert "时间非法" not in page  # 校验失败不落库
    # 校验：格式正确但时钟数值越界
    client.post("/employees", data={
        "action": "create", "name": "越界时间", "position": "",
        "employment_type": "fulltime", "phone": "", "available_days": ["1"],
        "available_from": "09:00", "available_to": "99:00", "status": "active"})
    page = client.get("/employees").data.decode()
    assert "越界时间" not in page
    assert "有效的 HH:MM" in page


def test_template_create_and_delete(client):
    resp = client.post("/shift-templates", data={
        "action": "create", "name": "夜班", "start_time": "22:00",
        "end_time": "06:00", "break_minutes": "30", "position": "后厨",
        "color": "warning", "note": ""})
    assert resp.status_code == 302
    page = client.get("/shift-templates").data.decode()
    assert "夜班" in page and "跨日" in page
    # 非法时间（起止相同）
    resp = client.post("/shift-templates", data={
        "action": "create", "name": "零班", "start_time": "09:00",
        "end_time": "09:00", "break_minutes": "0", "position": "", "color": "primary"})
    assert resp.status_code == 302  # flash 错误后重定向回列表
    page = client.get("/shift-templates").data.decode()
    assert "开始与结束时间相同" in page


def test_schedule_conflict_block_and_force(seeded_client):
    client = seeded_client
    # 演示周周六：周杰(id=6) 当日已有早班 07:00–15:00 与中班 11:00–19:00
    resp = _post_json(client, "/api/schedules", {
        "employee_id": 6, "work_date": _seed_day(6),
        "start_time": "11:30", "end_time": "14:00", "break_minutes": 0})
    assert resp.status_code == 409
    conflicts = resp.get_json()["conflicts"]
    assert any(c["rule"] == "overlap" and c["severity"] == "error" for c in conflicts)
    # 强制保存成功
    resp = _post_json(client, "/api/schedules?force=1", {
        "employee_id": 6, "work_date": _seed_day(6),
        "start_time": "11:30", "end_time": "14:00", "break_minutes": 0})
    assert resp.status_code == 201
    schedule_id = resp.get_json()["id"]
    # 删除
    resp = client.delete(f"/api/schedules/{schedule_id}")
    assert resp.status_code == 200


def test_schedule_validation_errors(seeded_client):
    resp = _post_json(seeded_client, "/api/schedules", {
        "employee_id": 6, "work_date": _seed_day(6),
        "start_time": "99:00", "end_time": "xx:xx", "break_minutes": 0})
    assert resp.status_code == 400
    errors = resp.get_json()["errors"]
    assert any("开始时间" in e for e in errors)
    # 起止相同
    resp = _post_json(seeded_client, "/api/schedules", {
        "employee_id": 6, "work_date": _seed_day(6),
        "start_time": "09:00", "end_time": "09:00", "break_minutes": 0})
    assert resp.status_code == 400
    assert any("相同" in e for e in resp.get_json()["errors"])
    # 休息不能达到或超过班次总时长
    resp = _post_json(seeded_client, "/api/schedules", {
        "employee_id": 6, "work_date": _seed_day(6),
        "start_time": "09:00", "end_time": "10:00", "break_minutes": 120})
    assert resp.status_code == 400
    assert any("小于班次总时长" in e for e in resp.get_json()["errors"])


def test_schedule_update_rejects_inactive_or_missing_employee(seeded_client):
    client = seeded_client
    payload = {
        "employee_id": 10, "work_date": _seed_day(6),
        "start_time": "09:00", "end_time": "12:00", "break_minutes": 0}
    client.post("/employees", data={
        "action": "update", "id": "10", "name": "许阳", "position": "外卖打包",
        "employment_type": "parttime", "phone": "", "available_days": ["1", "2", "6", "7"],
        "available_from": "06:30", "available_to": "21:30", "status": "inactive"})
    resp = client.put("/api/schedules/1", data=json.dumps(payload), content_type="application/json")
    assert resp.status_code == 400
    assert "已离职" in resp.get_json()["errors"][0]
    payload["employee_id"] = 99999
    resp = client.put("/api/schedules/1", data=json.dumps(payload), content_type="application/json")
    assert resp.status_code == 400
    assert "不存在" in resp.get_json()["errors"][0]


def test_conflicts_api_on_seeded_week(seeded_client):
    """演示数据本周应检出：重叠、可用时间冲突及工时提示。"""
    resp = seeded_client.get(f"/api/conflicts?date={_seed_day(4)}")
    assert resp.status_code == 200
    conflicts = resp.get_json()["conflicts"]
    rule_set = {c["rule"] for c in conflicts}
    assert {"overlap", "availability"} <= rule_set
    assert any(c["severity"] == "error" for c in conflicts)
    assert any(c["rule"] in ("daily_limit", "weekly_limit") for c in conflicts)


def test_hours_page_contains_totals(seeded_client):
    resp = seeded_client.get(f"/hours?period=week&date={_seed_day(4)}")
    page = resp.data.decode()
    assert "合计" in page and "有效工时" in page


def test_schedule_page_shows_conflict_panel(seeded_client):
    resp = seeded_client.get(f"/schedule?date={_seed_day(4)}")
    page = resp.data.decode()
    assert "本周冲突与工时提示" in page
    assert "班次重叠" in page


def test_export_schedule_xlsx(seeded_client):
    resp = seeded_client.get(f"/export/schedule?date={_seed_day(4)}")
    assert resp.status_code == 200
    assert resp.mimetype == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ws = load_workbook(BytesIO(resp.data)).active
    assert "排班表" in ws.cell(1, 1).value
    assert ws.max_row > 10  # 演示数据两周约 68 条，本周应有几十行


def test_export_hours_xlsx_week_has_day_columns(seeded_client):
    resp = seeded_client.get(f"/export/hours?period=week&date={_seed_day(4)}")
    ws = load_workbook(BytesIO(resp.data)).active
    headers = [ws.cell(2, i).value for i in range(1, ws.max_column + 1)]
    assert "周一" in headers and "周日" in headers
    total_row = ws.max_row
    assert ws.cell(total_row, 1).value == "合计"


def test_settings_roundtrip(client):
    resp = client.post("/settings", data={
        "store_name": "测试门店A", "app_title": "米仓排班", "rest_minutes_min": "660",
        "daily_max_minutes_fulltime": "660", "daily_max_minutes_parttime": "480",
        "weekly_max_minutes_fulltime": "2700", "weekly_max_minutes_parttime": "1500"})
    assert resp.status_code == 302
    page = client.get("/settings").data.decode()
    assert 'value="测试门店A"' in page
    assert 'value="米仓排班"' in page
    assert 'value="660"' in page
    # 系统标题同步到侧边栏与标签页
    page = client.get("/").data.decode()
    assert "米仓排班" in page
    # 非法数值被拒绝
    resp = client.post("/settings", data={
        "store_name": "测试门店A", "app_title": "米仓排班", "rest_minutes_min": "abc",
        "daily_max_minutes_fulltime": "660", "daily_max_minutes_parttime": "480",
        "weekly_max_minutes_fulltime": "2700", "weekly_max_minutes_parttime": "1500"})
    page = client.get("/settings").data.decode()
    assert "保存失败" in page
    # 标题留空回落默认
    client.post("/settings", data={
        "store_name": "测试门店A", "app_title": "", "rest_minutes_min": "600",
        "daily_max_minutes_fulltime": "600", "daily_max_minutes_parttime": "480",
        "weekly_max_minutes_fulltime": "2640", "weekly_max_minutes_parttime": "1440"})
    page = client.get("/settings").data.decode()
    assert 'value="轻排班"' in page


# 1×1 像素的最小合法 PNG（base64）
_PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_avatar_upload_and_remove(client):
    from io import BytesIO
    # 上传合法 PNG
    resp = client.post("/settings/avatar", data={
        "avatar": (BytesIO(_PNG_1PX), "logo.png")}, content_type="multipart/form-data")
    assert resp.status_code == 302
    page = client.get("/settings").data.decode()
    assert "/brand-avatar" in page
    # 头像路由可访问（内存读取，不长期占用文件句柄），侧边栏出现头像
    avatar_resp = client.get("/brand-avatar")
    assert avatar_resp.status_code == 200
    assert avatar_resp.mimetype == "image/png"
    assert len(avatar_resp.data) == len(_PNG_1PX)
    home = client.get("/").data.decode()
    assert "brand-avatar" in home
    # 非图片内容被拒绝（扩展名伪造）
    resp = client.post("/settings/avatar", data={
        "avatar": (BytesIO(b"definitely not an image"), "fake.png")},
        content_type="multipart/form-data")
    assert resp.status_code == 302
    page = client.get("/settings").data.decode()
    assert "不支持的图片格式" in page
    # 移除后恢复默认字标
    resp = client.post("/settings/avatar/remove")
    assert resp.status_code == 302
    home = client.get("/").data.decode()
    assert "brand-avatar" not in home
    assert client.get("/brand-avatar").status_code == 404


def test_inactive_employee_history_remains_visible(seeded_client):
    client = seeded_client
    # 停用 许阳(id=10)，其当周历史班次仍应保留展示但不能新增排班。
    client.post("/employees", data={
        "action": "update", "id": "10", "name": "许阳", "position": "外卖打包",
        "employment_type": "parttime", "phone": "", "available_days": ["1", "2", "6", "7"],
        "available_from": "06:30", "available_to": "21:30", "status": "inactive"})
    page = client.get(f"/schedule?date={_seed_day(4)}").data.decode()
    assert "许阳" in page
    assert "已停用" in page
    assert 'data-cell-employee="10"' not in page


def test_schedule_page_shows_staff_counts_and_week_hours(seeded_client):
    page = seeded_client.get(f"/schedule?date={_seed_day(4)}").data.decode()
    assert "本周 " in page
    assert "人 ·" in page and "班" in page
    assert 'id="copy-prev-week"' in page


def test_copy_previous_week_preview_confirm_and_skip(seeded_client):
    client = seeded_client
    # 演示数据的下周存在少量排班；复制当前周到下周应预检并跳过重复项。
    target_date = _seed_day(4, week_offset=1)
    preview = _post_json(client, "/api/schedules/copy-week", {"target_date": target_date})
    assert preview.status_code == 200
    data = preview.get_json()
    assert data["source_start"] == _seed_day(1)
    assert data["target_start"] == _seed_day(1, week_offset=1)
    assert data["copy_count"] > 0
    assert data["skipped_existing"] > 0

    saved = _post_json(client, "/api/schedules/copy-week", {
        "target_date": target_date, "confirm": True})
    assert saved.status_code == 201
    assert saved.get_json()["created"] == data["copy_count"]

    again = _post_json(client, "/api/schedules/copy-week", {"target_date": target_date})
    assert again.status_code == 200
    assert again.get_json()["copy_count"] == 0


def test_backup_download(client):
    resp = client.get("/backup")
    assert resp.status_code == 200
    assert len(resp.data) > 0
    assert resp.headers["Content-Disposition"].endswith(".db\"") or \
        "backup" in resp.headers["Content-Disposition"]
