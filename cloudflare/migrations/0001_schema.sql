-- 轻排班 · D1 数据库结构（与 Python 版 schema.sql 一致，默认时间改为 UTC 以适配云端）
-- 工时数据不单独建表，由 schedules 实时推导；班次时间在 schedules 中保存快照。

CREATE TABLE IF NOT EXISTS employees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    position        TEXT    NOT NULL DEFAULT '',
    employment_type TEXT    NOT NULL DEFAULT 'fulltime',
    phone           TEXT    NOT NULL DEFAULT '',
    available_days  TEXT    NOT NULL DEFAULT '[1,2,3,4,5]',
    available_from  TEXT    NOT NULL DEFAULT '',
    available_to    TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'active',
    note            TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    start_time    TEXT    NOT NULL,
    end_time      TEXT    NOT NULL,
    break_minutes INTEGER NOT NULL DEFAULT 0,
    position      TEXT    NOT NULL DEFAULT '',
    color         TEXT    NOT NULL DEFAULT 'primary',
    note          TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   INTEGER NOT NULL REFERENCES employees(id),
    work_date     TEXT    NOT NULL,
    start_time    TEXT    NOT NULL,
    end_time      TEXT    NOT NULL,
    break_minutes INTEGER NOT NULL DEFAULT 0,
    position      TEXT    NOT NULL DEFAULT '',
    template_id   INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_emp_date ON schedules(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_schedules_date     ON schedules(work_date);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES
    ('store_name', '青禾轻食·大学城店'),
    ('app_title', '轻排班'),
    ('brand_avatar', ''),
    ('rest_minutes_min', '600'),
    ('daily_max_minutes_fulltime', '600'),
    ('daily_max_minutes_parttime', '480'),
    ('weekly_max_minutes_fulltime', '2640'),
    ('weekly_max_minutes_parttime', '1440');

-- 登录失败限速（Workers 版；进程内无状态，落表实现）
CREATE TABLE IF NOT EXISTS login_attempts (
    ip       TEXT PRIMARY KEY,
    count    INTEGER NOT NULL DEFAULT 0,
    started  INTEGER NOT NULL          -- epoch 毫秒
);
