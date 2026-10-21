// 轻排班 · Cloudflare Workers 版应用
// 与 Python/Flask 版（app.py）功能对齐：相同路由、相同 JSON API、相同 Material 3 页面。
// 数据存 D1（SQLite 兼容），静态资源经 Workers 静态资产（public/）伺服。
// 差异说明（详见 README）：
// - 品牌头像以 data URL 存于 D1，上限 200KB（Python 版为文件上传，2MB）；
// - /backup 返回 JSON 全量导出（Python 版为 SQLite 文件下载）；
// - 页面“今天”按东八区（Asia/Shanghai）计算。

import {
  WEEKDAY_NAMES, TYPE_LABELS, isoWeekday, weekRange, monthRange,
  shiftSpanMinutes, effectiveMinutes, checkConflicts, summarize, hours, fmtMD,
} from "./core.js";
import { exportScheduleXlsx, exportHoursXlsx } from "./xlsx.js";

// ---------- 认证（单管理员账号，PBKDF2-SHA256，与 Python 版同参数） ----------
const DEFAULT_ADMIN_PASSWORD = "shiftlite123";
const PBKDF2_ITERATIONS = 200000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "shiftlite_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hashPassword(password, saltBytes) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"])
    .then((key) => crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS }, key, 256))
    .then((bits) => b64url(new Uint8Array(bits)));
}

async function makePasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const digest = await hashPassword(password, salt);
  return `${b64url(salt)}$${digest}`;
}

/** 校验密码；盐/摘要在 Workers 端为 base64url，兼容 Python 端 hex 格式（互不混用）。 */
async function verifyPassword(password, stored) {
  const [saltPart, digestPart] = String(stored ?? "").split("$");
  if (!saltPart || !digestPart) return false;
  const isHex = /^[0-9a-f]+$/i.test(saltPart) && saltPart.length % 2 === 0 && /^[0-9a-f]+$/i.test(digestPart);
  let saltBytes, digest;
  if (isHex) {  // Python 版写入的 hex 格式（同库迁移场景）
    const saltHex = saltPart.length % 2 ? "0" + saltPart : saltPart;
    saltBytes = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    digest = digestPart;
  } else {
    const pad = (s) => s.replace(/-/g, "+").replace(/_/g, "/");
    saltBytes = Uint8Array.from(atob(pad(saltPart)), (c) => c.charCodeAt(0));
    digest = b64url(Uint8Array.from(atob(pad(digestPart)), (c) => c.charCodeAt(0)));
  }
  const candidate = await hashPassword(password, saltBytes);
  if (isHex) {
    // Python hex 摘要：把候选 base64url 转 hex 比对
    const bytes = Uint8Array.from(atob(candidate.replace(/-/g, "+")), (c) => c.charCodeAt(0));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === digestPart.toLowerCase();
  }
  return candidate === digest;
}

/** 会话签名：exp.expires_b64.payloadMAC（HMAC-SHA256，密钥为持久化 session_secret）。 */
async function sessionSecret(db) {
  const s = await loadSettings(db);
  if (!s.session_secret) {
    const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await saveSettings(db, { session_secret: secret });
    return secret;
  }
  return s.session_secret;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(mac));
}

async function makeSession(db) {
  const secret = await sessionSecret(db);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `admin.${exp}`;
  return `${exp}.${await hmacSign(secret, payload)}`;
}

async function checkSession(db, cookie) {
  if (!cookie) return false;
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const token = match ? match[1] : "";
  const [expStr, mac] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Date.now() || !mac) return false;
  const secret = await sessionSecret(db);
  const expect = await hmacSign(secret, `admin.${expStr}`);
  return mac === expect;   // 长度固定的 base64url，常数时间比较意义有限，此处直接比对
}

function sessionCookie(token, clear = false) {
  const base = `${SESSION_COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}`;
  return base;
}

/** 登录失败限速：返回剩余等待毫秒数（0 表示不限速）。 */
async function throttleRemaining(db, ip) {
  const row = await db.prepare("SELECT count, started FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (!row) return 0;
  const elapsed = Date.now() - row.started;
  if (elapsed > LOGIN_WINDOW_MS || row.count < LOGIN_MAX_ATTEMPTS) return 0;
  return LOGIN_WINDOW_MS - elapsed;
}

async function throttleFail(db, ip) {
  const row = await db.prepare("SELECT count, started FROM login_attempts WHERE ip = ?").bind(ip).first();
  const now = Date.now();
  if (!row || now - row.started > LOGIN_WINDOW_MS) {
    await db.prepare("INSERT INTO login_attempts(ip, count, started) VALUES (?, 1, ?) " +
      "ON CONFLICT(ip) DO UPDATE SET count = 1, started = excluded.started").bind(ip, now).run();
  } else {
    await db.prepare("UPDATE login_attempts SET count = count + 1 WHERE ip = ?").bind(ip).run();
  }
}

function clientIP(request) {
  return (request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown").slice(0, 64);
}

// ---------- 常量与工具 ----------

const DEFAULT_SETTINGS = {
  store_name: "青禾轻食·大学城店",
  app_title: "轻排班",
  brand_avatar: "",
  rest_minutes_min: "600",
  daily_max_minutes_fulltime: "600",
  daily_max_minutes_parttime: "480",
  weekly_max_minutes_fulltime: "2640",
  weekly_max_minutes_parttime: "1440",
};
const MINUTE_KEYS = ["rest_minutes_min", "daily_max_minutes_fulltime",
  "daily_max_minutes_parttime", "weekly_max_minutes_fulltime", "weekly_max_minutes_parttime"];
const AVATAR_MAX_BYTES = 200 * 1024; // Workers 版上限：data URL 存 D1
const TIME_RE = /^\d{2}:\d{2}$/;
const AVATAR_MAGIC = [
  [".png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  [".jpg", [0xff, 0xd8, 0xff]],
  [".gif", [0x47, 0x49, 0x46, 0x38]],
  [".webp", [0x52, 0x49, 0x46, 0x46]],
];

const ICONS = {
  "dashboard": "<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"2\" fill=\"currentColor\" stroke=\"none\"/>",
  "calendar": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15.5\" rx=\"3\"/><path d=\"M8 3v4M16 3v4\"/><path d=\"M3.5 10h17\"/><rect x=\"6.5\" y=\"13\" width=\"5\" height=\"2.6\" rx=\"1.3\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"13.8\" y=\"13\" width=\"3.7\" height=\"2.6\" rx=\"1.3\"/>",
  "users": "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M3.5 20c0-3.1 2.4-5.2 5.5-5.2s5.5 2.1 5.5 5.2\"/><path d=\"M15.5 4.9a3.5 3.5 0 0 1 0 6.2\"/><path d=\"M17.5 15.2c2 .7 3.3 2.4 3.3 4.8\"/>",
  "briefcase": "<rect x=\"3.5\" y=\"7.5\" width=\"17\" height=\"12.5\" rx=\"3\"/><path d=\"M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5\"/><rect x=\"7\" y=\"12.2\" width=\"10\" height=\"3\" rx=\"1.5\" fill=\"currentColor\" stroke=\"none\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3.2 1.8\"/>",
  "chart": "<path d=\"M4 4v16h16\"/><rect x=\"7.5\" y=\"12.5\" width=\"3.2\" height=\"7.5\" rx=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"12.4\" y=\"8\" width=\"3.2\" height=\"12\" rx=\"1.6\" fill=\"currentColor\" stroke=\"none\"/><rect x=\"17.3\" y=\"10.5\" width=\"3.2\" height=\"9.5\" rx=\"1.6\" fill=\"currentColor\" stroke=\"none\"/>",
  "sliders": "<path d=\"M4 7h6.2M14.8 7H20\"/><circle cx=\"12.5\" cy=\"7\" r=\"2.3\"/><path d=\"M4 17h4.2M12.8 17H20\"/><circle cx=\"10.5\" cy=\"17\" r=\"2.3\"/>",
  "download": "<path d=\"M4.5 15.5V18a2.5 2.5 0 0 0 2.5 2.5h10A2.5 2.5 0 0 0 19.5 18v-2.5\"/><path d=\"M12 4v10.5M7.8 10.7 12 15l4.2-4.3\"/>",
  "copy": "<rect x=\"8\" y=\"8\" width=\"11.5\" height=\"11.5\" rx=\"2.5\"/><path d=\"M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8\"/>",
  "plus": "<path d=\"M12 5v14M5 12h14\"/>",
  "user-plus": "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M3.5 20c0-3.1 2.4-5.2 5.5-5.2 1.6 0 3 .6 4 1.6\"/><path d=\"M18.5 10.5v6M15.5 13.5h6\"/>",
  "edit": "<path d=\"M4.5 19.5h3.2L19 8.2a2.26 2.26 0 0 0-3.2-3.2L4.5 16.3z\"/><path d=\"m13.6 7.2 3.2 3.2\"/>",
  "trash": "<path d=\"M4.5 6.8h15\"/><path d=\"M9.3 6.5V5.2A1.7 1.7 0 0 1 11 3.5h2a1.7 1.7 0 0 1 1.7 1.7v1.3\"/><path d=\"m6.3 6.8.7 12a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l.7-12\"/><path d=\"M10 10.5v6M14 10.5v6\"/>",
  "alert": "<path d=\"M10.4 4.2 3.2 17.4a1.9 1.9 0 0 0 1.7 2.8h14.2a1.9 1.9 0 0 0 1.7-2.8L13.6 4.2a1.9 1.9 0 0 0-3.2 0z\"/><path d=\"M12 9.2v4\"/><circle cx=\"12\" cy=\"16.4\" r=\"0.7\" fill=\"currentColor\" stroke=\"none\"/>",
  "check-circle": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"m8.3 12.3 2.6 2.6 4.9-5.3\"/>",
  "x-circle": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6\"/>",
  "info": "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 11v5\"/><circle cx=\"12\" cy=\"7.8\" r=\"0.7\" fill=\"currentColor\" stroke=\"none\"/>",
  "x": "<path d=\"M6 6l12 12M18 6 6 18\"/>",
  "chevron-left": "<polyline points=\"14.5 5.5 8 12l6.5 6.5\"/>",
  "chevron-right": "<polyline points=\"9.5 5.5 16 12l-6.5 6.5\"/>",
  "save": "<path d=\"M19.5 9.2V18a1.8 1.8 0 0 1-1.8 1.8H6.3A1.8 1.8 0 0 1 4.5 18V6.3a1.8 1.8 0 0 1 1.8-1.8h8.7z\"/><path d=\"M8 4.5v4.2h6.5V4.5\"/><path d=\"M8 19.8v-5.6h8v5.6\"/>",
  "database": "<ellipse cx=\"12\" cy=\"5.8\" rx=\"7.5\" ry=\"2.8\"/><path d=\"M4.5 5.8v12.4c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5.8\"/><path d=\"M4.5 12c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8\"/>",
  "refresh": "<path d=\"M20 12a8 8 0 1 1-2.4-5.7\"/><path d=\"M20 4.5V9h-4.5\"/>",
  "logout": "<path d=\"M9 21H5.5A1.8 1.8 0 0 1 3.7 19.2V4.8A1.8 1.8 0 0 1 5.5 3H9\"/><polyline points=\"16 17 21 12 16 7\"/><path d=\"M21 12H9\"/>"
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function attrJSON(obj) {
  return esc(JSON.stringify(obj));
}

/** 页面“今天”（东八区），格式 YYYY-MM-DD。 */
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function addDays(dateISO, days) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ---------- 数据访问 ----------

async function loadSettings(db) {
  const merged = { ...DEFAULT_SETTINGS };
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  for (const row of results) merged[row.key] = row.value;
  for (const key of MINUTE_KEYS) {
    const n = parseInt(merged[key], 10);
    merged[key] = Number.isInteger(n) ? n : parseInt(DEFAULT_SETTINGS[key], 10);
  }
  return merged;
}

async function saveSettings(db, values) {
  const stmts = Object.entries(values).map(([key, value]) =>
    db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, String(value)));
  await db.batch(stmts);
}

function parseAvailableDays(text) {
  try {
    const arr = JSON.parse(text || "[]");
    return arr.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  } catch { return []; }
}

async function loadEmployees(db, activeOnly = false) {
  const sql = "SELECT * FROM employees" + (activeOnly ? " WHERE status = 'active'" : "") +
    " ORDER BY employment_type DESC, name";
  const { results } = await db.prepare(sql).all();
  return results.map((r) => ({ ...r, available_day_list: parseAvailableDays(r.available_days) }));
}

async function fetchSchedules(db, startISO, endISO) {
  const { results } = await db.prepare(
    `SELECT s.*, e.name AS employee_name, e.employment_type,
            t.name AS template_name, t.color AS template_color
     FROM schedules s
     JOIN employees e ON e.id = s.employee_id
     LEFT JOIN shift_templates t ON t.id = s.template_id
     WHERE s.work_date >= ? AND s.work_date <= ?
     ORDER BY s.work_date, s.start_time, s.id`).bind(startISO, endISO).all();
  return results;
}

/** 一周冲突（含展示层去重，与 Python week_conflicts 逻辑一致）。 */
async function weekConflicts(db, startISO, endISO, settings) {
  const employees = new Map((await loadEmployees(db)).map((e) => [e.id, e]));
  const rows = await fetchSchedules(db, addDays(startISO, -2), addDays(endISO, 2));
  const byEmployee = new Map();
  for (const row of rows) {
    if (!byEmployee.has(row.employee_id)) byEmployee.set(row.employee_id, []);
    byEmployee.get(row.employee_id).push(row);
  }
  const results = [];
  const seenDaily = new Set(), seenWeekly = new Set(), seenRest = new Set();
  for (const row of rows) {
    if (row.work_date < startISO || row.work_date > endISO) continue;
    const emp = employees.get(row.employee_id);
    if (!emp) continue;
    const found = checkConflicts(
      { id: row.id, work_date: row.work_date, start_time: row.start_time,
        end_time: row.end_time, break_minutes: row.break_minutes },
      byEmployee.get(row.employee_id).filter((r) => r.id !== row.id),
      { employment_type: emp.employment_type, availableDays: new Set(emp.available_day_list),
        available_from: emp.available_from, available_to: emp.available_to },
      settings);
    for (const c of found) {
      if (c.rule === "daily_limit") {
        const key = `${row.employee_id}|${row.work_date}`;
        if (seenDaily.has(key)) continue;
        seenDaily.add(key);
      } else if (c.rule === "weekly_limit") {
        const [ws] = weekRange(row.work_date);
        const key = `${row.employee_id}|${ws}`;
        if (seenWeekly.has(key)) continue;
        seenWeekly.add(key);
      } else if (c.rule === "rest") {
        const key = `${row.employee_id}|${[row.id, c.related_schedule_id].sort((a, b) => a - b).join("-")}`;
        if (seenRest.has(key)) continue;
        seenRest.add(key);
      }
      results.push({
        schedule_id: row.id, employee_name: emp.name, date: row.work_date,
        weekday: WEEKDAY_NAMES[isoWeekday(row.work_date)],
        time: `${row.start_time}–${row.end_time}`,
        ...c,
      });
    }
  }
  const order = { error: 0, warning: 1 };
  results.sort((a, b) => (a.date === b.date
    ? order[a.severity] - order[b.severity]
    : (a.date < b.date ? -1 : 1)));
  return results;
}

// ---------- 页面骨架 ----------

const NAV_ITEMS = [
  ["dashboard", "/", "dashboard", "概览"],
  ["schedule", "/schedule", "calendar", "排班"],
  ["employees", "/employees", "users", "员工"],
  ["shift_templates", "/shift-templates", "briefcase", "班次模板"],
  ["hours", "/hours", "chart", "工时统计"],
  ["settings", "/settings", "sliders", "设置"],
];

const DEFAULT_FAVICON = "/static/icons/favicon.svg";

function layout(ctx, opts) {
  const { title, endpoint, actions = "", content, scripts = "" } = opts;
  const flash = ctx.url.searchParams.get("m");
  const flashType = ctx.url.searchParams.get("t") || "info";
  const nav = NAV_ITEMS.map(([ep, href, ic, label]) =>
    `<a class="nav-item${ctx.endpoint === ep ? " active" : ""}" href="${href}"${ctx.endpoint === ep ? ' aria-current="page"' : ""}>${icon(ic)}<span>${label}</span></a>`).join("");
  const favicon = ctx.brand_avatar || DEFAULT_FAVICON;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(ctx.app_title)}</title>
<link rel="stylesheet" href="/static/css/theme.css">
<link rel="icon" href="${favicon}">
</head>
<body data-page="${esc(endpoint)}">
<div class="app">
  <aside class="nav-rail">
    <a class="brand" href="/">
      <span class="brand-mark">${ctx.brand_avatar ? `<img class="brand-avatar" src="${ctx.brand_avatar}" alt="品牌头像">` : esc(ctx.app_title.slice(0, 1))}</span>
      <span class="brand-name">${esc(ctx.app_title)}</span>
    </a>
    <nav class="nav-items">${nav}</nav>
    <div class="nav-footer">
      <form method="post" action="/logout" class="logout-form">
        <button type="submit" class="nav-logout" title="退出登录">${icon("logout")}退出登录</button>
      </form>
      <span class="version">v1.0 · Cloudflare</span>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <h1 class="topbar-title">${esc(title)}</h1>
      <div class="topbar-actions">${actions}</div>
    </header>
    <main class="content" id="main">${content}</main>
  </div>
</div>
<div id="snackbar" class="snackbar" role="status" aria-live="polite"></div>
${flash ? `<script id="flash-data" type="application/json">[{"category":"${esc(flashType)}","message":"${esc(flash)}"}]</script>` : ""}
<script src="/static/js/app.js"></script>
${scripts}
</body>
</html>`;
}

function btn(html, cls = "btn-filled") {
  return `<button class="btn ${cls}" ${html.startsWith("<form") ? "" : ""}>${html}</button>`;
}

function redirectFlash(url, message, type = "success") {
  const sep = url.includes("?") ? "&" : "?";
  return new Response(null, {
    status: 303,
    headers: { Location: `${url}${sep}m=${encodeURIComponent(message)}&t=${encodeURIComponent(type)}` },
  });
}

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", ...headers } });
}

// ---------- 页面：概览 ----------

async function pageDashboard(ctx) {
  const today = todayISO();
  const [ws, we] = weekRange(today);
  const [ms, me] = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  const employees = await loadEmployees(ctx.db, true);
  const weekRows = await fetchSchedules(ctx.db, ws, we);
  const conflicts = await weekConflicts(ctx.db, ws, we, ctx.settings);
  const summary = summarize(weekRows, ws, we);
  const weekMinutes = summary.reduce((s, i) => s + i.effective_minutes, 0);
  const errors = conflicts.filter((c) => c.severity === "error");
  const warnings = conflicts.filter((c) => c.severity === "warning");
  const monthRows = await fetchSchedules(ctx.db, ms, me);
  const todayRows = weekRows.filter((r) => r.work_date === today).sort((a, b) => (a.start_time < b.start_time ? -1 : 1));

  const todayList = todayRows.length ? `<div class="today-list">${todayRows.map((r) => `
      <div class="today-item">
        <span class="t-time">${esc(r.start_time)}–${esc(r.end_time)}</span>
        <span class="t-who">${esc(r.employee_name)}</span>
        ${r.position ? `<span class="t-pos">${esc(r.position)}</span>` : ""}
        ${r.template_name ? `<span class="chip chip-neutral">${esc(r.template_name)}</span>` : ""}
        <span class="spacer"></span>
        <span class="t-pos">休息 ${r.break_minutes} 分钟</span>
      </div>`).join("")}</div>`
    : `<div class="empty-state">${icon("calendar")}<p>今天暂无排班。</p><a class="btn btn-tonal btn-sm" href="/schedule?date=${today}">现在安排</a></div>`;

  const allConflicts = [...errors, ...warnings];
  const conflictList = allConflicts.length
    ? `<div class="conflict-list">${allConflicts.slice(0, 5).map((c) => `
      <a class="conflict-item sev-${c.severity} clickable" href="/schedule?date=${c.date}&focus=${c.schedule_id}"
         aria-label="前往排班页定位该冲突">
        ${c.severity === "error" ? icon("x-circle") : icon("alert")}
        <div>
          <div class="c-text"><span class="c-rule">${esc(c.rule_label)}</span>${esc(c.message)}</div>
          <div class="c-meta">${c.date}（${c.weekday}）· ${esc(c.employee_name)} · ${esc(c.time)}</div>
        </div>
      </a>`).join("")}
      ${allConflicts.length > 5 ? `<a class="small" href="/schedule">还有 ${allConflicts.length - 5} 条，前往排班页查看全部 →</a>` : ""}
      <p class="small muted" style="margin:10px 2px 0;">点击提示可跳转到排班页并高亮对应班次。</p></div>`
    : `<div class="empty-state">${icon("check-circle")}<p>本周排班无冲突，安排合理。</p></div>`;

  const content = `
<div class="stat-grid">
  <div class="stat-card"><div class="stat-label">${icon("calendar")}本周排班班次</div>
    <div class="stat-value">${weekRows.length}<span class="unit">班</span></div>
    <div class="stat-hint">${ws} ~ ${we}</div></div>
  <div class="stat-card"><div class="stat-label">${icon("users")}在职员工</div>
    <div class="stat-value">${employees.length}<span class="unit">人</span></div>
    <div class="stat-hint">全职 / 兼职均计</div></div>
  <div class="stat-card"><div class="stat-label">${icon("clock")}本周有效工时</div>
    <div class="stat-value">${hours(weekMinutes)}<span class="unit">小时</span></div>
    <div class="stat-hint">已扣除班内休息</div></div>
  <div class="stat-card${errors.length ? " tone-error" : ""}"><div class="stat-label">${icon("alert")}待处理冲突</div>
    <div class="stat-value">${errors.length}<span class="unit">项错误</span></div>
    <div class="stat-hint">另有 ${warnings.length} 项工时提示</div></div>
</div>
<div class="page-grid-2">
  <div class="card">
    <div class="card-title"><h2>今日排班 · ${today}（${WEEKDAY_NAMES[isoWeekday(today)]}）</h2>
      <a class="btn btn-text btn-sm" href="/schedule?date=${today}">查看全周</a></div>
    ${todayList}
  </div>
  <div class="card">
    <div class="card-title"><h2>本周冲突提示</h2><a class="btn btn-text btn-sm" href="/schedule">去处理</a></div>
    ${conflictList}
  </div>
</div>
<div class="card"><div class="card-title"><h2>快捷入口</h2></div>
  <div style="display:flex; gap:10px; flex-wrap:wrap;">
    <a class="btn btn-tonal" href="/employees">${icon("user-plus")}维护员工</a>
    <a class="btn btn-tonal" href="/shift-templates">${icon("briefcase")}配置班次模板</a>
    <a class="btn btn-tonal" href="/hours">${icon("chart")}查看工时统计</a>
    <a class="btn btn-tonal" href="/export/schedule?date=${today}">${icon("download")}导出本周排班表</a>
    <a class="btn btn-tonal" href="/settings">${icon("sliders")}调整排班规则</a>
  </div>
</div>`;

  return layout(ctx, { title: "概览", endpoint: "dashboard", content });
}

// ---------- 页面：排班 ----------

async function pageSchedule(ctx) {
  const today = todayISO();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get("date") || "")
    ? ctx.url.searchParams.get("date") : today;
  const [ws, we] = weekRange(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const employees = await loadEmployees(ctx.db, true);
  const templates = (await ctx.db.prepare("SELECT * FROM shift_templates ORDER BY start_time").all()).results;
  const rows = await fetchSchedules(ctx.db, ws, we);
  const conflicts = await weekConflicts(ctx.db, ws, we, ctx.settings);
  const activeIds = new Set(employees.map((employee) => employee.id));
  const inactiveIds = [...new Set(rows.filter((row) => !activeIds.has(row.employee_id))
    .map((row) => row.employee_id))];
  let inactiveEmployees = [];
  if (inactiveIds.length) {
    const placeholders = inactiveIds.map(() => "?").join(",");
    inactiveEmployees = (await ctx.db.prepare(
      `SELECT * FROM employees WHERE id IN (${placeholders}) ORDER BY name`)
      .bind(...inactiveIds).all()).results;
  }
  const gridEmployees = employees.concat(inactiveEmployees);

  const grid = new Map();
  const employeeWeekMinutes = new Map(gridEmployees.map((employee) => [employee.id, 0]));
  const dayStaff = new Map(days.map((day) => [day, new Set()]));
  const dayShiftCounts = new Map(days.map((day) => [day, 0]));
  for (const row of rows) {
    const key = `${row.employee_id}|${row.work_date}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(row);
    employeeWeekMinutes.set(row.employee_id,
      (employeeWeekMinutes.get(row.employee_id) || 0) +
      effectiveMinutes(row.start_time, row.end_time, row.break_minutes));
    dayStaff.get(row.work_date).add(row.employee_id);
    dayShiftCounts.set(row.work_date, dayShiftCounts.get(row.work_date) + 1);
  }
  const conflictBySchedule = new Map();
  for (const c of conflicts) {
    if (!conflictBySchedule.has(c.schedule_id)) conflictBySchedule.set(c.schedule_id, []);
    conflictBySchedule.get(c.schedule_id).push(c);
  }

  const headerCells = `<div class="gh">员工</div>` + days.map((d) =>
    `<div class="gh${d === today ? " today" : ""}"><span>${WEEKDAY_NAMES[isoWeekday(d)]}<span class="d-num">${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}</span>${d === today ? '<span class="d-num">·今天</span>' : ""}</span><span class="d-staff">${dayStaff.get(d).size} 人 · ${dayShiftCounts.get(d)} 班</span></div>`).join("");

  const bodyRows = gridEmployees.map((emp) => {
    const cells = days.map((d) => {
      const shifts = grid.get(`${emp.id}|${d}`) ?? [];
      const chips = shifts.map((r) => {
        const clist = conflictBySchedule.get(r.id) ?? [];
        const hasError = clist.some((c) => c.severity === "error");
        const flag = clist.length
          ? `<span class="conflict-flag ${hasError ? "has-error" : "has-warning"}" title="${esc(clist.map((c) => c.message).join("；"))}">${icon("alert")}</span>`
          : "";
        const data = attrJSON({ id: r.id, employee_id: r.employee_id, employee_name: r.employee_name,
          work_date: r.work_date, template_id: r.template_id, start_time: r.start_time,
          end_time: r.end_time, break_minutes: r.break_minutes, position: r.position || "", note: r.note || "" });
        return `<button type="button" id="shift-${r.id}" class="shift-chip c-${r.template_color || "primary"}" data-shift-edit
          data-emp="${data}">
          <span class="dot"></span><span><span class="t">${esc(r.start_time)}–${esc(r.end_time)}</span>
          <span class="meta">${esc(r.template_name || "自定义")}${r.position ? ` · ${esc(r.position)}` : ""}</span></span>${flag}</button>`;
      }).join("");
      const activeAttrs = emp.status === "active"
        ? ` tabindex="0" role="button" aria-label="${esc(emp.name)} ${d} 新增班次" data-cell-employee="${emp.id}" data-cell-date="${d}" data-cell-name="${esc(emp.name)}"`
        : "";
      return `<div class="cell${d === today ? " today-col" : ""}${emp.status !== "active" ? " readonly-cell" : ""}"${activeAttrs}>
        ${chips}<span class="plus-hint">${icon("plus")}</span></div>`;
    }).join("");
    return `<div class="emp${emp.status !== "active" ? " is-inactive" : ""}"><span class="e-name">${esc(emp.name)}${emp.status !== "active" ? '<span class="inactive-mark">停用</span>' : ""}</span>
      <span class="e-meta">${esc(emp.position || "未设岗位")} · ${emp.employment_type === "fulltime" ? "全职" : "兼职"}</span>
      <span class="e-hours">本周 ${hours(employeeWeekMinutes.get(emp.id) || 0)} h</span></div>${cells}`;
  }).join("");

  const errCount = conflicts.filter((c) => c.severity === "error").length;
  const warnCount = conflicts.length - errCount;
  const panel = conflicts.length
    ? `<p class="small muted" style="margin:0 0 10px;">点击任意提示可定位并高亮对应班次；点击右上角“错误/提示”可折叠类别。</p>
       <div class="conflict-list">${conflicts.map((c) => `
      <div class="conflict-item sev-${c.severity} clickable" role="button" tabindex="0"
           data-locate="${c.schedule_id}" data-severity="${c.severity}"
           aria-label="定位到 ${esc(c.employee_name)} ${c.date} ${esc(c.time)} 的班次">
        ${c.severity === "error" ? icon("x-circle") : icon("alert")}
        <div><div class="c-text"><span class="c-rule">${esc(c.rule_label)}</span>${esc(c.message)}</div>
        <div class="c-meta">${c.date}（${c.weekday}）· ${esc(c.employee_name)} · ${esc(c.time)}</div></div>
      </div>`).join("")}</div>`
    : `<div class="empty-state">${icon("check-circle")}<p>本周未检测到冲突。排班规则可在“设置”页调整。</p></div>`;

  const dialog = `
<dialog id="shift-dialog" class="dialog">
  <form id="shift-form" novalidate>
    <input type="hidden" id="sf-id" value="">
    <div class="dialog-head"><h2 id="sf-title">新增班次</h2>
      <button type="button" class="icon-btn" data-dialog-close aria-label="关闭">${icon("x")}</button></div>
    <div class="dialog-body">
      <div class="field"><label>员工</label>
        <div style="display:flex; gap:10px; align-items:center;">
          <select id="sf-employee" required>${gridEmployees.map((e) =>
            `<option value="${e.id}"${e.status !== "active" ? " disabled" : ""}>${esc(e.name)}（${e.employment_type === "fulltime" ? "全职" : "兼职"}${e.position ? ` · ${esc(e.position)}` : ""}${e.status !== "active" ? " · 已停用" : ""}）</option>`).join("")}</select>
          <span class="muted small" id="sf-employee-name"></span></div></div>
      <div class="field-row">
        <div class="field"><label for="sf-date">日期</label><input type="date" id="sf-date" required></div>
        <div class="field"><label for="sf-template">班次模板（可选）</label>
          <select id="sf-template"><option value="">自定义时间</option>${templates.map((t) =>
            `<option value="${t.id}">${esc(t.name)}（${t.start_time}–${t.end_time}）</option>`).join("")}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="sf-start">开始时间</label><input type="time" id="sf-start" required></div>
        <div class="field"><label for="sf-end">结束时间</label><input type="time" id="sf-end" required>
          <span class="hint">结束时间不晚于开始时间表示次日结束（跨日班次）</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="sf-break">班内休息（分钟）</label><input type="number" id="sf-break" min="0" max="720" step="5" value="0"></div>
        <div class="field"><label for="sf-position">岗位（可选）</label><input type="text" id="sf-position" placeholder="如：前厅"></div>
      </div>
      <div class="field"><label for="sf-note">备注（可选）</label><input type="text" id="sf-note" placeholder="如：高峰支援"></div>
      <div id="sf-errors" class="field-error" style="display:none;"></div>
      <div id="sf-conflicts" class="conflict-box" style="display:none;">
        <h3>${icon("alert")}检测到以下冲突</h3>
        <ul id="sf-conflict-list"></ul>
        <p class="small muted" style="margin:8px 0 0;">错误级冲突建议返回修改；如确属门店安排，可选择“仍要保存”。</p>
      </div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-danger-tonal" id="sf-delete" style="display:none;">删除</button>
      <button type="button" class="btn btn-text" data-dialog-close>取消</button>
      <button type="button" class="btn btn-tonal" id="sf-force" style="display:none;">仍要保存</button>
      <button type="submit" class="btn btn-filled" id="sf-submit">保存</button>
    </div>
  </form>
</dialog>`;

  const content = `
<div class="sched-toolbar">
  <div class="sched-nav">
    <a class="icon-btn" href="/schedule?date=${addDays(ws, -7)}" aria-label="上一周">${icon("chevron-left")}</a>
    <a class="btn btn-text btn-sm" href="/schedule?date=${today}">本周</a>
    <a class="icon-btn" href="/schedule?date=${addDays(ws, 7)}" aria-label="下一周">${icon("chevron-right")}</a>
    <span class="week-title">${ws} ~ ${we}
      <span class="sub">${ws.slice(5, 7) === we.slice(5, 7) ? "本月" : `${Number(ws.slice(5, 7))}月 ~ ${Number(we.slice(5, 7))}月`}</span></span>
  </div>
  <span class="muted small">点击空白格新增班次，点击班次芯片可调整或删除</span>
</div>
<div class="sched-scroll"><div class="sched-grid">${headerCells}${bodyRows}</div></div>
<div class="scroll-x-hint" data-scroll-hint=".sched-scroll">${icon("chevron-left")}左右滑动查看完整一周${icon("chevron-right")}</div>
<div class="card cv-auto" style="margin-top:16px;">
  <div class="card-title"><h2>本周冲突与工时提示</h2>
    <span class="sub conflict-filters">
      <button type="button" class="chip chip-error chip-toggle" data-conflict-filter="error" aria-pressed="true"
        aria-label="显示或折叠错误级冲突">${icon("x-circle")}错误 ${errCount}</button>
      <button type="button" class="chip chip-warning chip-toggle" data-conflict-filter="warning" aria-pressed="true"
        aria-label="显示或折叠提示级冲突" style="margin-left:8px;">${icon("alert")}提示 ${warnCount}</button></span></div>
  ${panel}
</div>
${dialog}`;

  const scripts = `<script>window.SHIFTLITE_TEMPLATES = ${JSON.stringify(
    templates.map((t) => ({ id: t.id, name: t.name, start_time: t.start_time,
      end_time: t.end_time, break_minutes: t.break_minutes, position: t.position })))};</script>
<script src="/static/js/schedule.js"></script>`;
  const actions = `<button type="button" class="btn btn-tonal" id="copy-prev-week" data-target-date="${ws}">${icon("copy")}复制上周</button>
    <a class="btn btn-outlined" href="/export/schedule?date=${anchor}">${icon("download")}导出本周排班表</a>`;
  return layout(ctx, { title: "排班", endpoint: "schedule", actions, content, scripts });
}

// ---------- 页面：员工 ----------

function weekdayCheckboxes(names, selected) {
  return [1, 2, 3, 4, 5, 6, 7].map((i) => `
    <label class="check-chip"><input type="checkbox" name="available_days" value="${i}"${selected.includes(i) ? " checked" : ""}><span>${WEEKDAY_NAMES[i]}</span></label>`).join("");
}

async function pageEmployees(ctx) {
  const rows = await loadEmployees(ctx.db);
  const { results: counts } = await ctx.db.prepare(
    "SELECT employee_id, COUNT(*) AS n FROM schedules GROUP BY employee_id").all();
  const countMap = new Map(counts.map((r) => [r.employee_id, r.n]));

  const table = rows.length ? `<div class="table-wrap cv-auto"><table class="data-table table-cards">
    <thead><tr><th>员工</th><th>岗位</th><th>联系方式</th><th>可用时间</th><th>状态</th><th>排班记录</th><th style="width:108px;">操作</th></tr></thead>
    <tbody>${rows.map((e) => {
      const days = e.available_day_list.map((d) => WEEKDAY_NAMES[d]).join("、") || "未设置";
      const muted = e.status !== "active" ? ` class="row-muted"` : "";
      return `<tr${muted}>
      <td data-label="员工"><div class="emp-cell"><span class="emp-avatar tint-${["a", "b", "c"][e.id % 3]}" aria-hidden="true">${esc(e.name.slice(0, 1))}</span>
        <div><div class="emp-name"><strong>${esc(e.name)}</strong></div>${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ""}</div></div></td>
      <td data-label="岗位">${e.position ? `<span class="pos-strong">${esc(e.position)}</span>` : `<span class="muted">—</span>`}
        <span class="chip chip-sm ${e.employment_type === "fulltime" ? "chip-primary" : "chip-secondary"}">${e.employment_type === "fulltime" ? "全职" : "兼职"}</span></td>
      <td data-label="联系方式" class="small muted">${esc(e.phone) || "—"}</td>
      <td data-label="可用时间" class="small">${esc(days)}
        <div class="muted">${e.available_from && e.available_to ? `${e.available_from}–${e.available_to}` : "不限"}</div></td>
      <td data-label="状态">${e.status === "active"
        ? `<span class="chip chip-success">${icon("check-circle")}在职</span>`
        : `<span class="chip chip-neutral">${icon("x-circle")}离职</span>`}</td>
      <td data-label="排班记录" class="small muted">${countMap.get(e.id) ?? 0} 条</td>
      <td data-label="操作"><div class="row-actions"><button class="icon-btn" title="编辑" aria-label="编辑员工 ${esc(e.name)}" data-dialog-open="employee-dialog" data-dialog-fill="fillEmployeeDialog"
        data-emp='${attrJSON({ id: e.id, name: e.name, position: e.position, employment_type: e.employment_type,
          phone: e.phone, available_days: e.available_day_list, available_from: e.available_from,
          available_to: e.available_to, status: e.status, note: e.note })}'>${icon("edit")}</button>
        <form method="post" action="/employees" data-confirm="确定删除员工“${esc(e.name)}”吗？已有排班记录的员工将被停用而非删除。">
          <input type="hidden" name="action" value="delete"><input type="hidden" name="id" value="${e.id}">
          <button class="icon-btn danger" title="删除" aria-label="删除员工 ${esc(e.name)}">${icon("trash")}</button></form></div></td></tr>`;
    }).join("")}</tbody></table></div>`
    : `<div class="empty-state">${icon("users")}<p>还没有员工，先添加第一位成员吧。</p>
       <button class="btn btn-filled" data-dialog-open="employee-dialog" data-dialog-fill="fillEmployeeDialog">${icon("plus")}新增员工</button></div>`;

  const dialog = `
<dialog id="employee-dialog" class="dialog large">
  <form method="post" action="/employees" novalidate>
    <div class="dialog-head"><h2 id="ed-title">新增员工</h2>
      <button type="button" class="icon-btn" data-dialog-close aria-label="关闭">${icon("x")}</button></div>
    <div class="dialog-body">
      <input type="hidden" name="action" id="ed-action" value="create">
      <input type="hidden" name="id" id="ed-id" value="">
      <div class="field-row">
        <div class="field"><label for="ed-name">姓名 *</label><input type="text" id="ed-name" name="name" required maxlength="20" placeholder="如：王小明"></div>
        <div class="field"><label for="ed-position">岗位</label><input type="text" id="ed-position" name="position" maxlength="20" placeholder="如：前厅"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ed-type">用工类型</label>
          <select id="ed-type" name="employment_type"><option value="fulltime">全职</option><option value="parttime">兼职</option></select>
          <span class="hint">类型决定适用的每日/每周工时上限规则</span></div>
        <div class="field"><label for="ed-phone">联系电话</label><input type="tel" id="ed-phone" name="phone" maxlength="20" placeholder="选填"></div>
      </div>
      <div class="field"><label>可排班日（不勾选视为均可）</label>
        <div class="check-group" id="ed-days">${weekdayCheckboxes(WEEKDAY_NAMES, [1, 2, 3, 4, 5])}</div></div>
      <div class="field-row">
        <div class="field"><label for="ed-from">每日可用开始时间</label><input type="time" id="ed-from" name="available_from">
          <span class="hint">留空表示不限；用于可用时间冲突检测</span></div>
        <div class="field"><label for="ed-to">每日可用结束时间</label><input type="time" id="ed-to" name="available_to"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ed-status">在职状态</label>
          <select id="ed-status" name="status"><option value="active">在职</option><option value="inactive">离职（停用）</option></select></div>
        <div class="field"><label for="ed-note">备注</label><input type="text" id="ed-note" name="note" maxlength="50" placeholder="选填"></div>
      </div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-text" data-dialog-close>取消</button>
      <button type="submit" class="btn btn-filled">${icon("save")}保存</button>
    </div>
  </form>
</dialog>`;

  const content = `
<div class="card">
  <div class="card-title"><h2>员工列表</h2>
    <span class="sub">在职 ${rows.filter(r => r.status === "active").length} 人${rows.length > rows.filter(r => r.status === "active").length ? `，离职 ${rows.length - rows.filter(r => r.status === "active").length} 人` : ""}；岗位与可用时间用于排班冲突检测</span></div>
  ${table}
</div>
${dialog}`;

  const scripts = `<script>
  function fillEmployeeDialog(btn) {
    var data = btn.getAttribute("data-emp");
    var form = document.getElementById("employee-dialog").querySelector("form");
    form.reset();
    document.getElementById("ed-action").value = "create";
    document.getElementById("ed-id").value = "";
    document.getElementById("ed-title").textContent = "新增员工";
    if (!data) return;
    var e = JSON.parse(data);
    document.getElementById("ed-action").value = "update";
    document.getElementById("ed-id").value = e.id;
    document.getElementById("ed-title").textContent = "编辑员工 · " + e.name;
    document.getElementById("ed-name").value = e.name || "";
    document.getElementById("ed-position").value = e.position || "";
    document.getElementById("ed-type").value = e.employment_type || "fulltime";
    document.getElementById("ed-phone").value = e.phone || "";
    document.querySelectorAll("#ed-days input").forEach(function (cb) { cb.checked = false; });
    (e.available_days || []).forEach(function (d) {
      var cb = document.querySelector('#ed-days input[value="' + d + '"]');
      if (cb) cb.checked = true;
    });
    document.getElementById("ed-from").value = e.available_from || "";
    document.getElementById("ed-to").value = e.available_to || "";
    document.getElementById("ed-status").value = e.status || "active";
    document.getElementById("ed-note").value = e.note || "";
  }
  </script>`;
  return layout(ctx, {
    title: "员工管理", endpoint: "employees", content, scripts,
    actions: `<button class="btn btn-filled" data-dialog-open="employee-dialog" data-dialog-fill="fillEmployeeDialog">${icon("user-plus")}新增员工</button>`,
  });
}

// ---------- 页面：班次模板 ----------

const COLOR_LABELS = { primary: "主色", secondary: "次要", tertiary: "强调", warning: "夜班" };

async function pageTemplates(ctx) {
  const templates = (await ctx.db.prepare("SELECT * FROM shift_templates ORDER BY start_time").all()).results;
  const { results: usage } = await ctx.db.prepare(
    "SELECT template_id, COUNT(*) AS n FROM schedules WHERE template_id IS NOT NULL GROUP BY template_id").all();
  const usageMap = new Map(usage.map((r) => [r.template_id, r.n]));

  const table = templates.length ? `<div class="table-wrap"><table class="data-table table-cards">
    <thead><tr><th>班次名称</th><th>时段</th><th>班内休息</th><th class="col-eff">有效工时</th><th>建议岗位</th><th class="col-color">配色</th><th>使用次数</th><th style="width:108px;">操作</th></tr></thead>
    <tbody>${templates.map((t) => {
      let span = 0;
      try { span = shiftSpanMinutes(t.start_time, t.end_time); } catch { span = 0; }
      return `<tr>
      <td data-label="班次"><strong>${esc(t.name)}</strong>${t.note ? `<div class="small muted">${esc(t.note)}</div>` : ""}</td>
      <td data-label="时段">${t.start_time}–${t.end_time}${t.end_time <= t.start_time ? ' <span class="chip chip-neutral small">跨日</span>' : ""}</td>
      <td data-label="班内休息">${t.break_minutes} 分钟</td>
      <td data-label="有效工时" class="small muted col-eff">${Math.round((span / 60) * 10) / 10} 小时</td>
      <td data-label="建议岗位">${esc(t.position) || "—"}</td>
      <td data-label="配色" class="col-color"><span class="chip chip-${t.color}">${COLOR_LABELS[t.color] ?? t.color}</span></td>
      <td data-label="使用次数" class="small muted">${usageMap.get(t.id) ?? 0} 条排班</td>
      <td data-label="操作"><div class="row-actions"><button class="icon-btn" title="编辑" aria-label="编辑模板 ${esc(t.name)}" data-dialog-open="template-dialog" data-dialog-fill="fillTemplateDialog"
        data-tpl='${attrJSON(t)}'>${icon("edit")}</button>
        <form method="post" action="/shift-templates/${t.id}/delete"
          data-confirm="确定删除模板“${esc(t.name)}”吗？历史排班数据会保留。">
          <button class="icon-btn danger" title="删除" aria-label="删除模板 ${esc(t.name)}">${icon("trash")}</button></form></div></td></tr>`;
    }).join("")}</tbody></table></div>
    <div class="scroll-x-hint" data-scroll-hint=".table-wrap">${icon("chevron-left")}左右滑动查看更多列${icon("chevron-right")}</div>`
    : `<div class="empty-state">${icon("briefcase")}<p>还没有班次模板。建议先创建早班、中班、晚班等常用班次。</p>
       <button class="btn btn-filled" data-dialog-open="template-dialog" data-dialog-fill="fillTemplateDialog">${icon("plus")}新增模板</button></div>`;

  const dialog = `
<dialog id="template-dialog" class="dialog">
  <form method="post" action="/shift-templates" novalidate>
    <div class="dialog-head"><h2 id="td-title">新增班次模板</h2>
      <button type="button" class="icon-btn" data-dialog-close aria-label="关闭">${icon("x")}</button></div>
    <div class="dialog-body">
      <input type="hidden" name="action" id="td-action" value="create">
      <input type="hidden" name="id" id="td-id" value="">
      <div class="field"><label for="td-name">班次名称 *</label><input type="text" id="td-name" name="name" required maxlength="20" placeholder="如：早班"></div>
      <div class="field-row">
        <div class="field"><label for="td-start">开始时间 *</label><input type="time" id="td-start" name="start_time" required></div>
        <div class="field"><label for="td-end">结束时间 *</label><input type="time" id="td-end" name="end_time" required>
          <span class="hint">结束不晚于开始表示次日结束</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="td-break">班内休息（分钟）</label><input type="number" id="td-break" name="break_minutes" min="0" max="720" step="5" value="0"></div>
        <div class="field"><label for="td-position">建议岗位</label><input type="text" id="td-position" name="position" maxlength="20" placeholder="如：前厅"></div>
      </div>
      <div class="field"><label for="td-color">排班芯片配色</label>
        <select id="td-color" name="color">
          <option value="primary">主色（米棕）</option><option value="secondary">次要（灰绿）</option>
          <option value="tertiary">强调（陶土橙）</option><option value="warning">夜班（深金）</option>
        </select></div>
      <div class="field"><label for="td-note">备注</label><input type="text" id="td-note" name="note" maxlength="50" placeholder="选填"></div>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn btn-text" data-dialog-close>取消</button>
      <button type="submit" class="btn btn-filled">${icon("save")}保存</button>
    </div>
  </form>
</dialog>`;

  const content = `
<div class="card">
  <div class="card-title"><h2>班次模板列表</h2>
    <span class="sub">模板定义常用班次的时间与休息；排班时可一键套用，也可自定义时间</span></div>
  ${table}
</div>
${dialog}`;

  const scripts = `<script>
  function fillTemplateDialog(btn) {
    var data = btn.getAttribute("data-tpl");
    var form = document.getElementById("template-dialog").querySelector("form");
    form.reset();
    document.getElementById("td-action").value = "create";
    document.getElementById("td-id").value = "";
    document.getElementById("td-title").textContent = "新增班次模板";
    if (!data) return;
    var t = JSON.parse(data);
    document.getElementById("td-action").value = "update";
    document.getElementById("td-id").value = t.id;
    document.getElementById("td-title").textContent = "编辑模板 · " + t.name;
    document.getElementById("td-name").value = t.name;
    document.getElementById("td-start").value = t.start_time;
    document.getElementById("td-end").value = t.end_time;
    document.getElementById("td-break").value = t.break_minutes;
    document.getElementById("td-position").value = t.position || "";
    document.getElementById("td-color").value = t.color || "primary";
    document.getElementById("td-note").value = t.note || "";
  }
  </script>`;
  return layout(ctx, {
    title: "班次模板", endpoint: "shift_templates", content, scripts,
    actions: `<button class="btn btn-filled" data-dialog-open="template-dialog" data-dialog-fill="fillTemplateDialog">${icon("plus")}新增模板</button>`,
  });
}

// ---------- 页面：工时统计 ----------

async function pageHours(ctx) {
  const today = todayISO();
  let period = ctx.url.searchParams.get("period") || "week";
  if (!["day", "week", "month"].includes(period)) period = "week";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get("date") || "")
    ? ctx.url.searchParams.get("date") : today;
  let start, end, label;
  if (period === "day") { start = end = anchor; label = `${anchor}（${WEEKDAY_NAMES[isoWeekday(anchor)]}）`; }
  else if (period === "month") {
    [start, end] = monthRange(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)));
    label = `${Number(anchor.slice(0, 4))} 年 ${Number(anchor.slice(5, 7))} 月`;
  } else { [start, end] = weekRange(anchor); label = `${start} 至 ${end}`; }

  const rows = await fetchSchedules(ctx.db, start, end);
  const summary = summarize(rows, start, end);
  const dayColumns = period === "week"
    ? Array.from({ length: 7 }, (_, i) => ({ iso: addDays(start, i), label: WEEKDAY_NAMES[i + 1] }))
    : null;
  for (const item of summary) {
    const key = item.employment_type === "fulltime" ? "weekly_max_minutes_fulltime" : "weekly_max_minutes_parttime";
    item.weekly_limit_hours = hours(Number(ctx.settings[key] ?? 0));
  }

  const head = `<tr><th>员工</th><th>岗位</th><th>类型</th><th class="num">班次数</th>
    <th class="num">排班时长</th><th class="num">休息时长</th><th class="num">有效工时</th>
    ${dayColumns ? dayColumns.map((d) => `<th class="num">${d.label}</th>`).join("") : ""}
    <th class="num">周上限</th></tr>`;
  const body = summary.length ? summary.map((item) => `<tr>
      <td><strong>${esc(item.name)}</strong></td><td>${esc(item.position) || "—"}</td>
      <td><span class="chip ${item.employment_type === "fulltime" ? "chip-primary" : "chip-secondary"}">${item.type_label}</span></td>
      <td class="num">${item.shifts}</td>
      <td class="num">${hours(item.scheduled_minutes)} h</td>
      <td class="num">${hours(item.break_minutes)} h</td>
      <td class="num"><strong>${hours(item.effective_minutes)} h</strong></td>
      ${dayColumns ? dayColumns.map((d) => item.by_date[d.iso]
        ? `<td class="num">${hours(item.by_date[d.iso])}</td>`
        : '<td class="num muted">—</td>').join("") : ""}
      <td class="num small muted">${item.weekly_limit_hours} h</td></tr>`).join("")
    : "";
  const tfoot = summary.length ? `<tfoot><tr><td>合计</td><td></td><td></td>
      <td class="num">${summary.reduce((s, i) => s + i.shifts, 0)}</td>
      <td class="num">${hours(summary.reduce((s, i) => s + i.scheduled_minutes, 0))} h</td>
      <td class="num">${hours(summary.reduce((s, i) => s + i.break_minutes, 0))} h</td>
      <td class="num">${hours(summary.reduce((s, i) => s + i.effective_minutes, 0))} h</td>
      ${dayColumns ? dayColumns.map(() => "<td></td>").join("") : ""}<td></td></tr></tfoot>` : "";

  const table = summary.length
    ? `<div class="table-wrap cv-auto"><table class="data-table sticky-first"><thead>${head}</thead><tbody>${body}</tbody>${tfoot}</table></div>
       <div class="scroll-x-hint" data-scroll-hint=".table-wrap">${icon("chevron-left")}左右滑动查看更多列${icon("chevron-right")}</div>`
    : `<div class="empty-state">${icon("chart")}<p>所选周期内暂无排班记录。</p><a class="btn btn-tonal btn-sm" href="/schedule?date=${anchor}">去排班</a></div>`;

  const prevStep = period === "day" || period === "month" ? 1 : 7;
  const prevLink = `/hours?period=${period}&date=${addDays(start, -prevStep)}`;
  const nextLink = `/hours?period=${period}&date=${addDays(end, 1)}`;

  const content = `
<div class="card">
  <div class="card-title" style="flex-wrap:wrap;">
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <div class="seg">
        <a class="${period === "day" ? "active" : ""}" href="/hours?period=day&date=${anchor}">按日</a>
        <a class="${period === "week" ? "active" : ""}" href="/hours?period=week&date=${anchor}">按周</a>
        <a class="${period === "month" ? "active" : ""}" href="/hours?period=month&date=${anchor}">按月</a>
      </div>
      <a class="icon-btn" href="${prevLink}" aria-label="上一周期">${icon("chevron-left")}</a>
      <input type="date" value="${anchor}" id="hours-date" style="border:1px solid var(--md-outline-strong); border-radius:8px; padding:7px 10px; font-family:inherit; background:var(--md-surface);">
      <a class="icon-btn" href="${nextLink}" aria-label="下一周期">${icon("chevron-right")}</a>
      <strong>${esc(label)}</strong>
    </div>
    <span class="sub">有效工时 = 排班时长 − 班内休息；跨日班次计入开始日期所在周期</span>
  </div>
  ${table}
  <p class="small muted" style="margin:12px 2px 0;">
    说明：统计按排班记录实时推导；“周上限”为设置页配置的每周工时上限（按用工类型区分），
    当某周有效工时超出上限时，排班页冲突面板会给出提示。超限不阻断排班，仅作提醒，
    实际适用上限须符合当地法规与门店制度。</p>
</div>`;

  const scripts = `<script>
  document.getElementById("hours-date").addEventListener("change", function () {
    if (!this.value) return;
    var params = new URLSearchParams(window.location.search);
    params.set("date", this.value);
    window.location.href = "/hours?" + params.toString();
  });
  </script>`;
  return layout(ctx, {
    title: "工时统计", endpoint: "hours", content, scripts,
    actions: `<a class="btn btn-filled" href="/export/hours?period=${period}&date=${anchor}">${icon("download")}导出工时表</a>`,
  });
}

// ---------- 页面：设置 ----------

async function pageSettings(ctx) {
  const s = ctx.settings;
  const minuteField = (id, name, label, value, hint = "") => `
    <div class="field"><label for="${id}">${label}</label>
      <input type="number" id="${id}" name="${name}" min="0" max="10080" step="30" value="${value}">
      ${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const avatarPreview = s.brand_avatar
    ? `<img class="brand-avatar" src="${s.brand_avatar}" alt="当前头像">`
    : esc(ctx.app_title.slice(0, 1));

  const content = `
<div class="card">
  <div class="card-title"><h2>品牌外观</h2>
    <span class="sub">头像与标题会同步用于侧边栏、浏览器标签与站点图标</span></div>
  <div style="display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap;">
    <div style="text-align:center;">
      <span class="brand-mark" style="width:64px; height:64px; font-size:30px; border-radius:20px;">${avatarPreview}</span>
      <p class="small muted" style="margin:8px 0 0;">当前${s.brand_avatar ? "头像" : "字标"}</p>
    </div>
    <div style="flex:1; min-width:260px;">
      <form method="post" action="/settings/avatar" enctype="multipart/form-data" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <input type="file" name="avatar" accept="image/png,image/jpeg,image/gif,image/webp" required
          style="font-family:inherit; font-size:13px; border:1px solid var(--md-outline-strong); border-radius:8px; padding:8px; background:var(--md-surface); max-width:320px;">
        <button type="submit" class="btn btn-tonal">${icon("save")}上传头像</button>
      </form>
      <p class="small muted" style="margin:10px 0 12px;">
        支持 PNG / JPG / GIF / WebP，不超过 200KB（云端版以 Data URL 存储于 D1）；建议使用正方形图片。上传前会按文件头校验真实格式。</p>
      <form method="post" action="/settings/avatar/remove" data-confirm="确定移除头像并恢复默认字标吗？">
        <button type="submit" class="btn btn-danger-tonal btn-sm"${s.brand_avatar ? "" : " disabled"}>恢复默认字标</button>
      </form>
    </div>
  </div>
</div>

<form method="post" action="/settings">
<div class="card">
  <div class="card-title"><h2>门店与排班规则</h2>
    <span class="sub">以下规则为系统默认演示值，正式使用前请按当地法规及机构适用规定调整</span></div>
  <div class="field-row" style="max-width:720px;">
    <div class="field"><label for="st-name">门店名称（用于报表标题与导出文件名）</label>
      <input type="text" id="st-name" name="store_name" value="${esc(s.store_name)}" maxlength="30" required></div>
    <div class="field"><label for="st-title">系统标题（侧边栏品牌与浏览器标签）</label>
      <input type="text" id="st-title" name="app_title" value="${esc(s.app_title)}" maxlength="24" placeholder="轻排班">
      <span class="hint">留空恢复默认“轻排班”；首字将作为默认字标显示</span></div>
  </div>
  <hr class="divider">
  <h3 style="font-size:14.5px; margin-bottom:12px;">冲突检测规则</h3>
  <div class="field-row" style="max-width:720px;">
    ${minuteField("st-rest", "rest_minutes_min", "相邻两班最小休息间隔（分钟）", s.rest_minutes_min, "同一员工前后两个班次之间的间隔低于该值时给出提示")}
  </div>
  <h3 style="font-size:14.5px; margin:16px 0 12px;">工时上限（分钟）</h3>
  <div class="field-row" style="max-width:720px;">
    ${minuteField("st-df", "daily_max_minutes_fulltime", "全职 · 每日有效工时上限", s.daily_max_minutes_fulltime)}
    ${minuteField("st-dp", "daily_max_minutes_parttime", "兼职 · 每日有效工时上限", s.daily_max_minutes_parttime)}
    ${minuteField("st-wf", "weekly_max_minutes_fulltime", "全职 · 每周有效工时上限", s.weekly_max_minutes_fulltime)}
    ${minuteField("st-wp", "weekly_max_minutes_parttime", "兼职 · 每周有效工时上限", s.weekly_max_minutes_parttime)}
  </div>
  <p class="small muted" style="max-width:720px;">
    上限单位为分钟（如 600 = 10 小时）。超出上限不阻断排班，仅在排班页冲突面板与工时统计中给出提示。
    具体数值请结合当地劳动法规、行业规范与门店制度确认；填 0 表示不启用该项规则。</p>
  <div style="margin-top:16px;"><button type="submit" class="btn btn-filled">${icon("save")}保存设置</button></div>
</div>
</form>

<div class="card">
  <div class="card-title"><h2>账号安全</h2>
    <span class="sub">单管理员账号；密码以 PBKDF2 加盐哈希存储，登录失败 15 分钟内超过 5 次将临时锁定</span></div>
  <form method="post" action="/settings/password" style="max-width:420px;">
    <div class="field">
      <label for="pw-current">当前密码</label>
      <input type="password" id="pw-current" name="current_password" required autocomplete="current-password">
    </div>
    <div class="field-row">
      <div class="field">
        <label for="pw-new">新密码（至少 6 位）</label>
        <input type="password" id="pw-new" name="new_password" required minlength="6" autocomplete="new-password">
      </div>
      <div class="field">
        <label for="pw-confirm">确认新密码</label>
        <input type="password" id="pw-confirm" name="confirm_password" required minlength="6" autocomplete="new-password">
      </div>
    </div>
    <button type="submit" class="btn btn-tonal" style="margin-bottom:6px;">${icon("save")}修改密码</button>
  </form>
</div>

<div class="card">
  <div class="card-title"><h2>数据管理</h2></div>
  <p class="muted small mt-0">
    云端版数据保存在 Cloudflare D1 数据库中。备份以 JSON 全量导出的方式下载；
    恢复或迁移建议使用 wrangler d1 export / execute 完成。</p>
  <div style="display:flex; gap:10px; flex-wrap:wrap;">
    <a class="btn btn-outlined" href="/backup">${icon("database")}下载数据备份（JSON）</a>
    <button type="button" class="btn btn-danger-tonal" id="reset-demo-btn">${icon("refresh")}重置为演示数据</button>
  </div>
  <p class="small muted" style="margin-bottom:0;">
    说明：已内置单管理员密码登录；员工自助账号与分角色权限为后续计划。员工时薪等敏感信息字段未纳入本版本，
    相关权限设计见技术研究报告“系统设计”与“总结与展望”章节。</p>
</div>`;

  const scripts = `<script>
  document.getElementById("reset-demo-btn").addEventListener("click", function () {
    if (!window.confirm("重置将清除当前全部数据并恢复为演示数据，确定继续吗？")) return;
    fetch("/api/reset-demo", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) { window.showToast("已重置为演示数据。", "success"); setTimeout(function () { window.location.reload(); }, 700); }
        else { window.showToast("重置失败。", "error"); }
      })
      .catch(function () { window.showToast("网络异常。", "error"); });
  });
  </script>`;
  return layout(ctx, { title: "设置", endpoint: "settings", content, scripts });
}

// ---------- 表单与 API 处理 ----------

function employeeForm(form) {
  const dayValues = [...new Set(form.getAll("available_days")
    .map((v) => parseInt(v, 10)).filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  return {
    name: (form.get("name") || "").trim(),
    position: (form.get("position") || "").trim(),
    employment_type: form.get("employment_type") || "fulltime",
    phone: (form.get("phone") || "").trim(),
    available_days: JSON.stringify(dayValues),
    available_from: (form.get("available_from") || "").trim(),
    available_to: (form.get("available_to") || "").trim(),
    status: form.get("status") || "active",
    note: (form.get("note") || "").trim(),
  };
}

function validateEmployee(e) {
  const errors = [];
  if (!e.name) errors.push("请填写姓名");
  if (!["fulltime", "parttime"].includes(e.employment_type)) errors.push("用工类型不合法");
  if (!["active", "inactive"].includes(e.status)) errors.push("在职状态不合法");
  let validClocks = true;
  for (const [label, value] of [["可用开始时间", e.available_from], ["可用结束时间", e.available_to]]) {
    if (value) {
      try { parseHHMM(value); }
      catch { errors.push(`${label}应为有效的 HH:MM 时间`); validClocks = false; }
    }
  }
  if (e.available_from && e.available_to && validClocks) {
    const f = parseHHMM(e.available_from);
    const t = parseHHMM(e.available_to);
    if (f >= t) errors.push("每日可用时间段的开始需早于结束");
  }
  return errors;
}

async function handleEmployeesPost(ctx) {
  const form = await ctx.request.formData();
  const action = form.get("action") || "create";
  const id = form.get("id");
  if (action === "delete") {
    if (!id) return redirectFlash("/employees", "缺少员工编号", "error");
    const used = (await ctx.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE employee_id = ?").bind(id).first()).n;
    if (used) {
      await ctx.db.prepare("UPDATE employees SET status = 'inactive' WHERE id = ?").bind(id).run();
      return redirectFlash("/employees", "该员工已有排班记录，已改为“离职（停用）”以保留历史数据。", "warning");
    }
    await ctx.db.prepare("DELETE FROM employees WHERE id = ?").bind(id).run();
    return redirectFlash("/employees", "员工已删除。");
  }
  const data = employeeForm(form);
  const errors = validateEmployee(data);
  if (errors.length) return redirectFlash("/employees", "保存失败：" + errors.join("；"), "error");
  if (action === "update") {
    if (!id) return redirectFlash("/employees", "缺少员工编号", "error");
    await ctx.db.prepare(
      `UPDATE employees SET name=?, position=?, employment_type=?, phone=?, available_days=?,
       available_from=?, available_to=?, status=?, note=? WHERE id=?`)
      .bind(data.name, data.position, data.employment_type, data.phone, data.available_days,
        data.available_from, data.available_to, data.status, data.note, id).run();
    return redirectFlash("/employees", "员工信息已更新。");
  }
  await ctx.db.prepare(
    `INSERT INTO employees(name, position, employment_type, phone, available_days,
     available_from, available_to, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(data.name, data.position, data.employment_type, data.phone, data.available_days,
      data.available_from, data.available_to, data.status, data.note).run();
  return redirectFlash("/employees", "员工已新增。");
}

async function handleTemplatesPost(ctx) {
  const form = await ctx.request.formData();
  const action = form.get("action") || "create";
  const id = form.get("id");
  const name = (form.get("name") || "").trim();
  const start = (form.get("start_time") || "").trim();
  const end = (form.get("end_time") || "").trim();
  const brk = form.get("break_minutes") || "0";
  const position = (form.get("position") || "").trim();
  const color = form.get("color") || "primary";
  const note = (form.get("note") || "").trim();
  const errors = [];
  if (!name) errors.push("请填写班次名称");
  for (const [label, value] of [["开始时间", start], ["结束时间", end]]) {
    if (!TIME_RE.test(value)) errors.push(`${label}格式应为 HH:MM`);
  }
  let span = null;
  if (!errors.length) {
    try { span = shiftSpanMinutes(start, end); }
    catch (exc) { errors.push(exc.message); }
  }
  if (!/^\d+$/.test(brk) || !(parseInt(brk, 10) >= 0 && parseInt(brk, 10) <= 720)) {
    errors.push("休息时长应为 0–720 的整数分钟");
  } else if (span !== null && parseInt(brk, 10) >= span) {
    errors.push("休息时长必须小于班次总时长");
  }
  if (errors.length) return redirectFlash("/shift-templates", "保存失败：" + errors.join("；"), "error");
  if (action === "update" && id) {
    await ctx.db.prepare(
      `UPDATE shift_templates SET name=?, start_time=?, end_time=?, break_minutes=?,
       position=?, color=?, note=? WHERE id=?`)
      .bind(name, start, end, parseInt(brk, 10), position, color, note, id).run();
    return redirectFlash("/shift-templates", "班次模板已更新。");
  }
  await ctx.db.prepare(
    `INSERT INTO shift_templates(name, start_time, end_time, break_minutes, position, color, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(name, start, end, parseInt(brk, 10), position, color, note).run();
  return redirectFlash("/shift-templates", "班次模板已新增。");
}

async function validateSchedulePayload(data) {
  const errors = [];
  const employeeId = data.employee_id;
  const workDate = /^\d{4}-\d{2}-\d{2}$/.test(data.work_date || "") ? data.work_date : null;
  const start = (data.start_time || "").trim(), end = (data.end_time || "").trim();
  let brk = parseInt(data.break_minutes ?? 0, 10);
  if (!employeeId || !Number.isInteger(Number(employeeId))) errors.push("请选择员工");
  if (!workDate) errors.push("日期格式应为 YYYY-MM-DD");
  if (!TIME_RE.test(start)) errors.push("开始时间格式应为 HH:MM");
  if (!TIME_RE.test(end)) errors.push("结束时间格式应为 HH:MM");
  let span = null;
  if (!errors.length) {
    try { span = shiftSpanMinutes(start, end); }
    catch (exc) { errors.push(exc.message); }
  }
  if (!Number.isInteger(brk) || brk < 0 || brk > 720) {
    errors.push("休息时长应为 0–720 的整数分钟");
  } else if (span !== null && brk >= span) {
    errors.push("休息时长必须小于班次总时长");
  }
  if (errors.length) return { errors };
  return { payload: {
    employee_id: Number(employeeId), work_date: workDate, start_time: start, end_time: end,
    break_minutes: brk, position: (data.position || "").trim(),
    template_id: data.template_id || null, note: (data.note || "").trim() } };
}

async function activeEmployee(db, employeeId) {
  const employee = await db.prepare("SELECT * FROM employees WHERE id = ?").bind(employeeId).first();
  if (!employee) return { error: "员工不存在" };
  if (employee.status !== "active") return { error: "该员工已离职，不能排班" };
  return { employee };
}

async function conflictsFor(ctx, payload, scheduleId = null, pendingRows = []) {
  const emp = (await ctx.db.prepare("SELECT * FROM employees WHERE id = ?").bind(payload.employee_id).first());
  if (!emp) return [];
  const [ws, we] = weekRange(payload.work_date);
  const weekRows = await fetchSchedules(ctx.db, addDays(ws, -2), addDays(we, 2));
  const neighbors = weekRows.filter((r) => r.employee_id === payload.employee_id)
    .concat(pendingRows.filter((r) => r.employee_id === payload.employee_id));
  return checkConflicts(
    { ...payload, id: scheduleId }, neighbors,
    { employment_type: emp.employment_type,
      availableDays: new Set(parseAvailableDays(emp.available_days)),
      available_from: emp.available_from, available_to: emp.available_to },
    ctx.settings);
}

async function apiCreateSchedule(ctx) {
  let data;
  try { data = await ctx.request.json(); } catch { data = {}; }
  const { payload, errors } = await validateSchedulePayload(data ?? {});
  if (errors) return Response.json({ errors }, { status: 400 });
  const { employee: emp, error: employeeError } = await activeEmployee(ctx.db, payload.employee_id);
  if (employeeError) return Response.json({ errors: [employeeError] }, { status: 400 });
  if (!payload.position) payload.position = emp.position || "";
  const conflicts = (await conflictsFor(ctx, payload)).map((c) => ({
    rule: c.rule, severity: c.severity, message: c.message,
    related_schedule_id: c.related_schedule_id, rule_label: c.rule_label,
  }));
  const hard = conflicts.some((c) => c.severity === "error");
  if (hard && !ctx.url.searchParams.get("force")) {
    return Response.json({ conflicts }, { status: 409 });
  }
  const result = await ctx.db.prepare(
    `INSERT INTO schedules(employee_id, work_date, start_time, end_time, break_minutes,
     position, template_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(payload.employee_id, payload.work_date, payload.start_time, payload.end_time,
      payload.break_minutes, payload.position, payload.template_id, payload.note).run();
  return Response.json({ id: result.meta.last_row_id, conflicts }, { status: 201 });
}

async function apiScheduleItem(ctx, scheduleId) {
  if (ctx.request.method === "DELETE") {
    await ctx.db.prepare("DELETE FROM schedules WHERE id = ?").bind(scheduleId).run();
    return Response.json({ ok: true });
  }
  const row = await ctx.db.prepare("SELECT * FROM schedules WHERE id = ?").bind(scheduleId).first();
  if (!row) return Response.json({ errors: ["排班记录不存在"] }, { status: 404 });
  let data;
  try { data = await ctx.request.json(); } catch { data = {}; }
  const { payload, errors } = await validateSchedulePayload(data ?? {});
  if (errors) return Response.json({ errors }, { status: 400 });
  const { employee: emp, error: employeeError } = await activeEmployee(ctx.db, payload.employee_id);
  if (employeeError) return Response.json({ errors: [employeeError] }, { status: 400 });
  if (!payload.position) payload.position = emp.position || "";
  const conflicts = (await conflictsFor(ctx, payload, scheduleId)).map((c) => ({
    rule: c.rule, severity: c.severity, message: c.message,
    related_schedule_id: c.related_schedule_id, rule_label: c.rule_label,
  }));
  const hard = conflicts.some((c) => c.severity === "error");
  if (hard && !ctx.url.searchParams.get("force")) {
    return Response.json({ conflicts }, { status: 409 });
  }
  await ctx.db.prepare(
    `UPDATE schedules SET employee_id=?, work_date=?, start_time=?, end_time=?,
     break_minutes=?, position=?, template_id=?, note=? WHERE id=?`)
    .bind(payload.employee_id, payload.work_date, payload.start_time, payload.end_time,
      payload.break_minutes, payload.position, payload.template_id, payload.note, scheduleId).run();
  return Response.json({ id: scheduleId, conflicts });
}

async function apiCopyWeek(ctx) {
  let data;
  try { data = await ctx.request.json(); } catch { data = {}; }
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(data?.target_date || "") ? data.target_date : null;
  if (!anchor) return Response.json({ errors: ["目标日期格式应为 YYYY-MM-DD"] }, { status: 400 });
  const [targetStart, targetEnd] = weekRange(anchor);
  const sourceStart = addDays(targetStart, -7), sourceEnd = addDays(targetEnd, -7);
  const sourceRows = await fetchSchedules(ctx.db, sourceStart, sourceEnd);
  const activeIds = new Set((await loadEmployees(ctx.db, true)).map((row) => row.id));
  const existing = await fetchSchedules(ctx.db, targetStart, targetEnd);
  const existingKeys = new Set(existing.map((row) =>
    `${row.employee_id}|${row.work_date}|${row.start_time}|${row.end_time}`));

  const candidates = [];
  const conflictDetails = [];
  let skippedExisting = 0, skippedInactive = 0, errorCount = 0, warningCount = 0;
  for (const row of sourceRows) {
    if (!activeIds.has(row.employee_id)) { skippedInactive++; continue; }
    const targetDate = addDays(row.work_date, 7);
    const key = `${row.employee_id}|${targetDate}|${row.start_time}|${row.end_time}`;
    if (existingKeys.has(key)) { skippedExisting++; continue; }
    const payload = {
      employee_id: row.employee_id, work_date: targetDate,
      start_time: row.start_time, end_time: row.end_time,
      break_minutes: row.break_minutes, position: row.position,
      template_id: row.template_id, note: row.note,
    };
    const conflicts = await conflictsFor(ctx, payload, null, candidates);
    errorCount += conflicts.filter((c) => c.severity === "error").length;
    warningCount += conflicts.filter((c) => c.severity === "warning").length;
    if (conflicts.length) conflictDetails.push({
      employee_name: row.employee_name, date: targetDate,
      time: `${row.start_time}–${row.end_time}`, conflicts,
    });
    candidates.push(payload);
    existingKeys.add(key);
  }
  const result = {
    source_start: sourceStart, source_end: sourceEnd,
    target_start: targetStart, target_end: targetEnd,
    copy_count: candidates.length, skipped_existing: skippedExisting,
    skipped_inactive: skippedInactive, error_count: errorCount,
    warning_count: warningCount, conflict_details: conflictDetails,
  };
  if (!data.confirm) return Response.json(result);
  if (candidates.length) {
    await ctx.db.batch(candidates.map((payload) => ctx.db.prepare(
      `INSERT INTO schedules(employee_id, work_date, start_time, end_time, break_minutes,
       position, template_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      payload.employee_id, payload.work_date, payload.start_time, payload.end_time,
      payload.break_minutes, payload.position, payload.template_id, payload.note)));
  }
  return Response.json({ ...result, created: candidates.length }, { status: 201 });
}

async function handleSettingsPost(ctx) {
  const form = await ctx.request.formData();
  const values = {};
  const storeName = (form.get("store_name") || "").trim();
  if (!storeName) return redirectFlash("/settings", "保存失败：门店名称不能为空", "error");
  values.store_name = storeName;
  values.app_title = (form.get("app_title") || "").trim().slice(0, 24) || "轻排班";
  for (const key of MINUTE_KEYS) {
    const raw = (form.get(key) || "").trim();
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) > 7 * 24 * 60) {
      return redirectFlash("/settings", "保存失败：工时规则数值不合法", "error");
    }
    values[key] = String(parseInt(raw, 10));
  }
  await saveSettings(ctx.db, values);
  return redirectFlash("/settings", "设置已保存。");
}

async function handleAvatarPost(ctx) {
  const form = await ctx.request.formData();
  const file = form.get("avatar");
  if (!file || typeof file === "string" || !file.size) {
    return redirectFlash("/settings", "请选择图片文件（PNG / JPG / GIF / WebP）。", "error");
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return redirectFlash("/settings", "图片不能超过 200KB（云端版限制），请压缩后重试。", "error");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let ext = null;
  for (const [e, magic] of AVATAR_MAGIC) {
    if (magic.every((b, i) => bytes[i] === b)) { ext = e; break; }
  }
  if (!ext) return redirectFlash("/settings", "不支持的图片格式，请使用 PNG / JPG / GIF / WebP。", "error");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const dataURL = `data:image/${ext === ".jpg" ? "jpeg" : ext.slice(1)};base64,${btoa(binary)}`;
  await saveSettings(ctx.db, { brand_avatar: dataURL });
  return redirectFlash("/settings", "品牌头像已更新。");
}

// ---------- 导出与备份 ----------

async function exportSchedule(ctx) {
  const today = todayISO();
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get("date") || "") ? ctx.url.searchParams.get("date") : today;
  const [ws, we] = weekRange(anchor);
  const rows = await fetchSchedules(ctx.db, ws, we);
  const conflicts = await weekConflicts(ctx.db, ws, we, ctx.settings);
  const conflictCount = new Map();
  for (const c of conflicts) conflictCount.set(c.schedule_id, (conflictCount.get(c.schedule_id) ?? 0) + 1);
  const exportRows = rows.map((row) => {
    const notes = [];
    if (row.note) notes.push(row.note);
    if (conflictCount.has(row.id)) notes.push(`冲突提示 ${conflictCount.get(row.id)} 条`);
    return {
      work_date: row.work_date,
      weekday: WEEKDAY_NAMES[isoWeekday(row.work_date)],
      employee_name: row.employee_name, position: row.position,
      start_time: row.start_time, end_time: row.end_time,
      break_minutes: row.break_minutes,
      effective_hours: effectiveMinutes(row.start_time, row.end_time, row.break_minutes) / 60,
      note: notes.join("；"),
    };
  });
  const xlsx = exportScheduleXlsx(exportRows, ctx.settings.store_name, ws, we);
  const filename = encodeURIComponent(`${ctx.settings.store_name}_排班表_${ws}.xlsx`);
  return new Response(xlsx, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
    },
  });
}

async function exportHours(ctx) {
  const today = todayISO();
  let period = ctx.url.searchParams.get("period") || "week";
  if (!["day", "week", "month"].includes(period)) period = "week";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get("date") || "") ? ctx.url.searchParams.get("date") : today;
  let start, end, label;
  if (period === "month") {
    [start, end] = monthRange(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)));
    label = `${Number(anchor.slice(0, 4))}年${Number(anchor.slice(5, 7))}月`;
  } else if (period === "day") { start = end = anchor; label = anchor; }
  else { [start, end] = weekRange(anchor); label = `${start}至${end}`; }
  const rows = await fetchSchedules(ctx.db, start, end);
  const summary = summarize(rows, start, end);
  const dayColumns = period === "week"
    ? Array.from({ length: 7 }, (_, i) => ({ iso: addDays(start, i), label: WEEKDAY_NAMES[i + 1] }))
    : null;
  const xlsx = exportHoursXlsx(ctx.settings.store_name, label, summary, dayColumns);
  const filename = encodeURIComponent(`${ctx.settings.store_name}_工时统计_${label}.xlsx`);
  return new Response(xlsx, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
    },
  });
}

// ---------- 演示数据（与 seed.py 同一套门店/人员/班次，日期相对当周生成） ----------

const DEMO_EMPLOYEES = [
  ["陈静", "前厅", "fulltime", "13800000001", [1, 2, 3, 4, 5, 6], "07:00", "22:00", "店长，负责排班审核"],
  ["李慧", "后厨", "fulltime", "13800000002", [1, 2, 3, 4, 5], "06:30", "20:00", ""],
  ["王强", "后厨", "fulltime", "13800000003", [1, 2, 3, 4, 5, 6], "06:00", "23:30", ""],
  ["赵磊", "收银", "fulltime", "13800000004", [1, 2, 3, 4, 5], "09:00", "21:00", ""],
  ["孙娜", "外卖打包", "fulltime", "13800000005", [2, 3, 4, 5, 6], "09:00", "20:00", ""],
  ["周杰", "前厅", "parttime", "13800000006", [1, 2, 3, 4, 5, 6, 7], "", "", "大学生兼职，时段灵活"],
  ["吴敏", "收银", "parttime", "13800000007", [1, 2, 3, 4, 5, 6, 7], "", "", ""],
  ["郑浩", "后厨", "parttime", "13800000008", [5, 6, 7], "08:00", "23:00", "周末兼职"],
  ["冯婷", "前厅", "parttime", "13800000009", [1, 2, 3, 4, 5], "07:00", "19:00", ""],
  ["许阳", "外卖打包", "parttime", "13800000010", [1, 2, 6, 7], "06:30", "21:30", ""],
];
const DEMO_TEMPLATES = [
  ["早班", "07:00", "15:00", 30, "", "primary"],
  ["中班", "11:00", "19:00", 30, "", "secondary"],
  ["晚班", "15:00", "23:00", 30, "", "tertiary"],
  ["打烊班", "19:00", "01:00", 0, "", "warning"],
];
const KEY_TO_TEMPLATE = { m: "早班", t: "中班", e: "晚班", n: "打烊班" };
const DEMO_WEEK = {
  1: { m: ["李慧", "冯婷"], t: ["陈静", "赵磊"], e: ["王强", "吴敏"], n: ["周杰"] },
  2: { m: ["李慧", "许阳"], t: ["陈静", "孙娜"], e: ["王强", "吴敏"], n: ["周杰"] },
  3: { m: ["李慧", "冯婷"], t: ["周杰", "孙娜"], e: ["王强", "吴敏"], n: ["周杰"] },
  4: { m: ["李慧", "冯婷"], t: ["陈静", "赵磊"], e: ["王强", "吴敏"], n: ["周杰"] },
  5: { m: ["李慧", "冯婷"], t: ["陈静", "孙娜"], e: ["王强", "周杰"], n: ["吴敏"] },
  6: { m: ["许阳", "周杰"], t: ["陈静", "孙娜", "周杰"], e: ["王强"], n: ["吴敏"] },
  7: { m: ["许阳"], t: ["赵磊", "郑浩"], e: ["周杰"], n: ["吴敏"] },
};
const DEMO_NEXT_WEEK = {
  1: { m: ["李慧", "冯婷"], t: ["陈静", "赵磊"], e: ["王强", "吴敏"], n: ["周杰"] },
  2: { m: ["李慧", "许阳"], t: ["陈静", "孙娜"], e: ["王强", "吴敏"] },
  3: { m: ["李慧", "冯婷"], t: ["陈静", "孙娜"], e: ["王强", "吴敏"] },
};

async function resetDemo(db) {
  const today = todayISO();
  const monday = weekRange(today)[0];
  await db.batch([
    db.prepare("DELETE FROM schedules"),
    db.prepare("DELETE FROM shift_templates"),
    db.prepare("DELETE FROM employees"),
    // 重置自增序列，保证每次重置后演示数据的员工/模板 ID 一致
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('schedules', 'shift_templates', 'employees')"),
  ]);
  const empIds = new Map(), empPos = new Map();
  for (const [name, position, type, phone, days, from, to, note] of DEMO_EMPLOYEES) {
    const r = await db.prepare(
      `INSERT INTO employees(name, position, employment_type, phone, available_days,
       available_from, available_to, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .bind(name, position, type, phone, JSON.stringify(days), from, to, note).run();
    empIds.set(name, r.meta.last_row_id);
    empPos.set(name, position);
  }
  const tpl = new Map();
  for (const [name, start, end, brk, position, color] of DEMO_TEMPLATES) {
    const r = await db.prepare(
      `INSERT INTO shift_templates(name, start_time, end_time, break_minutes, position, color, note)
       VALUES (?, ?, ?, ?, ?, ?, '')`)
      .bind(name, start, end, brk, position, color).run();
    tpl.set(name, { id: r.meta.last_row_id, start, end, brk });
  }
  const stmts = [];
  const writeWeek = (plan, weekMonday) => {
    for (const [weekday, slots] of Object.entries(plan)) {
      const workDate = addDays(weekMonday, Number(weekday) - 1);
      for (const [key, names] of Object.entries(slots)) {
        const t = tpl.get(KEY_TO_TEMPLATE[key]);
        for (const name of names) {
          stmts.push(db.prepare(
            `INSERT INTO schedules(employee_id, work_date, start_time, end_time, break_minutes,
             position, template_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, '')`)
            .bind(empIds.get(name), workDate, t.start, t.end, t.brk, empPos.get(name), t.id));
        }
      }
    }
  };
  writeWeek(DEMO_WEEK, monday);
  writeWeek(DEMO_NEXT_WEEK, addDays(monday, 7));
  await db.batch(stmts);
}

// ---------- 登录页 ----------

async function pageLogin(ctx, error, next) {
  const favicon = ctx.brand_avatar || DEFAULT_FAVICON;
  const mark = ctx.brand_avatar
    ? `<img src="${ctx.brand_avatar}" alt="">`
    : esc(ctx.app_title.slice(0, 1));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · ${esc(ctx.app_title)}</title>
<link rel="stylesheet" href="/static/css/theme.css">
<link rel="icon" href="${favicon}">
</head>
<body class="login-page">
<div class="login-shell">
  <section class="login-hero">
    <div class="hero-deco" aria-hidden="true">
      <span class="deco-blob"></span>
      <span class="deco-ring deco-ring-a"></span>
      <span class="deco-ring deco-ring-b"></span>
      <div class="deco-cal"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
    </div>
    <div class="hero-inner">
      <div class="brand-row">
        <span class="login-mark">${mark}</span>
        <div class="login-title">${esc(ctx.app_title)}</div>
      </div>
      <h1 class="hero-headline">排班更轻，<br>工时一目了然。</h1>
      <p class="hero-desc">面向小团队的排班与工时统计工具：可视化周排班、冲突自动检测、报表一键导出。</p>
      <ul class="hero-points">
        <li>${icon("calendar")}可视化周排班与冲突检测</li>
        <li>${icon("clock")}自动汇总工时与休息日</li>
        <li>${icon("download")}一键导出 Excel 报表</li>
      </ul>
    </div>
  </section>
  <section class="login-panel">
    <main class="login-card">
      <h1 class="login-heading">欢迎回来</h1>
      <p class="login-desc">登录管理员账号，继续管理排班与工时。</p>
      ${error ? `<div class="login-error" role="alert">${icon("x-circle")}<span>${esc(error)}</span></div>` : ""}
      <form method="post" action="/login" novalidate>
        <input type="hidden" name="next" value="${esc(next ?? "")}">
        <div class="field">
          <label for="login-username">用户名</label>
          <input type="text" id="login-username" name="username" value="admin"
                 autocomplete="username" spellcheck="false">
        </div>
        <div class="field">
          <label for="login-password">密码</label>
          <input type="password" id="login-password" name="password" required
                 autocomplete="current-password" placeholder="请输入密码">
        </div>
        <button type="submit" class="btn btn-filled login-submit">${icon("save")}登录</button>
      </form>
      <p class="login-hint">演示环境默认账号 <code>admin</code>、密码 <code>shiftlite123</code>。<br>登录后可在「设置 → 账号安全」修改密码。</p>
    </main>
  </section>
</div>
</body>
</html>`;
}

async function handleLoginPost(ctx) {
  const form = await ctx.request.formData();
  const username = (form.get("username") || "").trim();
  const password = form.get("password") || "";
  let next = form.get("next") || form.get("next") === "" ? form.get("next") : "";
  next = next || "/";
  if (!next.startsWith("/") || next.startsWith("//")) next = "/";
  const ip = clientIP(ctx.request);
  const waitMs = await throttleRemaining(ctx.db, ip);
  if (waitMs > 0) {
    return htmlResponse(await pageLogin(ctx,
      `尝试过于频繁，请约 ${Math.ceil(waitMs / 60000)} 分钟后再试`, next), 200);
  }
  if (username && username !== "admin") {
    return htmlResponse(await pageLogin(ctx, "用户名不存在，请重试", next), 200);
  }
  if (await verifyPassword(password, ctx.settings.admin_password_hash || "")) {
    await ctx.db.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
    const token = await makeSession(ctx.db);
    return new Response(null, { status: 303, headers: {
      "Location": next, "Set-Cookie": sessionCookie(token),
      "Cache-Control": "no-cache" } });
  }
  await throttleFail(ctx.db, ip);
  return htmlResponse(await pageLogin(ctx, "密码错误，请重试", next), 200);
}

// ---------- 路由入口 ----------

async function buildContext(env, request, url) {
  const db = env.DB;
  const settings = await loadSettings(db);
  if (!settings.admin_password_hash) {
    await saveSettings(db, { admin_password_hash: await makePasswordHash(DEFAULT_ADMIN_PASSWORD) });
    settings.admin_password_hash = (await loadSettings(db)).admin_password_hash;
  }
  return {
    env, db, request, url, settings,
    endpoint: "", app_title: settings.app_title || "轻排班",
    brand_avatar: settings.brand_avatar || "",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const ctx = await buildContext(env, request, url);

      // ---------- 登录保护 ----------
      if (path === "/login") {
        if (request.method === "GET") {
          const authed = await checkSession(ctx.db, request.headers.get("Cookie"));
          if (authed) return new Response(null, { status: 303, headers: { Location: "/" } });
          return htmlResponse(await pageLogin(ctx, null, url.searchParams.get("next") || ""));
        }
        if (request.method === "POST") return handleLoginPost(ctx);
      }
      if (path === "/logout" && request.method === "POST") {
        return new Response(null, { status: 303, headers: {
          "Location": "/login", "Set-Cookie": sessionCookie("", true) } });
      }
      if (!(path.startsWith("/static/") || path === "/favicon.ico")) {
        const authed = await checkSession(ctx.db, request.headers.get("Cookie"));
        if (!authed) {
          if (path.startsWith("/api/")) {
            return Response.json({ errors: ["登录已过期，请重新登录"] }, { status: 401 });
          }
          const next = request.method === "GET" ? path : "/";
          return new Response(null, { status: 303, headers: {
            "Location": `/login?next=${encodeURIComponent(next)}` } });
        }
      }

      // JSON API
      if (path === "/api/schedules" && request.method === "POST") return apiCreateSchedule(ctx);
      if (path === "/api/schedules/copy-week" && request.method === "POST") return apiCopyWeek(ctx);
      let m = path.match(/^\/api\/schedules\/(\d+)$/);
      if (m && (request.method === "PUT" || request.method === "DELETE")) {
        return apiScheduleItem(ctx, Number(m[1]));
      }
      if (path === "/api/conflicts" && request.method === "GET") {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "")
          ? url.searchParams.get("date") : todayISO();
        const [ws, we] = weekRange(date);
        return Response.json({ conflicts: await weekConflicts(ctx.db, ws, we, ctx.settings) });
      }
      if (path === "/api/reset-demo" && request.method === "POST") {
        await resetDemo(ctx.db);
        return Response.json({ ok: true });
      }

      // 导出与备份
      if (path === "/export/schedule") return exportSchedule(ctx);
      if (path === "/export/hours") return exportHours(ctx);
      if (path === "/backup") {
        const dump = {};
        for (const table of ["employees", "shift_templates", "schedules", "settings"]) {
          dump[table] = (await ctx.db.prepare(`SELECT * FROM ${table}`).all()).results;
        }
        return new Response(JSON.stringify({ exported_at: todayISO(), tables: dump }, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`shiftlite-backup-${todayISO()}.json`)}`,
          },
        });
      }

      // 页面
      if (path === "/" && request.method === "GET") { ctx.endpoint = "dashboard"; return htmlResponse(await pageDashboard(ctx)); }
      if (path === "/schedule" && request.method === "GET") { ctx.endpoint = "schedule"; return htmlResponse(await pageSchedule(ctx)); }
      if (path === "/employees") {
        ctx.endpoint = "employees";
        if (request.method === "POST") return handleEmployeesPost(ctx);
        return htmlResponse(await pageEmployees(ctx));
      }
      if (path === "/shift-templates") {
        ctx.endpoint = "shift_templates";
        if (request.method === "POST") return handleTemplatesPost(ctx);
        return htmlResponse(await pageTemplates(ctx));
      }
      m = path.match(/^\/shift-templates\/(\d+)\/delete$/);
      if (m && request.method === "POST") {
        await ctx.db.prepare("DELETE FROM shift_templates WHERE id = ?").bind(Number(m[1])).run();
        return redirectFlash("/shift-templates", "模板已删除；使用该模板的历史排班已保留为自定义时间。");
      }
      if (path === "/hours" && request.method === "GET") { ctx.endpoint = "hours"; return htmlResponse(await pageHours(ctx)); }
      if (path === "/settings") {
        ctx.endpoint = "settings";
        if (request.method === "POST") return handleSettingsPost(ctx);
        return htmlResponse(await pageSettings(ctx));
      }
      if (path === "/settings/avatar" && request.method === "POST") return handleAvatarPost(ctx);
      if (path === "/settings/avatar/remove" && request.method === "POST") {
        await saveSettings(ctx.db, { brand_avatar: "" });
        return redirectFlash("/settings", "已恢复默认字标。");
      }
      if (path === "/settings/password" && request.method === "POST") {
        const form = await ctx.request.formData();
        const current = form.get("current_password") || "";
        const newPassword = form.get("new_password") || "";
        const confirm = form.get("confirm_password") || "";
        if (!(await verifyPassword(current, ctx.settings.admin_password_hash || ""))) {
          return redirectFlash("/settings", "修改失败：当前密码不正确。", "error");
        }
        if (newPassword.length < 6) {
          return redirectFlash("/settings", "修改失败：新密码至少 6 位。", "error");
        }
        if (newPassword !== confirm) {
          return redirectFlash("/settings", "修改失败：两次输入的新密码不一致。", "error");
        }
        await saveSettings(ctx.db, { admin_password_hash: await makePasswordHash(newPassword) });
        return redirectFlash("/settings", "密码已更新，下次登录请使用新密码。");
      }

      // 静态资产由平台处理；未匹配的路径回 404
      if (env.ASSETS && (path.startsWith("/static/") || path === "/favicon.ico")) {
        return env.ASSETS.fetch(request);
      }
      return htmlResponse(layout(ctx, {
        title: "页面不存在", endpoint: "",
        content: `<div class="card"><div class="empty-state">${icon("x-circle")}<p>页面不存在（404）。</p>
          <a class="btn btn-tonal btn-sm" href="/">返回概览</a></div></div>`,
      }), 404);
    } catch (exc) {
      console.error("[shiftlite] worker error:", exc?.stack ?? String(exc));
      return new Response(`轻排班 运行错误：${exc?.stack ?? exc}`, { status: 500 });
    }
  },
};
