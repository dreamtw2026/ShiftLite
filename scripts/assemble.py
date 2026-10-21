# -*- coding: utf-8 -*-
"""ShiftLite 演示视频自动装配（目标 3:28.8=208.8s，1920x1080@30fps，H.264+AAC）。

流水线：
  1) 各场景 webm → 统一 base mp4（1080p/30fps）
  2) CLIP_PLAN 数据驱动：真实子段（可慢放 1.15–1.35x）+ 关键区域平滑推近（zoompan）
     + 末段以缓推(Ken Burns)补齐，不再使用纯静帧
  3) 片头：真实 Excel 操作段（痛点字幕叠加）+ 群聊示意（缓推）+ 项目名卡
  4) 字幕 SRT（旁白原文，按真实语音时长自动排布；长句拆两行，细描边无阴影）
  5) 音频：逐条旁白定点排布 + 音乐侧链避让（-6~10dB）+ loudnorm 两段式
     （I=-16 LUFS / TP≤-1.5 dBTP）
  6) 合成 scripts/output/shiftlite_demo_1080p.mp4
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from narration import NARRATION

FF = ("C:\\Users\\He-TW\\AppData\\Local\\Python\\pythoncore-3.14-64\\Lib\\"
      "site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe")
ROOT = Path(__file__).resolve().parents[1]
REC = ROOT / "scripts" / "output" / "recordings"
AS = ROOT / "scripts" / "output" / "assemble"
AS.mkdir(parents=True, exist_ok=True)
MUSIC = ROOT / "music" / "若如初见.mp3"
VOICE = ROOT / "scripts" / "output" / "voice"
FINAL = ROOT / "scripts" / "output" / "shiftlite_demo_1080p.mp4"

TOTAL = 208.8
FPS = 30
ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
          "-pix_fmt", "yuv420p", "-r", str(FPS), "-an"]


def run(args, **kw):
    kw.setdefault("cwd", str(AS))
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", **kw)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败:\n{p.stderr[-1600:]}")
    return p


def probe_duration(path: Path) -> float:
    p = subprocess.run([FF, "-hide_banner", "-i", str(path)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", p.stderr)
    return float(m[1]) * 3600 + float(m[2]) * 60 + float(m[3]) if m else 0.0


# ---------- 1. bases ----------

def bases():
    for webm in sorted(REC.glob("*.webm")):
        out = AS / f"base_{webm.stem}.mp4"
        if not out.exists():
            run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", str(webm),
                 "-vf", f"scale=1920:1080:flags=lanczos,fps={FPS},format=yuv420p",
                 *ENCODE, str(out)])
        yield webm, out


def anchor(label: str, scene: str, offset: float = 0.0) -> float:
    data = json.loads((REC / f"{scene}.events.json").read_text(encoding="utf-8"))
    for item in data:
        if item.get("label") == label:
            return max(0.0, item["t"] - offset)
    raise KeyError(f"未找到锚点 {label}（{scene}）")


def seg(src, a: float, b: float, out: Path, speed: float = 1.0, crop916: bool = False):
    if b <= a:
        a, b = 0.0, 0.5
    b = min(b, probe_duration(Path(src)) - 0.05)   # 钳制到素材长度
    if b <= a:
        raise RuntimeError(f"素材过短：{src}")
    sr = "" if abs(speed - 1.0) < 1e-6 else f"setpts={speed:.3f}*PTS,"
    # 自适应 16:9 居中裁剪（先裁宽，再裁高，兼容任意源分辨率）
    pre = ("crop=w='min(in_w\\,in_h*16/9)':h=in_h:x='(in_w-out_w)/2':y=0,"
           "crop=h='min(in_h\\,in_w*9/16)':x=0:y='(in_h-out_h)/2',"
           ) if crop916 else ""
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}",
         "-i", str(src), "-vf",
         sr + pre + f"scale=1920:1080:flags=lanczos,fps={FPS},format=yuv420p",
         *ENCODE, str(out)])
    return (b - a) / speed


def hold_clip(scene: str, dur: float, out: Path):
    base = AS / f"base_{scene}.mp4"
    png = AS / f"hold_{scene}.png"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.3", "-i", str(base),
         "-update", "1", "-frames:v", "1", str(png)])
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", str(png),
         "-t", f"{dur:.3f}", *ENCODE, str(out)])
    out.with_suffix(".png").unlink(missing_ok=True)


def _smooth(expr: str) -> str:
    return f"(pow(clip({expr},0,1),2)*(3-2*clip({expr},0,1)))"


def zoom_seg(src, a: float, b: float, out: Path, cx: float, cy: float,
             z0: float = 1.0, z1: float = 1.4, ease_in: float = 0.0, ease_out: float = 0.0):
    """从全画幅平滑推近到 (cx, cy) 处 z1 倍，结尾可缓出回到全画幅。不走样（16:9→16:9）。"""
    if b <= a:
        a, b = 0.0, 0.5
    b = min(b, probe_duration(Path(src)) - 0.05)
    dur = b - a
    fps = FPS
    n = max(1, int(round(dur * fps)))
    zi = int(min(ease_in, dur * 0.45) * fps)
    zo = int(min(ease_out, dur * 0.45) * fps)
    up = (f"{z0:.4f}+({z1 - z0:+.4f})*"
          + (_smooth(f"in/{zi}") if zi else "0")
          + f"-({z1 - z0:+.4f})*"
          + (_smooth(f"(in-({n - zo}))/{zo}") if zo else "0"))
    x = f"clip(2*{cx:.1f}-iw/zoom/2,0,iw-iw/zoom)"
    y = f"clip(2*{cy:.1f}-ih/zoom/2,0,ih-ih/zoom)"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{dur:.3f}",
         "-i", str(src), "-vf",
         f"scale=3840:2160:flags=lanczos,"
         f"zoompan=z='{up}':x='{x}':y='{y}':d=1:s=3840x2160:fps={fps},"
         f"scale=1920:1080:flags=lanczos,format=yuv420p",
         *ENCODE, str(out)])
    return dur


def kb_pad(scene: str, dur: float, out: Path):
    """末帧缓推补齐（替代纯静帧）：取场景末帧做 1.00→1.12 慢推。"""
    base = AS / f"base_{scene}.mp4"
    png = AS / f"hold_{scene}.png"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.3", "-i", str(base),
         "-update", "1", "-frames:v", "1", str(png)])
    n = max(1, int(dur * FPS))
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", str(png),
         "-t", f"{dur:.3f}", "-vf",
         f"scale=3840:2160:flags=lanczos,"
         f"zoompan=z='{_smooth(f'in/{n}')}*0.12+1':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2'"
         f":d=1:s=3840x2160:fps={FPS},"
         f"scale=1920:1080:flags=lanczos,format=yuv420p",
         *ENCODE, str(out)])
    png.unlink(missing_ok=True)


def concat_block(parts: list[Path], out: Path):
    listfile = out.with_suffix(".txt")
    listfile.write_text("\n".join(f"file '{p.as_posix()}'" for p in parts), encoding="utf-8")
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listfile), "-c", "copy", str(out)])


def name_seg(img: Path, dur: float, out: Path):
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", str(img),
         "-t", f"{max(0.5, dur):.3f}", "-vf",
         f"scale=1920:1080,fade=t=in:st=0.2:d=0.8,format=yuv420p", *ENCODE, str(out)])


def render_part(op, out: Path) -> float:
    kind = op[0]
    if kind == "seg":
        _, scene, a, b, speed = op
        return seg(AS / f"base_{scene}.mp4", a, b, out, speed)
    if kind == "zoom":
        _, scene, a, b, cx, cy, z0, z1, ei, eo = op
        return zoom_seg(AS / f"base_{scene}.mp4", a, b, out, cx, cy, z0, z1, ei, eo)
    if kind == "hold":
        _, scene, dur = op
        hold_clip(scene, dur, out)
        return dur
    if kind == "mods":
        return seg(AS / "base_None.mp4", 0, 1, out)
    if kind == "excel":
        _, path, a, b = op
        return seg(path, a, b, out, 1.0, crop916=True)
    if kind == "namecard":
        _, dur, fade = op
        run([FF, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1",
             "-i", str(ROOT / "scripts" / "output" / "end_namecard.png"), "-t", f"{dur:.3f}", "-vf",
             "scale=1920:1080,fade=t=in:st=0.15:d=0.7,format=yuv420p",
             *ENCODE, str(out)])
        return dur
    raise ValueError(op)


# ---------- 2. CLIP PLAN（全部真实素材；zoom 为局部平滑推近） ----------

def plan_s1():
    a = anchor("stat:本周排班班次", "s1_overview", 3.8)
    return [("seg", "s1_overview", a, 999.0, 1.0)]


def plan_s2():
    a = anchor("员工列表", "s2_employees", 0.4)
    return [
        ("seg", "s2_employees", a, a + 13.0, 1.0),
        # 员工可用时段弹窗：放大弹窗内容（模板、可排班日、时段字段）
        ("zoom", "s2_employees", a + 13.0, a + 20.0, 960, 540, 1.0, 1.40, 0.8, 0.6),
        ("seg", "s2_employees", a + 20.0, 999.0, 1.0),
    ]


def plan_s3():
    a = anchor("周排班视图", "s3_schedule", 0.3)
    return [
        ("seg", "s3_schedule", a, a + 11.0, 1.0),
        # 选择中班模板与自动填充：放大弹窗（模板 + 时间字段）
        ("zoom", "s3_schedule", a + 11.0, a + 20.2, 980, 540, 1.0, 1.50, 0.9, 0.0),
        # 冲突结果与两个处理出口：再深入推近冲突说明与按钮区
        ("zoom", "s3_schedule", a + 20.2, a + 34.3, 960, 700, 1.50, 1.75, 0.8, 0.8),
        ("seg", "s3_schedule", a + 34.3, 999.0, 1.0),
    ]


def plan_s4():
    a = anchor("排班页整体", "s4_conflict_panel", 0.3)
    return [
        ("seg", "s4_conflict_panel", a, a + 5.8, 1.0),
        # 冲突面板整体推近：聚焦错误/提示条目与“冲突原因/具体数字”
        ("zoom", "s4_conflict_panel", a + 5.8, a + 17.7, 960, 900, 1.0, 1.50, 0.9, 0.7),
        ("seg", "s4_conflict_panel", a + 17.7, a + 20.2, 1.0),
        # 网格红色/黄色角标
        ("zoom", "s4_conflict_panel", a + 20.5, a + 24.3, 610, 350, 1.0, 1.60, 0.7, 0.7),
        ("seg", "s4_conflict_panel", a + 24.3, a + 29.4, 1.0),
    ]


def plan_s5():
    a = anchor("按周视图", "s5_hours", 0.3)
    return [
        ("seg", "s5_hours", a, a + 8.15, 1.0),
        # 周视图表格：放大“有效工时 + 每日工时”列
        ("zoom", "s5_hours", a + 8.15, a + 11.35, 1150, 400, 1.0, 1.50, 0.7, 0.5),
        ("seg", "s5_hours", a + 11.35, a + 12.85, 1.0),
        ("seg", "s5_hours", a + 12.85, a + 17.05, 1.0),
        # 月视图表格：放大姓名、有效工时、周上限与合计行
        ("zoom", "s5_hours", a + 17.05, a + 19.65, 950, 420, 1.0, 1.35, 0.6, 0.4),
        ("seg", "s5_hours", a + 19.65, a + 25.02, 1.0),
        # Excel 客户区 + 放大姓名/工时/合计列
        ("excel", str(REC / "hours_excel.mp4"), 6.0, 13.0),
    ]


def plan_s6():
    a = anchor("设置页", "s6_settings", 0.3)
    return [
        ("seg", "s6_settings", a, a + 2.4, 1.0),
        # 放大规则区：休息间隔 + 每周工时上限
        ("zoom", "s6_settings", a + 2.4, a + 9.7, 620, 690, 1.0, 1.50, 0.9, 1.0),
        ("namecard", 6.1, True),
    ]


PLAN_MAKERS = {"s1_overview": plan_s1, "s2_employees": plan_s2, "s3_schedule": plan_s3,
               "s4_conflict_panel": plan_s4, "s5_hours": plan_s5, "s6_settings": plan_s6}
BLOCK_STARTS = {"intro": 0.0, "s1_overview": 24.0, "s2_employees": 48.0,
                "s3_schedule": 86.0, "s4_conflict_panel": 132.0,
                "s5_hours": 161.0, "s6_settings": 193.0}


def render_block(key: str, span: float, out: Path):
    ops = PLAN_MAKERS[key]()
    parts = []
    total = 0.0
    for i, op in enumerate(ops):
        p = AS / f"part_{key}_{i:02d}.mp4"
        total += render_part(op, p)
        parts.append(p)
    # 末段缓推(Ken Burns)自动补齐到 span；超出则压缩最后一个 seg
    deficit = span - total
    if deficit > 0.06:
        last_scene = next(op[1] for op in reversed(ops)
                          if op[0] in ("seg", "hold", "zoom"))
        p = AS / f"part_{key}_pad.mp4"
        kb_pad(last_scene, deficit, p)
        parts.append(p)
        total += deficit
    elif deficit < -0.06:
        over = -deficit
        i = max(i for i, op in enumerate(ops) if op[0] == "seg")
        d = probe_duration(parts[i]) - over
        fixed = AS / f"part_{key}_t.mp4"
        run([FF, "-y", "-hide_banner", "-loglevel", "error", "-t", f"{d:.3f}", "-i",
             str(parts[i]), "-c", "copy", str(fixed)])
        parts[i].unlink()
        fixed.rename(parts[i])
        total -= over
    concat_block(parts, out)
    return out, total


# ---------- 3. 片头 ----------

PAINPOINTS = [(3.0, 7.5, "冲突靠人眼"), (7.5, 11.5, "规则靠记忆"), (11.5, 14.5, "月底汇总繁琐")]


def render_intro(name_card: Path, span: float):
    parts = []
    excel = REC / "intro_excel.mp4"
    assert excel.exists()
    seg(excel, 0, 14, AS / "part_intro_excel.mp4", 1.0, crop916=True)
    overlay = ",".join(
        ("drawtext=fontfile=msyhbd.ttc:fontsize=54:fontcolor=white:"
         f"text='{t}':box=1:boxcolor=0xB3202126@0.62:boxborderw=22:"
         f"x=(w-text_w)/2:y=h-190:enable='between(t,{s},{e})'"
         ) for s, e, t in PAINPOINTS)
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", str(AS / "part_intro_excel.mp4"),
         "-vf", f"{overlay},format=yuv420p", *ENCODE, str(AS / "part_intro_excel_t.mp4")])
    parts.append(AS / "part_intro_excel_t.mp4")

    chat = ROOT / "scripts" / "output" / "intro_chat.png"
    assert chat.exists()
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", str(chat),
         "-t", "6", "-vf",
         f"scale=1920:1080,fade=t=in:st=0.15:d=0.6,format=yuv420p",
         *ENCODE, str(AS / "part_intro_chat.mp4")])
    parts.append(AS / "part_intro_chat.mp4")

    rest = span - 20.0
    name_seg(name_card, rest, AS / "part_intro_name.mp4")
    parts.append(AS / "part_intro_name.mp4")
    out = AS / "block_intro.mp4"
    concat_block(parts, out)
    return out


# ---------- 4. 字幕 ----------

def srt_time(t: float) -> str:
    h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60)
    return f"{h:02}:{m:02}:{s:02},{int((t - int(t)) * 1000):03}"


def _wrap_cn(text: str) -> str:
    """长句在中位附近的「，、：」处拆成两行（ASS 换行符 \\N）。"""
    if len(text) <= 20:
        return text
    best = None
    for idx, ch in enumerate(text):
        if ch in "，、：" and 4 < idx < len(text) - 4:
            d = abs(idx - len(text) / 2)
            if best is None or d < best[0]:
                best = (d, idx)
    if best is None:
        return text
    i = best[1]
    return text[:i + 1] + "\\N" + text[i + 1:]


def build_schedule_srt():
    plan = json.loads((AS / "audio_plan.json").read_text(encoding="utf-8"))
    slots = plan["slots"]; durs = plan["durs"]
    srt = []
    for i, (start, text) in enumerate(slots):
        end = start + durs[i] + 0.4
        if i + 1 < len(slots):
            end = min(end, slots[i + 1][0] - 0.15)
        srt.append(f"{i + 1}\n{srt_time(start)} --> {srt_time(max(end, start + 0.8))}"
                   f"\n{_wrap_cn(text)}\n")
    (AS / "subs.srt").write_text("\n".join(srt), encoding="utf-8")


# ---------- 5. 音频计划与混音 ----------

def audio_plan():
    blocks = [(0, 3, 0.0), (3, 2, 24.0), (5, 4, 48.0), (9, 4, 86.0),
              (13, 3, 132.0), (16, 3, 161.0), (19, 2, 193.0)]
    durs = [probe_duration(VOICE / f"line_{i:02d}.mp3") for i in range(len(NARRATION))]
    slots = []
    for i0, cnt, bstart in blocks:
        carry = 0.0
        for j in range(cnt):
            i = i0 + j
            s = NARRATION[i][0] + carry
            e = s + durs[i]
            if j + 1 < cnt:
                nxt_target = NARRATION[i0 + j + 1][0]
                if e + 0.6 > nxt_target:
                    carry += (e + 0.6) - nxt_target
            slots.append([s, NARRATION[i][2]])
    plan = {"slots": slots, "durs": durs}
    (AS / "audio_plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1),
                                        encoding="utf-8")
    # 报告溢出
    last_start = slots[-1][0] + durs[-1]
    print(f"[audio] 最后一句结束于 {last_start:.1f}s（应 ≤ 209.5）")
    return plan


def mix_audio(plan: dict, total: float):
    """旁白按点排布；音乐经 侧链压缩 自动避让人声（-6~10dB）；最终 loudnorm 两段式。"""
    n = len(plan["slots"])
    args = [FF, "-y", "-hide_banner", "-loglevel", "error"]
    fparts = []
    for i, (start, _) in enumerate(plan["slots"]):
        args += ["-i", str(VOICE / f"line_{i:02d}.mp3")]
        ms = int(start * 1000)
        fparts.append(f"[{i}:a]aresample=44100,adelay={ms}|{ms}[v{i}]")
    args += ["-stream_loop", "-1", "-i", str(MUSIC)]
    fparts.append(
        f"[{n}:a]aresample=44100,atrim=0:{total:.2f},volume=0.25,"
        f"afade=t=in:st=0:d=2.5,afade=t=out:st={total - 6:.2f}:d=6[bgmin]")
    fparts.append("".join(f"[v{i}]" for i in range(n)) +
                  f"amix=inputs={n}:normalize=0:dropout_transition=0[vox]")
    # 侧链：bgm 为主输入，旁白和为侧链；ratio 低、阈值高 → 平缓 6–10dB 压低
    fparts.append(
        "[bgmin][vox]sidechaincompress=threshold=0.06:ratio=2.0:attack=25:"
        "release=420:makeup=1[bgmd]")
    fparts.append("[vox][bgmd]amix=inputs=2:normalize=0:dropout_transition=0[mix]")
    args += ["-filter_complex", ";".join(fparts), "-map", "[mix]",
             "-c:a", "pcm_s16le", "-t", f"{total:.2f}", str(AS / "mix_raw.wav")]
    run(args)

    # 主控：动态 loudnorm 达标 -16 LUFS，再经峰值限幅，真峰值 ≤ -1.5 dBTP
    # （线性两段式在需要 +6dB 以上增益时会超出真峰值预算，故用动态模式）
    p = subprocess.run(
        [FF, "-hide_banner", "-nostats", "-i", str(AS / "mix_raw.wav"),
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
         "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr, re.S)
    meas = json.loads(m[0]) if m else None
    limit = 0.63        # ≈ -4.0 dBFS 采样峰值，为 AAC 编码后真峰值留余量
    ln = "loudnorm=I=-16:TP=-1.5:LRA=11"
    chain = ln + f",alimiter=limit={limit}:attack=5:release=80:level=0"
    run([FF, "-y", "-hide_banner", "-loglevel", "error", "-i", str(AS / "mix_raw.wav"),
         "-af", chain + ",aresample=44100", "-ar", "44100",
         "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.2f}", str(AS / "audio.m4a")])
    if meas:
        print(f"[audio] 输入 I={meas.get('input_i')} TP={meas.get('input_tp')}")


# ---------- 6. 大流股 ----------

def main():
    for f in ("msyh.ttc", "msyhbd.ttc"):
        fp = AS / f
        if not fp.exists():
            shutil.copy(rf"C:\Windows\Fonts\{f}", fp)
    plan = audio_plan()
    base_by_stem = {webm.stem: out for webm, out in bases()}
    assert set(base_by_stem) == set(PLAN_MAKERS), base_by_stem

    name_card = ROOT / "scripts" / "output" / "intro_namecard.png"
    assert name_card.exists()
    assert (ROOT / "scripts" / "output" / "end_namecard.png").exists()

    blocks: list[tuple[float, Path]] = [
        (0.0, render_intro(name_card, 24.0))]
    spans = {"s1_overview": 24.0, "s2_employees": 38.0, "s3_schedule": 46.0,
             "s4_conflict_panel": 29.0, "s5_hours": 32.0, "s6_settings": 15.8}
    for key, span in spans.items():
        out, total = render_block(key, span, AS / f"block_{key}.mp4")
        blocks.append((BLOCK_STARTS[key], out))
        print(f"[block] {key}: span={span} actual={total:.2f}")

    blocks.sort(key=lambda x: x[0])
    concat_block([b[1] for b in blocks], AS / "timeline.mp4")
    t_total = probe_duration(AS / "timeline.mp4")
    print(f"[timeline] {t_total:.2f}s")
    assert abs(t_total - TOTAL) < 0.8, f"总时长偏差 {t_total:.2f}"

    build_schedule_srt()
    mix_audio(plan, TOTAL)

    run([FF, "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(AS / "timeline.mp4"), "-i", str(AS / "audio.m4a"),
         "-vf", (f"subtitles=subs.srt"
                 ":force_style='FontName=Microsoft YaHei,FontSize=13,"
                 "PrimaryColour=&H00FFFFFF,OutlineColour=&H96000000,Outline=1,"
                 "Shadow=0,MarginV=48,Alignment=2'"
                 f",fade=t=out:st={TOTAL - 1.2:.2f}:d=1.2"),
         "-c:v", "libx264", "-preset", "medium", "-crf", "18",
         "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", "192k",
         "-map", "0:v", "-map", "1:a", "-shortest", "-movflags", "+faststart",
         str(FINAL)])
    print(f"[done] {FINAL}")


if __name__ == "__main__":
    main()
