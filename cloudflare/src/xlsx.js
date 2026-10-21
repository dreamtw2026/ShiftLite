// 轻排班 · Workers 版 Excel 导出
// 不依赖第三方包：用“不压缩（STORE）的 ZIP”直接拼装 .xlsx（OOXML）。
// 结构与 Python 版 core/exporter.py 相同的两张表；样式为基础版（表头填充 + 合计行底色）。

import { WEEKDAY_NAMES } from "./core.js";

const THEME = {
  header_fill: "E9DDC8",
  total_fill: "F1EBDD",
  text: "292720",
  title_color: "78664F",
};

// ---------- XML 工具 ----------

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** 列号转字母：1→A, 27→AA */
function colName(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cell(row, col, value) {
  const ref = `${colName(col)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  const text = value == null ? "" : String(value);
  if (text === "") return `<c r="${ref}" s="0"/>`;
  return `<c r="${ref}" t="inlineStr" s="0"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXML(rows, widths, freezeRow) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const body = rows.map((r) => `<row r="${r.r}"${r.ht ? ` ht="${r.ht}" customHeight="1"` : ""}>${r.cells.join("")}</row>`).join("");
  const pane = freezeRow
    ? `<sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews>${pane}</sheetViews>
<cols>${cols}</cols>
<sheetData>${body}</sheetData>
</worksheet>`;
}

// ---------- 最小 ZIP（STORE，无压缩） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, text }] → zip 字节（UTF-8 文件名，STORE 方式） */
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = enc.encode(f.text);
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名标志
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, pos); pos += c.length; }
  return out;
}

function workbookBundle(sheets) {
  // sheets: [{ name, xml }]
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  // 样式：s0 默认 / s1 标题（加粗+主色字）/ s2 表头（加粗+主色容器填充）/ s3 合计行（加粗+合计底色）
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><color rgb="FF${THEME.text}"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF${THEME.title_color}"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF${THEME.text}"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${THEME.header_fill}"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${THEME.total_fill}"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`;
  const files = [
    { name: "[Content_Types].xml", text: ct },
    { name: "_rels/.rels", text: rels },
    { name: "xl/workbook.xml", text: workbook },
    { name: "xl/_rels/workbook.xml.rels", text: wbRels },
    { name: "xl/styles.xml", text: styles },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: s.xml })),
  ];
  return zipStore(files);
}

// ---------- 两张报表 ----------

/** rows: [{work_date, weekday, employee_name, position, start_time, end_time, break_minutes, effective_hours, note}] */
export function exportScheduleXlsx(rows, storeName, startISO, endISO) {
  const grid = [];
  let r = 1;
  grid.push({ r, cells: [cell(r, 1, `${storeName} 排班表（${startISO} 至 ${endISO}）`)], ht: 26 });
  r += 1;
  const headers = ["日期", "星期", "员工", "岗位", "班次时段", "休息(分钟)", "有效工时(小时)", "备注"];
  grid.push({ r, cells: headers.map((h, i) => { const c = cell(r, i + 1, h); return c.replace(' s="0"', ' s="2"'); }) });
  r += 1;
  for (const row of rows) {
    grid.push({ r, cells: [
      cell(r, 1, row.work_date), cell(r, 2, row.weekday), cell(r, 3, row.employee_name),
      cell(r, 4, row.position || ""), cell(r, 5, `${row.start_time}–${row.end_time}`),
      cell(r, 6, Number(row.break_minutes || 0)), cell(r, 7, Math.round(row.effective_hours * 100) / 100),
      cell(r, 8, row.note || ""),
    ] });
    r += 1;
  }
  const sheet = sheetXML(grid, [12, 7, 10, 12, 16, 11, 14, 20], 2);
  return workbookBundle([{ name: "排班表", xml: sheet }]);
}

/** summary: summarize() 输出；dayColumns: [{iso, label}] | null */
export function exportHoursXlsx(storeName, periodLabel, summary, dayColumns = null) {
  const grid = [];
  let r = 1;
  const headers = ["员工", "岗位", "类型", "班次数", "排班时长(小时)", "休息时长(小时)", "有效工时(小时)"];
  if (dayColumns) headers.push(...dayColumns.map((d) => d.label));
  grid.push({ r, cells: [cell(r, 1, `${storeName} 工时统计（${periodLabel}）`)], ht: 26 });
  r += 1;
  grid.push({ r, cells: headers.map((h, i) => cell(r, i + 1, h).replace(' s="0"', ' s="2"')) });
  r += 1;
  for (const item of summary) {
    const cells = [
      cell(r, 1, item.name), cell(r, 2, item.position || ""), cell(r, 3, item.type_label),
      cell(r, 4, item.shifts),
      cell(r, 5, Math.round((item.scheduled_minutes / 60) * 100) / 100),
      cell(r, 6, Math.round((item.break_minutes / 60) * 100) / 100),
      cell(r, 7, Math.round((item.effective_minutes / 60) * 100) / 100),
    ];
    if (dayColumns) {
      dayColumns.forEach((d, i) => {
        cells.push(cell(r, 8 + i, Math.round(((item.by_date[d.iso] ?? 0) / 60) * 100) / 100));
      });
    }
    grid.push({ r, cells });
    r += 1;
  }
  const total = ["合计", "", "",
    summary.reduce((s, i) => s + i.shifts, 0),
    Math.round((summary.reduce((s, i) => s + i.scheduled_minutes, 0) / 60) * 100) / 100,
    Math.round((summary.reduce((s, i) => s + i.break_minutes, 0) / 60) * 100) / 100,
    Math.round((summary.reduce((s, i) => s + i.effective_minutes, 0) / 60) * 100) / 100];
  if (dayColumns) {
    dayColumns.forEach((d) => {
      total.push(Math.round((summary.reduce((s, item) => s + (item.by_date[d.iso] ?? 0), 0) / 60) * 100) / 100);
    });
  }
  grid.push({ r, cells: total.map((v, i) => cell(r, i + 1, v).replace(' s="0"', ' s="3"')) });
  const widths = [10, 12, 7, 8, 14, 13, 14, ...(dayColumns ?? []).map(() => 9)];
  const sheet = sheetXML(grid, widths, 2);
  return workbookBundle([{ name: "工时统计", xml: sheet }]);
}

export { WEEKDAY_NAMES };
