// 端到端测试：不依赖 workerd，用 node:sqlite 实现 D1 桩，在进程内直接调用 worker 的 fetch 导出。
// 运行：node test/e2e.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

/** 基于 node:sqlite 的最小 D1 兼容桩：prepare().bind().all()/first()/run() 与 batch()。 */
class D1Stub {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const make = (binds) => ({
      all: async () => ({ results: stmt.all(...binds) }),
      first: async (col) => {
        const row = stmt.get(...binds);
        if (col !== undefined) return row ? row[col] : undefined;
        return row ?? null;
      },
      run: async () => {
        const info = stmt.run(...binds);
        return { meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
      },
    });
    return { bind: (...binds) => make(binds), ...make([]) };
  }
  async batch(stmts) {
    const out = [];
    this.db.exec("BEGIN");
    try {
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }
}

const db = new DatabaseSync(":memory:");
const env = { DB: new D1Stub(db) };
let sessionCookie = "";

async function call(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const res = await worker.fetch(new Request("http://localhost" + path, { ...init, headers }), env, {});
  const setCookie = res.headers.get("Set-Cookie");
  if (setCookie && setCookie.startsWith("shiftlite_session=")) {
    sessionCookie = setCookie.split(";")[0];
  }
  return { status: res.status, text: await res.text(), headers: res.headers, res };
}

async function get(path) { return call(path); }
async function post(path) { return call(path, { method: "POST" }); }
async function postJSON(path, data) {
  return call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

async function loginAs(password = "shiftlite123") {
  const form = new FormData();
  form.append("password", password);
  return call("/login", { method: "POST", body: form });
}

before(async () => {
  db.exec(readFileSync(new URL("../migrations/0001_schema.sql", import.meta.url), "utf-8"));
  // 登录获取会话（后续全部请求自动携带）
  const res = await loginAs();
  if (res.status !== 303) throw new Error("登录失败：" + res.status);
});

after(() => { db.close(); });

test("六个页面全部渲染", async () => {
  const pages = [
    ["/", "概览"], ["/schedule", "本周冲突与工时提示"], ["/employees", "员工列表"],
    ["/shift-templates", "班次模板列表"], ["/hours?period=week", "工时统计"], ["/settings", "品牌外观"],
  ];
  for (const [path, marker] of pages) {
    const { status, text } = await get(path);
    assert.equal(status, 200, `${path} 状态码异常：${text.slice(0, 200)}`);
    assert.ok(text.includes(marker), `${path} 缺少关键内容「${marker}」`);
  }
});

test("重置演示数据后冲突面板有检出结果", async () => {
  const reset = await post("/api/reset-demo");
  assert.equal(reset.status, 200);
  const { status, text } = await get("/api/conflicts");
  assert.equal(status, 200);
  const data = JSON.parse(text);
  assert.ok(data.conflicts.length >= 5, `演示周应检出多条冲突，实际 ${data.conflicts.length}`);
  assert.ok(data.conflicts.some((c) => c.rule === "overlap"), "应包含重叠冲突");
  const page = await get("/schedule");
  assert.ok(page.text.includes("班次重叠"), "排班页应展示重叠冲突");
});

test("排班 API：409 拦截 → 强制保存 → 删除", async () => {
  await post("/api/reset-demo");
  const conflicts = JSON.parse((await get("/api/conflicts")).text).conflicts;
  const saturday = conflicts.find((c) => c.weekday === "周六")?.date;
  assert.ok(saturday, "演示数据应包含周六冲突");
  const res = await call("/api/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_id: 6, work_date: saturday,
      start_time: "12:00", end_time: "14:00", break_minutes: 0 }),
  });
  if (res.status !== 409) console.error("[debug] 400 body:", res.text.slice(0, 300));
  assert.equal(res.status, 409);
  const blocked = JSON.parse(res.text);
  assert.ok(blocked.conflicts.some((c) => c.rule === "overlap"));
  const res2 = await call("/api/schedules?force=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_id: 6, work_date: saturday,
      start_time: "12:00", end_time: "14:00", break_minutes: 0 }),
  });
  assert.equal(res2.status, 201);
  const created = JSON.parse(res2.text);
  const del = await call(`/api/schedules/${created.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
});

test("排班校验、停用员工更新与周复制保持对齐", async () => {
  await post("/api/reset-demo");
  const saturday = JSON.parse((await get("/api/conflicts")).text).conflicts
    .find((c) => c.weekday === "周六")?.date;
  assert.ok(saturday);

  const badBreak = await postJSON("/api/schedules", {
    employee_id: 6, work_date: saturday,
    start_time: "09:00", end_time: "10:00", break_minutes: 120,
  });
  assert.equal(badBreak.status, 400);
  assert.ok(JSON.parse(badBreak.text).errors.some((e) => e.includes("小于班次总时长")));

  db.prepare("UPDATE employees SET status='inactive' WHERE id=10").run();
  const inactivePut = await call("/api/schedules/1", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_id: 10, work_date: saturday,
      start_time: "09:00", end_time: "12:00", break_minutes: 0 }),
  });
  assert.equal(inactivePut.status, 400);
  assert.ok(JSON.parse(inactivePut.text).errors[0].includes("已离职"));
  db.prepare("UPDATE employees SET status='active' WHERE id=10").run();

  const [targetMonday] = weekRangeForTest(addDaysForTest(saturday, 7));
  const preview = await postJSON("/api/schedules/copy-week", { target_date: targetMonday });
  assert.equal(preview.status, 200);
  const previewData = JSON.parse(preview.text);
  assert.ok(previewData.copy_count > 0);
  assert.ok(previewData.skipped_existing > 0);
  const saved = await postJSON("/api/schedules/copy-week", { target_date: targetMonday, confirm: true });
  assert.equal(saved.status, 201);
  assert.equal(JSON.parse(saved.text).created, previewData.copy_count);
  const again = await postJSON("/api/schedules/copy-week", { target_date: targetMonday });
  assert.equal(JSON.parse(again.text).copy_count, 0);

  const page = await get(`/schedule?date=${targetMonday}`);
  assert.ok(page.text.includes('id="copy-prev-week"'));
  assert.ok(page.text.includes(" 人 · ") && page.text.includes("本周 "));
});

function addDaysForTest(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekRangeForTest(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7;
  return [addDaysForTest(iso, 1 - weekday), addDaysForTest(iso, 7 - weekday)];
}

test("员工新增（表单）与设置标题修改", async () => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ action: "create", name: "测试员工", position: "前厅",
    employment_type: "parttime", phone: "", available_from: "", available_to: "", status: "active", note: "" })) {
    form.append(k, v);
  }
  for (const d of ["1", "2", "3"]) form.append("available_days", d);
  const res = await call("/employees", { method: "POST", body: form });
  assert.equal(res.status, 303);
  assert.ok(res.headers.get("Location").includes(encodeURIComponent("员工已新增")));
  const page = await get("/employees");
  assert.ok(page.text.includes("测试员工"));

  const form2 = new FormData();
  for (const [k, v] of Object.entries({ store_name: "云端门店", app_title: "米仓排班",
    rest_minutes_min: "600", daily_max_minutes_fulltime: "600", daily_max_minutes_parttime: "480",
    weekly_max_minutes_fulltime: "2640", weekly_max_minutes_parttime: "1440" })) {
    form2.append(k, v);
  }
  await call("/settings", { method: "POST", body: form2 });
  const home = await get("/");
  assert.ok(home.text.includes("米仓排班"), "系统标题应同步到侧边栏");
  form2.set("app_title", "");
  await call("/settings", { method: "POST", body: form2 });
  const home2 = await get("/");
  assert.ok(home2.text.includes("轻排班"), "留空应回落默认标题");
});

test("品牌头像上传与移除（Data URL）", async () => {
  const PNG_1PX = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex");
  const form = new FormData();
  form.append("avatar", new File([PNG_1PX], "logo.png", { type: "image/png" }));
  const res = await call("/settings/avatar", { method: "POST", body: form });
  assert.equal(res.status, 303);
  const page = await get("/");
  assert.ok(page.text.includes("data:image/png;base64,"), "侧边栏应使用 Data URL 头像");
  const bad = new FormData();
  bad.append("avatar", new File([new Uint8Array([1, 2, 3, 4])], "fake.png", { type: "image/png" }));
  const res2 = await call("/settings/avatar", { method: "POST", body: bad });
  assert.equal(res2.status, 303);
  assert.ok(res2.headers.get("Location").includes(encodeURIComponent("不支持的图片格式")));
  const res3 = await call("/settings/avatar/remove", { method: "POST" });
  assert.equal(res3.status, 303);
  const page2 = await get("/");
  assert.ok(!page2.text.includes("brand-avatar"), "移除后应恢复默认字标");
});

test("登录保护：未登录跳转 / API 401", async () => {
  const res = await worker.fetch(new Request("http://localhost/"), env, {});
  assert.equal(res.status, 303);
  assert.ok(res.headers.get("Location").startsWith("/login"));
  const api = await worker.fetch(new Request("http://localhost/api/conflicts"), env, {});
  assert.equal(api.status, 401);
  const backup = await worker.fetch(new Request("http://localhost/backup"), env, {});
  assert.equal(backup.status, 303);
});

test("登录页与错误密码提示", async () => {
  const noCookie = { DB: env.DB }; // 直接调用，不带会话
  const page = await worker.fetch(new Request("http://localhost/login"), noCookie, {});
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.ok(text.includes("用户名") && text.includes("密码"));
  const form = new FormData();
  form.append("password", "wrong-pass");
  const bad = await worker.fetch(new Request("http://localhost/login", { method: "POST", body: form }), noCookie, {});
  assert.equal(bad.status, 200);
  assert.ok((await bad.text()).includes("密码错误"));
});

test("登出后会话失效", async () => {
  await post("/logout");
  const res = await get("/");
  assert.equal(res.status, 303);
  assert.ok(res.headers.get("Location").startsWith("/login"));
  // 重新登录恢复会话（供后续测试使用）
  const form = new FormData();
  form.append("password", "shiftlite123");
  await call("/login", { method: "POST", body: form });
  assert.equal((await get("/")).status, 200);
});

test("修改密码：旧密码失效、新密码可用", async () => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ current_password: "shiftlite123",
    new_password: "newpass9", confirm_password: "newpass9" })) form.append(k, v);
  const res = await call("/settings/password", { method: "POST", body: form });
  assert.equal(res.status, 303);
  // 用旧会话仍有效（原型口径），登出后需新密码
  await post("/logout");
  const form2 = new FormData();
  form2.append("password", "shiftlite123");
  const bad = await call("/login", { method: "POST", body: form2 });
  assert.equal(bad.status, 200);
  assert.ok(bad.text.includes("密码错误"));
  const form3 = new FormData();
  form3.append("password", "newpass9");
  const ok = await call("/login", { method: "POST", body: form3 });
  assert.equal(ok.status, 303);
  // 改回默认密码并重新登录，避免影响其他测试
  const form4 = new FormData();
  for (const [k, v] of Object.entries({ current_password: "newpass9",
    new_password: "shiftlite123", confirm_password: "shiftlite123" })) form4.append(k, v);
  await call("/settings/password", { method: "POST", body: form4 });
  await loginAs();
});

test("Excel 导出与 JSON 备份", async () => {
  await loginAs();
  await post("/api/reset-demo");
  const sched = await get("/export/schedule");
  assert.equal(sched.status, 200, sched.text.slice(0, 300));
  assert.ok(sched.headers.get("Content-Type").includes("spreadsheetml"));
  assert.ok(sched.text.startsWith("PK"), "xlsx 应为 ZIP 容器（PK 头）");
  const hoursRes = await get("/export/hours?period=week");
  assert.equal(hoursRes.status, 200);
  assert.ok(hoursRes.text.startsWith("PK"));
  const backup = await get("/backup");
  const data = JSON.parse(backup.text);
  assert.ok(data.tables.employees.length >= 10);
  assert.ok(data.tables.settings.length >= 8);
});
