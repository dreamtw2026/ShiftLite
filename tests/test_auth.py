"""认证与账号测试：登录保护、密码校验、限速、修改密码、登出。"""
from __future__ import annotations

from app import DEFAULT_ADMIN_PASSWORD


def test_unauthenticated_redirects_to_login(fresh_client):
    resp = fresh_client.get("/")
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]
    # API 未登录返回 401 JSON 而非重定向
    resp = fresh_client.get("/api/conflicts")
    assert resp.status_code == 401
    assert "登录已过期" in resp.get_json()["errors"][0]
    # 备份下载同样受保护
    resp = fresh_client.get("/backup")
    assert resp.status_code == 302


def test_login_page_and_wrong_password(fresh_client):
    resp = fresh_client.get("/login")
    assert resp.status_code == 200
    page = resp.data.decode()
    assert "用户名" in page and "密码" in page and "shiftlite123" in page  # 演示默认账号提示
    resp = fresh_client.post("/login", data={"password": "wrong-pass"})
    assert resp.status_code == 200
    assert "密码错误" in resp.data.decode()
    # 新增用户名字段：非 admin 用户名直接拒绝，且不影响原有密码校验
    resp = fresh_client.post("/login", data={"username": "nobody", "password": DEFAULT_ADMIN_PASSWORD})
    assert resp.status_code == 200
    assert "用户名不存在" in resp.data.decode()


def test_login_success_and_logout(fresh_client):
    resp = fresh_client.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD, "next": "/schedule"})
    assert resp.status_code == 302
    assert resp.headers["Location"].endswith("/schedule")
    page = fresh_client.get("/schedule")
    assert page.status_code == 200
    # 登出后再次访问受保护页面
    resp = fresh_client.post("/logout")
    assert resp.status_code == 302
    assert fresh_client.get("/").status_code == 302


def test_change_password(fresh_client):
    fresh_client.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    # 修改密码
    resp = fresh_client.post("/settings/password", data={
        "current_password": DEFAULT_ADMIN_PASSWORD,
        "new_password": "newpass1", "confirm_password": "newpass1"})
    assert resp.status_code == 302
    # 登出后旧密码失效、新密码可用
    fresh_client.post("/logout")
    resp = fresh_client.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    assert "密码错误" in resp.data.decode()
    resp = fresh_client.post("/login", data={"password": "newpass1"})
    assert resp.status_code == 302


def test_change_password_validation(fresh_client):
    fresh_client.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    cases = [
        {"current_password": "wrong", "new_password": "abcdef", "confirm_password": "abcdef"},
        {"current_password": DEFAULT_ADMIN_PASSWORD, "new_password": "abc", "confirm_password": "abc"},
        {"current_password": DEFAULT_ADMIN_PASSWORD, "new_password": "abcdef", "confirm_password": "other1"},
    ]
    for data in cases:
        resp = fresh_client.post("/settings/password", data=data)
        assert resp.status_code == 302
        # 设置页闪现错误信息（当前密码不正确 / 至少 6 位 / 不一致）
    page = fresh_client.get("/settings").data.decode()
    assert "修改失败" in page


def test_login_throttle(fresh_client):
    # 连续失败达上限后提示限速
    last = None
    for _ in range(6):
        last = fresh_client.post("/login", data={"password": "wrong"})
    assert "尝试过于频繁" in last.data.decode()
    # 限速期间正确密码也不放行
    resp = fresh_client.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    assert "尝试过于频繁" in resp.data.decode()
