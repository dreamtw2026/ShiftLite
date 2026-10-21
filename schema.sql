-- 轻排班 数据库结构（SQLite）
-- 说明：
--   1. 工时数据不单独建表，由 schedules（排班记录）按统计周期实时推导，
--      避免排班与工时双写不一致；如后续接入考勤打卡，可扩展 attendance 表。
--   2. 班次时间在 schedules 中保存快照（start_time/end_time/break_minutes），
--      模板删除不影响历史排班数据。

PRAGMA foreign_keys = ON;

-- 员工表
CREATE TABLE IF NOT EXISTS employees (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    position        TEXT    NOT NULL DEFAULT '',              -- 岗位
    employment_type TEXT    NOT NULL DEFAULT 'fulltime',      -- fulltime=全职 / parttime=兼职
    phone           TEXT    NOT NULL DEFAULT '',
    available_days  TEXT    NOT NULL DEFAULT '[1,2,3,4,5]',   -- JSON 数组，ISO 星期 1=周一 … 7=周日
    available_from  TEXT    NOT NULL DEFAULT '',              -- 每日可用开始 HH:MM，空表示不限
    available_to    TEXT    NOT NULL DEFAULT '',              -- 每日可用结束 HH:MM，空表示不限
    status          TEXT    NOT NULL DEFAULT 'active',        -- active=在职 / inactive=离职（停用）
    note            TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 班次模板表
CREATE TABLE IF NOT EXISTS shift_templates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    start_time    TEXT    NOT NULL,                        -- HH:MM
    end_time      TEXT    NOT NULL,                        -- HH:MM，早于或等于开始时间表示次日结束
    break_minutes INTEGER NOT NULL DEFAULT 0,              -- 班内休息时长（分钟）
    position      TEXT    NOT NULL DEFAULT '',             -- 建议岗位
    color         TEXT    NOT NULL DEFAULT 'primary',      -- 排班芯片配色 token：primary/secondary/tertiary/warning
    note          TEXT    NOT NULL DEFAULT ''
);

-- 排班记录表（work_date 为班次开始日期；跨日班次整体归属开始日期所在统计周期）
CREATE TABLE IF NOT EXISTS schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   INTEGER NOT NULL REFERENCES employees(id),
    work_date     TEXT    NOT NULL,                        -- YYYY-MM-DD
    start_time    TEXT    NOT NULL,                        -- HH:MM
    end_time      TEXT    NOT NULL,                        -- HH:MM
    break_minutes INTEGER NOT NULL DEFAULT 0,
    position      TEXT    NOT NULL DEFAULT '',
    template_id   INTEGER REFERENCES shift_templates(id) ON DELETE SET NULL,
    note          TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_emp_date ON schedules(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_schedules_date     ON schedules(work_date);

-- 可配置规则（键值对）
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
