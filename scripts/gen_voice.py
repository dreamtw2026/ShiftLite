# -*- coding: utf-8 -*-
"""生成旁白配音：edge-tts（自然沉稳男声 zh-CN-YunjianNeural）。

每行旁白 → output/voice/line_XX.mp3，写入 voice_index.json（文件、文案）。
行内停顿由分镜自然控制；拼装时在 assemble.py 中精确对齐。
"""
import asyncio
import json
from pathlib import Path

import edge_tts

from narration import NARRATION

OUT = Path(__file__).resolve().parent / "output" / "voice"
OUT.mkdir(parents=True, exist_ok=True)
VOICE = "zh-CN-YunjianNeural"
RATE = "-4%"   # 略慢，沉稳
PITCH = "-1Hz"


async def gen(text: str, path: Path):
    tts = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
    await tts.save(str(path))


async def main():
    index = []
    for i, (_, _, text) in enumerate(NARRATION):
        path = OUT / f"line_{i:02d}.mp3"
        await gen(text, path)
        index.append({"i": i, "file": path.name, "text": text})
        print(f"[ok] line_{i:02d}: {text[:18]}…")
    (OUT / "voice_index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
