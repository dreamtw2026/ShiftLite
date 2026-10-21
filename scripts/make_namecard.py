# -*- coding: utf-8 -*-
"""片头/片尾的名称卡与标语卡（PIL 绘制，1920x1080）。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "output"
OUT.mkdir(parents=True, exist_ok=True)


def font(path, size, idx=0):
    return ImageFont.truetype(path, size, index=idx)


MSYH = r"C:\Windows\Fonts\msyh.ttc"
MSYHB = r"C:\Windows\Fonts\msyhbd.ttc"


def namecard():
    img = Image.new("RGB", (1920, 1080), "#faf7f2")   # 米 beige，与系统主题同源
    d = ImageDraw.Draw(img)
    # 顶部装饰：三枚圆角小块（与系统“班次块”语义同形）
    d.rounded_rectangle([952, 380, 972, 420], 8, fill="#e8a33d")
    d.rounded_rectangle([952, 428, 972, 468], 8, fill="#c96f4a")
    d.rounded_rectangle([992, 380, 1012, 440], 8, fill="#5d9741")

    d.text((960, 470), "轻排班 ShiftLite", font=font(MSYHB, 96, 1), fill="#3d3a35",
           anchor="mm")
    d.text((960, 590), "让排班从记忆和人工核对，变成看得见的规则。",
           font=font(MSYH, 40), fill="#6b6559", anchor="mm")

    # 名字卡用于片头 20–25s；片尾复用同一张（含边界说明时另存）
    img.save(OUT / "intro_namecard.png")

    # 片尾卡：附加合规边界小字
    d.text((960, 680), "规则默认值为演示口径，正式使用请结合当地法规与门店制度确认",
           font=font(MSYH, 24), fill="#9a948a", anchor="mm")
    img.save(OUT / "end_namecard.png")


if __name__ == "__main__":
    namecard()
    print("namecards ready")
