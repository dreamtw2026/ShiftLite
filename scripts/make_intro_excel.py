# -*- coding: utf-8 -*-
"""生成片头示意用的“传统 Excel 排班表”（真实 xlsx 文件，后续在真实 Excel 中操作录制）。

仅用于演示视频片头的问题引入场景：手填姓名、无冲突检查、无工时规则。
文件输出到 scripts/output/intro_排班表.xlsx。
"""
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from pathlib import Path

OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(exist_ok=True)
OUT_FILE = OUT_DIR / "intro_排班表.xlsx"

days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
# 姓名 × 星期 的手填班次（早/中/晚/打烊），留空表示还没排
rows = [
    ("陈静", "早", "早", "中", "中", "早", "中", "打烊"),
    ("李慧", "早", "早", "早", "早", "早", "", ""),
    ("王强", "晚", "晚", "晚", "晚", "晚", "晚", ""),
    ("赵磊", "中", "", "中", "中", "早", "打烊", "中"),
    ("孙娜", "", "中", "早", "", "中", "中", ""),
    ("周杰", "晚", "晚", "中晚", "", "晚", "早中晚", "早"),
    ("吴敏", "晚", "晚", "晚", "晚", "打烊", "晚", "打烊"),
    ("郑浩", "", "", "", "", "晚", "晚", "中"),
    ("冯婷", "早", "", "早", "早", "早", "？", ""),
    ("许阳", "", "早", "", "", "", "早", "早"),
]

wb = Workbook()
ws = wb.active
ws.title = "本周排班"
ws.sheet_view.showGridLines = False

title_font = Font(name="微软雅黑", size=14, bold=True)
head_font = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
head_fill = PatternFill("solid", fgColor="C0504D")
name_font = Font(name="微软雅黑", size=11, bold=True)
note_font = Font(name="微软雅黑", size=10, color="C00000")
thin = Side(style="thin", color="BFBFBF")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
center = Alignment(horizontal="center", vertical="center")

ws.merge_cells("A1:I1")
ws["A1"] = "6月第2周 排班表（手工版）"
ws["A1"].font = title_font
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.row_dimensions[1].height = 24

ws.cell(row=2, column=1, value="-- 姓名")
ws.cell(row=2, column=1).font = name_font
for i, d in enumerate(days):
    c = ws.cell(row=2, column=2 + i, value=d)
    c.font = head_font
    c.fill = head_fill
    c.alignment = center
    c.border = border

for r, row in enumerate(rows, start=3):
    name_c = ws.cell(row=r, column=1, value=row[0])
    name_c.font = name_font
    name_c.border = border
    for i, v in enumerate(row[1:], start=2):
        c = ws.cell(row=r, column=i, value=v if v else None)
        c.font = Font(name="微软雅黑", size=10)
        c.alignment = center
        c.border = border
    ws.row_dimensions[r].height = 18

# 备注：手写备注模拟“工时全靠手算”
ws.cell(row=8, column=9, value="<- 郑浩周六+周日都要确认可来")
ws.cell(row=8, column=9).font = note_font

# 底部统计行：手工数工时
last = len(rows) + 3
ws.cell(row=last, column=1, value="每日人数").font = name_font
counts = [("统计", "4", "4", "5", "4", "5", "6", "4")]
for i, v in enumerate(counts[0][1:], start=2):
    c = ws.cell(row=last, column=i, value=v)
    c.font = Font(name="微软雅黑", size=10, bold=True)
    c.alignment = center
    c.border = border

for col, width in zip("ABCDEFGHI", (10, 7, 7, 7, 7, 7, 7, 7, 30)):
    ws.column_dimensions[col if col != "I" else "I"].width = width

# 工作表2：工时统计（手工口径，全职/兼职混在一起）
ws2 = wb.create_sheet("工时统计(手算)")
ws2.sheet_view.showGridLines = False
ws2.merge_cells("A1:D1")
ws2["A1"] = "上周工时汇总（手算，注意全职/兼职口径不同）"
ws2["A1"].font = title_font
head = ["姓名", "属性", "合计(小时)", "备注"]
for i, h in enumerate(head, start=1):
    c = ws2.cell(row=2, column=i, value=h)
    c.font = head_font
    c.fill = head_fill
    c.alignment = center
    c.border = border
data2 = [
    ("陈静", "全职", 41.5, "店长"),
    ("李慧", "全职", 37.5, ""),
    ("王强", "全职", 44.0, "接近上限?"),
    ("赵磊", "全职", 40.0, ""),
    ("孙娜", "全职", 31.5, ""),
    ("周杰", "兼职", 24.5, "兼职上限24h？超了没？"),
    ("吴敏", "兼职", 22.0, ""),
    ("郑浩", "兼职", 16.0, ""),
    ("冯婷", "兼职", 30.0, "?"),
    ("许阳", "兼职", 22.5, ""),
]
for r, row in enumerate(data2, start=3):
    for i, v in enumerate(row, start=1):
        c = ws2.cell(row=r, column=i, value=v)
        c.font = Font(name="微软雅黑", size=10)
        c.border = border
        if i != 1:
            c.alignment = center
for col, width in zip("ABCD", (10, 8, 12, 24)):
    ws2.column_dimensions[col].width = width

wb.save(OUT_FILE)
print(f"已生成：{OUT_FILE}")
