# -*- coding: utf-8 -*-
"""只重跑音频主控与最终合成（时间线已就绪，不重渲染画面块）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assemble as A

plan = A.audio_plan()
A.build_schedule_srt()
A.mix_audio(plan, A.TOTAL)

A.run([A.FF, "-y", "-hide_banner", "-loglevel", "error",
       "-i", str(A.AS / "timeline.mp4"), "-i", str(A.AS / "audio.m4a"),
       "-vf", (f"subtitles=subs.srt"
               ":force_style='FontName=Microsoft YaHei,FontSize=13,"
               "PrimaryColour=&H00FFFFFF,OutlineColour=&H96000000,Outline=1,"
               "Shadow=0,MarginV=48,Alignment=2'"
               f",fade=t=out:st={A.TOTAL - 1.2:.2f}:d=1.2"),
       "-c:v", "libx264", "-preset", "medium", "-crf", "18",
       "-pix_fmt", "yuv420p", "-r", str(A.FPS),
       "-c:a", "aac", "-b:a", "192k",
       "-map", "0:v", "-map", "1:a", "-shortest", "-movflags", "+faststart",
       str(A.FINAL)])
print(f"[done] {A.FINAL}")
