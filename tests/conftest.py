"""pytest 公共夹具：临时数据库 + Flask 测试客户端。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import db as database  # noqa: E402


@pytest.fixture()
def tmp_db(tmp_path):
    """每个测试用独立的临时数据库。"""
    db_path = tmp_path / "test.db"
    database.init_db(db_path)
    return db_path


@pytest.fixture()
def app(tmp_db):
    from app import create_app
    application = create_app(db_path=tmp_db)
    application.config["TESTING"] = True
    return application


@pytest.fixture()
def client(app):
    """已登录的测试客户端。"""
    c = app.test_client()
    from app import DEFAULT_ADMIN_PASSWORD
    c.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    return c


@pytest.fixture()
def fresh_client(app):
    """未登录的测试客户端（认证测试用）。"""
    return app.test_client()


@pytest.fixture()
def seeded_db(tmp_db):
    """写入演示数据的临时数据库。"""
    import seed
    seed.force_seed(tmp_db)
    return tmp_db


@pytest.fixture()
def seeded_client(seeded_db):
    from app import create_app, DEFAULT_ADMIN_PASSWORD
    application = create_app(db_path=seeded_db)
    application.config["TESTING"] = True
    c = application.test_client()
    c.post("/login", data={"password": DEFAULT_ADMIN_PASSWORD})
    return c
