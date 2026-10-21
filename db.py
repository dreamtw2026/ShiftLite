"""SQLite 连接、建库初始化与规则配置读取。"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
# 云端/容器部署可通过环境变量把数据库指到挂载卷，如 SHIFTLITE_DB=/data/shiftlite.db
DB_PATH = Path(os.environ.get("SHIFTLITE_DB", BASE_DIR / "instance" / "shiftlite.db"))
SCHEMA_PATH = BASE_DIR / "schema.sql"

# 规则默认值（演示口径，正式使用前须按当地法规与机构制度调整）
DEFAULT_SETTINGS: dict[str, str] = {
    "store_name": "青禾轻食·大学城店",
    "app_title": "轻排班",                    # 系统标题：侧边栏品牌与浏览器标签
    "brand_avatar": "",                       # 品牌头像：static 下相对路径，空为默认字标
    "rest_minutes_min": "600",               # 相邻两班最小休息间隔（分钟）
    "daily_max_minutes_fulltime": "600",     # 全职每日有效工时上限
    "daily_max_minutes_parttime": "480",     # 兼职每日有效工时上限
    "weekly_max_minutes_fulltime": "2640",   # 全职每周（周一至周日）有效工时上限（44 小时口径）
    "weekly_max_minutes_parttime": "1440",   # 兼职每周有效工时上限（24 小时口径）
}

MINUTE_KEYS = [
    "rest_minutes_min",
    "daily_max_minutes_fulltime",
    "daily_max_minutes_parttime",
    "weekly_max_minutes_fulltime",
    "weekly_max_minutes_parttime",
]


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path or DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: str | Path | None = None) -> Path:
    path = Path(db_path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection(path)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (key, value)
            )
        conn.commit()
    finally:
        conn.close()
    return path


def load_settings(conn: sqlite3.Connection) -> dict:
    """读取规则配置：数值键转为 int，非法值回落到默认值。"""
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    merged: dict = dict(DEFAULT_SETTINGS)
    merged.update({row["key"]: row["value"] for row in rows})
    for key in MINUTE_KEYS:
        try:
            merged[key] = int(merged[key])
        except (TypeError, ValueError):
            merged[key] = int(DEFAULT_SETTINGS[key])
    return merged


def save_settings(conn: sqlite3.Connection, values: dict[str, str]) -> None:
    for key, value in values.items():
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
    conn.commit()


def parse_available_days(text: str) -> set[int]:
    """把 employees.available_days 的 JSON 文本解析为 ISO 星期数字集合。"""
    try:
        data = json.loads(text or "[]")
    except json.JSONDecodeError:
        return set()
    return {int(d) for d in data if isinstance(d, (int, float)) and 1 <= int(d) <= 7}
