# -*- coding: utf-8 -*-
"""绘制片头群聊示意画面（1920x1080，PIL，纯装饰性示意素材）。

注意：这是“示意画面”——观众一眼可见其为简洁示意，不代表任何真实聊天软件。
输出 scripts/output/intro_chat.png；并生成群聊里展示的排班“照片”缩略图。
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "output"
OUT.mkdir(parents=True, exist_ok=True)

FONT = r"C:\Windows\Fonts\msyh.ttc"
W, H = 1920, 1080


def mszh(size: int, bold: bool = False):
    return ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc" if bold else FONT,
                              size, index=0 if not bold else 1)


def wrap(draw, text, font, max_w):
    lines, cur = [], ""
    for ch in text:
        if draw.textlength(cur + ch, font=font) > max_w:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


# ---------------- 排班“照片”缩略图（聊天中发送的排班表照片） ----------------
def draw_schedule_photo() -> None:
    img = Image.new("RGB", (760, 560), "#f5f6f8")
    d = ImageDraw.Draw(img)
    head = mszh(34, bold=True)
    d.rectangle([0, 0, 759, 88], fill="#d9534f")
    d.text((36, 22), "6月第2周 排班表（手工版）", font=head, fill="#ffffff")
    f = mszh(26)
    fb = mszh(28, bold=True)
    xs = [40] + [40 + 96 * i for i in range(1, 8)]
    days = ["一", "二", "三", "四", "五", "六", "日"]
    for i, day in enumerate(days):
        d.text((xs[i + 1], 104), day, font=f, fill="#666666")
    rows = [("陈静", "早 早 中 中 早 中 打"), ("李慧", "早 早 早 早 早   "),
            ("王强", "晚 晚 晚 晚 晚 晚  "), ("周杰", "晚 晚 中晚  晚 早中晚 早"),
            ("冯婷", "早  早 早 早 ？  "), ("许阳", " 早   早 早")]
    for r, (name, line) in enumerate(rows):
        y = 150 + r * 56
        d.text((40, y), name, font=fb, fill="#333333")
        tokens = line.split(" ")
        for i, tk in enumerate(tokens):
            if tk:
                d.text((40 + 96 * (i + 1), y), tk, font=f, fill="#444444")
    # 一条手划的对勾与问号做拥挤感
    d.ellipse([698, 418, 734, 454], outline="#e74c3c", width=4)
    d.text((705, 419), "？", font=mszh(30, bold=True), fill="#e74c3c")
    img.save(OUT / "intro_chat_photo.png")


# ---------------- 群聊界面 ----------------
def draw_chat() -> None:
    img = Image.new("RGB", (W, H), "#e8ebee")
    d = ImageDraw.Draw(img)
    # 顶栏
    d.rectangle([0, 0, W, 104], fill="#4b5563")
    d.text((56, 28), "门店排班群（10）", font=mszh(44, bold=True), fill="#ffffff")

    def bubble(x, y, lines, mine=False, photo=False):
        pad = 26
        bh = 24 + 46 * len(lines)
        bw = max(d.textlength(line, font=mszh(34)) for line in lines) + pad * 2
        if photo:
            bw, bh = 780, 590
        color = (149, 213, 178) if mine else (255, 255, 255)
        radius = 24
        d.rounded_rectangle([x, y, x + bw, y + bh], radius=radius, fill=color)
        cy = y + 18
        for line in lines:
            size = 34
            font = mszh(size)
            d.text((x + pad, cy), line, font=font,
                   fill="#333333" if mine else "#333333")
            cy += 46
        if photo:
            p = Image.open(OUT / "intro_chat_photo.png")
            d.rounded_rectangle([x, y, x + bw, y + bh], radius=radius, fill=(255, 255, 255))
            d.rectangle([x, y, x + bw, y + bh], outline="#d1d5db", width=2)
            d.ellipse([x + 28, y + 22, x + 56, y + 50], fill="#cccccc")
            p_small = p.resize((bw - 56, int(560 * (bw - 56) / 760)))
            img.paste(p_small, (x + 28, y + 62))

    # 消息流（别人=左，自己=右）
    bubble(120, 150, ["各位，下周排班表发群里啦～", "大家看看有没有空"])
    photo = Image.open(OUT / "intro_chat_photo.png")
    # 带图消息
    bx, by = 120, 320
    bw, bh = 800, 620
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=24, fill="#ffffff")
    p_small = photo.resize((bw - 56, int(560 * (bw - 56) / 760)))
    img.paste(p_small, (bx + 28, by + 60))
    d.text((bx + 28, by + 18), "📷", font=mszh(30))
    bubble(1180, 990, ["收到"], mine=True)
    bubble(120, 1000, ["冯婷周六来不了哦…"])
    d.text((940, 1032), "（示意画面）", font=mszh(30), fill="#9aa2ad")
    img.save(OUT / "intro_chat.png")


if __name__ == "__main__":
    draw_schedule_photo()
    draw_chat()
    print("intro chat assets ready:", OUT)
