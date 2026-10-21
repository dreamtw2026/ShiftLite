# -*- coding: utf-8 -*-
"""ShiftLite 演示视频自动录制脚本。

用 Playwright 驱动本机已安装的 Edge（channel=msedge）在真实运行的系统中
按《演示脚本.md》分镜执行操作，并按场景分别录制 1920x1080 视频。

- 每个场景一个独立 context，输出到 scripts/output/recordings/<scene>.webm
- 同时输出 <scene>.events.json：每个动作的实际发生时间（相对 context 创建）
  与页面坐标（元素中心），供后期叠加鼠标高亮与步骤标注。
- 所有操作均为真实系统调用，不做任何界面伪造。
- 干跑模式（--dry-run）：同样的操作流程但不保存视频，仅验证选择器可用。

用法：python scripts/record_scenes.py [--dry-run] [--headless]
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(__file__).resolve().parent / "output"
REC_DIR = OUT_DIR / "recordings"
DL_DIR = OUT_DIR / "downloads"
REC_DIR.mkdir(parents=True, exist_ok=True)
DL_DIR.mkdir(parents=True, exist_ok=True)

BASE = "http://127.0.0.1:5001"
PASSWORD = "shiftlite123"
VIEWPORT = {"width": 1920, "height": 1080}

TODAY = date.today()
MONDAY = TODAY - timedelta(days=TODAY.isoweekday() - 1)
SATURDAY = (MONDAY + timedelta(days=5)).isoformat()

argv = sys.argv[1:]
DRY = "--dry-run" in argv
HEADLESS = not ("--no-headless" in argv or DRY is False)

# ---- 页面内光标提示器（跟随真实输入移动，出现在录屏画面里） ----
CLICK_PULSE_JS = """
(() => {
  if (window.__shiftCursor) return;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;';
  const mk = (css) => { const d = document.createElement('div');
    d.style.cssText = css; root.appendChild(d); return d; };
  const ring = mk('position:absolute;width:38px;height:38px;border-radius:50%;'
    + 'background:rgba(234,57,84,0.22);box-shadow:0 0 0 1.5px rgba(234,57,84,0.8),'
    + '0 2px 8px rgba(0,0,0,0.25);transform:translate(-19px,-19px);'
    + 'transition:transform 0.26s cubic-bezier(.4,0,.2,1),opacity .22s;opacity:0;');
  const dot = mk('position:absolute;width:9px;height:9px;border-radius:50%;'
    + 'background:rgba(234,57,84,0.95);box-shadow:0 1px 4px rgba(0,0,0,0.35);'
    + 'transform:translate(-4.5px,-4.5px);'
    + 'transition:transform 0.26s cubic-bezier(.4,0,.2,1),opacity .22s;opacity:0;');
  const ripple = mk('position:absolute;width:46px;height:46px;border-radius:50%;'
    + 'border:3px solid rgba(234,57,84,0.65);transform:translate(-23px,-23px) scale(.35);'
    + 'opacity:0;');
  document.body.appendChild(root);
  window.__shiftCursor = {
    set(x, y) {
      ring.style.transform = `translate(${x - 19}px, ${y - 19}px)`;
      dot.style.transform = `translate(${x - 4.5}px, ${y - 4.5}px)`;
      ring.style.opacity = dot.style.opacity = '1';
    },
    pulse(x, y) {
      ring.style.transform = `translate(${x - 22}px, ${y - 22}px)`;
      ripple.style.transition = 'none';
      ripple.style.transform = `translate(${x - 23}px, ${y - 23}px) scale(.35)`;
      ripple.style.opacity = '0.85';
      void ripple.offsetWidth;
      ripple.style.transition = 'transform .45s ease-out, opacity .45s';
      ripple.style.transform = `translate(${x - 23}px, ${y - 23}px) scale(1.75)`;
      ripple.style.opacity = '0';
    },
    hide() { ring.style.opacity = dot.style.opacity = '0'; },
  };
})();
"""


class EventLog:
    def __init__(self, t0: float):
        self.t0 = t0
        self.items: list[dict] = []

    def add(self, action: str, x=None, y=None, **kw):
        rec = {"t": round(time.perf_counter() - self.t0, 3), "action": action, "x": x, "y": y}
        rec.update(kw)
        self.items.append(rec)

    def save(self, path: Path):
        path.write_text(json.dumps(self.items, ensure_ascii=False, indent=1), encoding="utf-8")


def pause(page, log, sec: float, label: str = "", wait: bool = True):
    log.add("pause", duration=sec, label=label)
    if wait:
        page.wait_for_timeout(int(sec * 1000))


def center(loc):
    b = loc.bounding_box()
    if not b:
        return None
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def glide(page, log, x, y, steps=18):
    page.mouse.move(x, y, steps=min(steps, 24))
    page.wait_for_timeout(120)
    try:
        page.evaluate("([x, y]) => window.__shiftCursor && window.__shiftCursor.set(x, y)", [x, y])
    except Exception:
        pass
    log.add("move", x=round(x), y=round(y))


def click_loc(page, log, loc, label="", extra_wait=0):
    c = center(loc)
    if not c:
        log.add("miss", label=label)
        raise AssertionError(f"目标不可见: {label}")
    glide(page, log, *c)
    log.add("click", x=round(c[0]), y=round(c[1]), label=label)
    page.mouse.down()
    try:
        page.evaluate("([x, y]) => window.__shiftCursor && window.__shiftCursor.pulse(x, y)", [c[0], c[1]])
    except Exception:
        pass
    page.wait_for_timeout(80)
    page.mouse.up()
    if extra_wait:
        page.wait_for_timeout(int(extra_wait * 1000))


def hover_loc(page, log, loc, label=""):
    c = center(loc)
    if not c:
        log.add("miss", label=label)
        return False
    glide(page, log, *c, steps=14)
    log.add("hover", x=round(c[0]), y=round(c[1]), label=label)
    return True


def slow_scroll(page, log, dy: int, steps=8, per=0.09):
    step = int(dy / steps)
    for _ in range(steps):
        page.mouse.wheel(0, step)
        page.wait_for_timeout(int(per * 1000))
    log.add("scroll", dy=dy)


def login(page, log):
    page.goto(BASE + "/", wait_until="networkidle")
    if "/login" not in page.url:
        log.add("already-logged-in")
        return
    pwd = page.locator("#login-password")
    c = center(pwd)
    glide(page, log, *c)
    pwd.click()
    page.wait_for_timeout(250)
    pwd.fill(PASSWORD)
    page.wait_for_timeout(350)
    click_loc(page, log, page.locator(".login-submit"), label="登录")
    page.wait_for_load_state("networkidle")
    pause(page, log, 2.0, label="登录成功")


def start_scene(browser, scene: str):
    ctx = browser.new_context(
        viewport=VIEWPORT,
        record_video_dir=str(REC_DIR / f"_tmp_{scene}"),
        record_video_size=VIEWPORT,
        accept_downloads=True,
        locale="zh-CN",
    )
    ctx.add_init_script(CLICK_PULSE_JS)
    log = EventLog(time.perf_counter())
    page = ctx.new_page()
    page.add_init_script(CLICK_PULSE_JS)
    return ctx, page, log


def finish_scene(ctx, scene: str, log: EventLog):
    if DRY:
        ctx.close()
        log.save(REC_DIR / f"{scene}.events.json")
        print(f"[dry-ok] {scene}")
        return
    video = ctx.pages[0].video
    raw = video.path()
    ctx.close()
    target = REC_DIR / f"{scene}.webm"
    target.unlink(missing_ok=True)
    raw.rename(target)
    log.save(REC_DIR / f"{scene}.events.json")
    print(f"[ok] {scene} {target.stat().st_size // 1024} KB")


def guarded(fn, scene: str):
    def run(browser):
        try:
            fn(browser)
        except Exception as e:
            print(f"[error] {scene}: {e.__class__.__name__}: {e}")
    return run


# ---------------- 场景 ----------------

def s_login_overview(browser):
    ctx, page, log = start_scene(browser, "s1_overview")
    login(page, log)
    page.goto(BASE + "/", wait_until="networkidle")
    pause(page, log, 2.5, label="概览页")

    def js_hover(selector, text, label, dwell):
        # 用 evaluate 直取坐标，避免 get_by_text 的可操作性等待（曾出现 ~30s 卡顿）
        c = page.evaluate(
            "([sel, txt]) => {"
            "  const cand = sel ? [...document.querySelectorAll(sel)]"
            "                   : [...document.querySelectorAll('*')];"
            "  for (const el of cand) {"
            "    if (el.childElementCount > 2) continue;"
            "    const t = (el.textContent || '').trim();"
            "    if (sel ? t.includes(txt) : t === txt) {"
            "      const r = el.getBoundingClientRect();"
            "      if (r.width > 0 && r.height > 0 && r.bottom > 60)"
            "        return [r.x + r.width / 2, r.y + r.height / 2]; } }"
            "  return null; }", [selector, text])
        if not c:
            log.add("miss", label=label)
            return False
        glide(page, log, c[0], c[1])
        log.add("hover", x=round(c[0]), y=round(c[1]), label=label)
        pause(page, log, dwell)
        return True

    for token in ("本周排班班次", "在职员工", "本周有效工时", "待处理冲突"):
        js_hover(".stat-label", token, f"stat:{token}", 2.4)
    for name in ("员工", "班次模板", "排班", "工时统计"):
        js_hover("nav a", name, f"nav:{name}", 0.85)
    pause(page, log, 3.2)
    finish_scene(ctx, "s1_overview", log)


def s_employees_templates(browser):
    ctx, page, log = start_scene(browser, "s2_employees")
    login(page, log)
    page.goto(BASE + "/employees", wait_until="networkidle")
    pause(page, log, 2.5, label="员工列表")
    slow_scroll(page, log, 200, steps=6)
    edit = page.locator('button[aria-label="编辑员工 许阳"]')
    click_loc(page, log, edit, label="编辑许阳", extra_wait=0.8)
    dlg = page.locator("dialog[open]").first
    for token in ("可排班日", "每日可用开始时间", "每日可用结束时间", "用工类型"):
        try:
            loc = dlg.get_by_text(token).first
            if hover_loc(page, log, loc, label=f"dialog:{token}"):
                pause(page, log, 2.0)
        except Exception:
            log.add("miss", label=token)
    pause(page, log, 2.0, label="留存观察")
    click_loc(page, log, dlg.get_by_role("button", name="取消"), label="关闭")
    pause(page, log, 1.0)
    page.goto(BASE + "/shift-templates", wait_until="networkidle")
    pause(page, log, 2.2, label="模板列表")
    for name, dwell in (("早班", 2.0), ("中班", 2.0), ("晚班", 2.0), ("打烊班", 3.2)):
        try:
            card = page.get_by_text(name, exact=True).first
            if name == "打烊班":
                pause(page, log, 0.6, label="跨日强调前")
            if hover_loc(page, log, card, label=f"tpl:{name}"):
                pause(page, log, dwell)
        except Exception:
            log.add("miss", label=f"tpl:{name}")
    pause(page, log, 2.4)
    finish_scene(ctx, "s2_employees", log)


def s_schedule(browser):
    ctx, page, log = start_scene(browser, "s3_schedule")
    login(page, log)
    page.goto(BASE + "/schedule", wait_until="networkidle")
    pause(page, log, 6.0, label="周排班视图")
    cell = page.locator(f'[data-cell-name="冯婷"][data-cell-date="{SATURDAY}"]')
    assert cell.count() == 1, f"冯婷周六空格不存在: {SATURDAY}"
    click_loc(page, log, cell, label="冯婷周六", extra_wait=1.0)
    dlg = page.locator("#shift-dialog")
    dlg.wait_for(state="visible")
    pause(page, log, 2.4, label="对话框预填")
    tpl = page.locator("#sf-template")
    click_loc(page, log, tpl, label="班次模板下拉")
    page.wait_for_timeout(250)
    opt_val = page.locator("#sf-template option", has_text="中班").first.get_attribute("value")
    page.select_option("#sf-template", value=opt_val)
    log.add("select", label="选择中班模板")
    page.wait_for_timeout(700)
    for fid in ("sf-start", "sf-end", "sf-break", "sf-template"):
        try:
            if hover_loc(page, log, page.locator(f"#{fid}"), label=f"fill:{fid}"):
                pause(page, log, 1.2)
        except Exception:
            log.add("miss", label=fid)
    pause(page, log, 2.0, label="信息自动填充完成")
    click_loc(page, log, page.locator("#sf-submit"), label="添加/提交")
    page.wait_for_timeout(1500)
    conflict_box = page.locator("#sf-conflicts")
    conflict_box.wait_for(state="visible")
    pause(page, log, 6.0, label="阅读冲突详情")
    try:
        hover_loc(page, log, page.locator("#sf-force"), label="掠过仍要保存")
        page.wait_for_timeout(1100)
    except Exception:
        log.add("miss", label="sf-force")
    pause(page, log, 1.0)
    click_loc(page, log, page.locator("#sf-submit"), label="返回修改(再次检验被拦)")
    page.wait_for_timeout(1800)
    pause(page, log, 4.0, label="系统坚持返回修改")
    click_loc(page, log, dlg.locator("[data-dialog-close]").first, label="返回修改(取消关闭)")
    page.wait_for_timeout(1100)
    pause(page, log, 3.0, label="回到网格")
    slow_scroll(page, log, 260, steps=10, per=0.5)
    pause(page, log, 8.0, label="网格浏览收尾")
    finish_scene(ctx, "s3_schedule", log)


def s_conflict_panel(browser):
    ctx, page, log = start_scene(browser, "s4_conflict_panel")
    login(page, log)
    page.goto(BASE + "/schedule", wait_until="networkidle")
    pause(page, log, 2.0, label="排班页整体")
    # 先把“冲突和工作区提示”面板滚入画面，再聚焦逐条冲突
    slow_scroll(page, log, 380, steps=8, per=0.35)
    pause(page, log, 2.0, label="冲突面板整体")
    err = page.locator('[data-severity="error"]').first
    warn = page.locator('[data-severity="warning"]').first
    hover_loc(page, log, err, label="错误条目")
    pause(page, log, 5.0)
    hover_loc(page, log, warn, label="提示条目")
    pause(page, log, 5.0)
    # 回到网格看红色角标
    slow_scroll(page, log, -380, steps=8, per=0.35)
    flag = page.locator(".conflict-flag:visible").first
    try:
        if hover_loc(page, log, flag, label="网格角标"):
            pause(page, log, 4.0)
    except Exception:
        log.add("miss", label="flag")
    slow_scroll(page, log, 380, steps=8, per=0.35)
    pause(page, log, 3.5, label="面板与网格对照收尾")
    finish_scene(ctx, "s4_conflict_panel", log)


def s_hours_export(browser):
    ctx, page, log = start_scene(browser, "s5_hours")
    login(page, log)
    page.goto(BASE + f"/hours?period=week&date={TODAY.isoformat()}", wait_until="networkidle")
    pause(page, log, 5.0, label="按周视图")
    slow_scroll(page, log, 280, steps=8, per=0.35)
    page.wait_for_timeout(300)
    slow_scroll(page, log, -280, steps=8, per=0.35)
    with page.expect_navigation():
        click_loc(page, log, page.locator('a[href*="period=month"]').first, label="切换按月")
    page.wait_for_load_state("networkidle")
    pause(page, log, 5.0, label="按月视图")
    slow_scroll(page, log, 300, steps=8, per=0.35)
    page.wait_for_timeout(300)
    slow_scroll(page, log, -300, steps=8, per=0.35)
    pause(page, log, 1.0)
    try:
        with page.expect_download() as dl:
            click_loc(page, log, page.get_by_text("导出工时表").first, label="导出工时表")
        dl_path = dl.value
        target = DL_DIR / dl_path.suggested_filename or DL_DIR / "工时导出.xlsx"
        dl_path.save_as(str(target))
        log.add("download", path=str(target))
        print(f"[download] {target}")
        pause(page, log, 4.0, label="导出完成反馈")
    except Exception as e:
        log.add("export-failed", error=str(e))
    pause(page, log, 2.0)
    finish_scene(ctx, "s5_hours", log)


def s_settings(browser):
    ctx, page, log = start_scene(browser, "s6_settings")
    login(page, log)
    page.goto(BASE + "/settings", wait_until="networkidle")
    pause(page, log, 2.2, label="设置页")
    # 只展示最关键的 2–3 类规则：休息间隔与每周工时上限
    for sel in ("#st-rest", "#st-wf", "#st-wp"):
        loc = page.locator(sel)
        if loc.count():
            hover_loc(page, log, loc, label=sel)
            pause(page, log, 1.6)
    pause(page, log, 2.6)
    finish_scene(ctx, "s6_settings", log)


SCENES = [
    ("s1_overview", s_login_overview),
    ("s2_employees", s_employees_templates),
    ("s3_schedule", s_schedule),
    ("s4_conflict_panel", s_conflict_panel),
    ("s5_hours", s_hours_export),
    ("s6_settings", s_settings),
]


def main():
    wanted = sys.argv[1:]
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(channel="msedge", headless=HEADLESS)
        except Exception:
            browser = pw.chromium.launch(headless=HEADLESS)
        for name, fn in SCENES:
            if wanted and name not in wanted:
                continue
            print(f"--- {name} ---")
            guarded(fn, name)(browser)
        browser.close()


if __name__ == "__main__":
    main()
