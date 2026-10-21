// 轻排班 · Cloudflare Workers 版业务核心
// 与 Python 版 core/scheduling.py、core/worktime.py 保持口径与文案逐字一致（有对齐测试守护）。
// 约定与 Python 版相同：
// - 时间均为严格两位 "HH:MM"；结束时间早于或等于开始时间表示跨日（次日结束）。
// - 排班记录按“开始日期”归属统计周期（日/周/月）；周为周一至周日。
// - 冲突分 error（保存需二次确认）与 warning（提示，可直接保存）。
// - 日期一律使用 ISO 字符串 "YYYY-MM-DD"，计算通过 UTC 时间轴完成，避免时区歧义。

export const WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const TYPE_LABELS = { fulltime: "全职", parttime: "兼职" };
export const RULE_LABELS = {
  overlap: "班次重叠",
  availability: "可用时间冲突",
  rest: "班间休息不足",
  daily_limit: "超出每日工时上限",
  weekly_limit: "超出每周工时上限",
};
export const SEVERITY_ERROR = "error";
export const SEVERITY_WARNING = "warning";

/** 解析严格两位的 HH:MM，返回当日分钟数；非法格式或越界抛出 Error。 */
export function parseHHMM(value) {
  const text = String(value ?? "").trim();
  if (text.length !== 5 || text[2] !== ":" ||
      !/^\d{2}$/.test(text.slice(0, 2)) || !/^\d{2}$/.test(text.slice(3))) {
    throw new Error(`时间格式应为 HH:MM：${JSON.stringify(value)}`);
  }
  const hour = Number(text.slice(0, 2)), minute = Number(text.slice(3));
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new Error(`时间数值越界：${JSON.stringify(value)}`);
  }
  return hour * 60 + minute;
}

/** 某日期某时刻在 UTC 时间轴上的绝对分钟数（用于跨日比较）。 */
export function epochMin(dateISO, hhmm) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + parseHHMM(hhmm);
}

/** 班次跨度（分钟），跨日自动加 24 小时；起止相同视为非法。 */
export function shiftSpanMinutes(startHHMM, endHHMM) {
  const start = parseHHMM(startHHMM), end = parseHHMM(endHHMM);
  if (start === end) throw new Error("班次开始与结束时间相同");
  let span = end - start;
  if (span < 0) span += 24 * 60;
  return span;
}

/** 有效工时（分钟）= 跨度 − 休息时长，下限 0。 */
export function effectiveMinutes(startHHMM, endHHMM, breakMinutes) {
  const brk = Number(breakMinutes ?? 0);
  if (!Number.isInteger(brk) || brk < 0) throw new Error("休息时长不能为负数");
  return Math.max(0, shiftSpanMinutes(startHHMM, endHHMM) - brk);
}

/** 把“日期 + 起止时间”展开为绝对分钟区间，跨日结束落到次日。 */
export function shiftRange(dateISO, startHHMM, endHHMM) {
  const start = epochMin(dateISO, startHHMM);
  let end = epochMin(dateISO, endHHMM);
  if (end <= start) end += 24 * 60;
  return [start, end];
}

export function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** ISO 星期（1=周一 … 7=周日）。 */
export function isoWeekday(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  return wd === 0 ? 7 : wd;
}

function toISO(utcDate) {
  return utcDate.toISOString().slice(0, 10);
}

/** 返回 d 所在周的周一与周日（ISO 字符串）。 */
export function weekRange(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - (isoWeekday(dateISO) - 1));
  const end = new Date(base);
  end.setUTCDate(end.getUTCDate() + 6);
  return [toISO(base), toISO(end)];
}

/** 某自然月第一天与最后一天。 */
export function monthRange(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0));
  return [toISO(first), toISO(last)];
}

/** 分钟数格式化为可读小时文本，如 "7.5 小时"（与 Python _fmt_hours 一致）。
 *  说明：minutes ≡ 15 (mod 60) 时值为 x.25 小时，是十进制舍入的精确平局，
 *  Python 按“舍入到偶数位”得到 .2，而 JS toFixed 取较大者 .3，此处特判对齐。 */
export function fmtHours(minutes) {
  let text;
  if (minutes % 60 === 15) {
    text = `${Math.floor(minutes / 60)}.2`;
  } else {
    text = (minutes / 60).toFixed(1);
    if (text.endsWith("0")) text = text.slice(0, -1);
    if (text.endsWith(".")) text = text.slice(0, -1);
  }
  return `${text} 小时`;
}

/** MM月DD日（与 Python strftime('%m月%d日') 相同的零填充口径）。 */
export function fmtMD(dateISO) {
  const [, m, d] = dateISO.split("-").map(Number);
  return `${String(m).padStart(2, "0")}月${String(d).padStart(2, "0")}日`;
}

function conflict(rule, severity, message, relatedScheduleId = null) {
  return { rule, severity, message, related_schedule_id: relatedScheduleId, rule_label: RULE_LABELS[rule] ?? rule };
}

/**
 * 检测一条候选排班与该员工其他排班之间的冲突（与 Python check_conflicts 等价）。
 * candidate : { id, work_date, start_time, end_time, break_minutes }
 * existing  : 同一员工的其他排班（snake_case，同数据库行）
 * employee  : { employment_type, availableDays:Set<number>, available_from, available_to }
 * settings  : 数值型规则配置
 */
export function checkConflicts(candidate, existing, employee, settings) {
  const conflicts = [];
  const cDate = candidate.work_date;
  const [cStart, cEnd] = shiftRange(cDate, candidate.start_time, candidate.end_time);
  const cEff = effectiveMinutes(candidate.start_time, candidate.end_time, candidate.break_minutes);

  const spans = [];
  for (const row of existing) {
    if (candidate.id != null && row.id === candidate.id) continue; // 编辑时排除自身
    const [s, e] = shiftRange(row.work_date, row.start_time, row.end_time);
    spans.push({ s, e, row });
  }

  // 规则一：班次时间重叠（硬冲突）
  for (const { s, e, row } of spans) {
    const ov = overlapMinutes(cStart, cEnd, s, e);
    if (ov > 0) {
      conflicts.push(conflict("overlap", SEVERITY_ERROR,
        `与已有班次（${fmtMD(row.work_date)} ${row.start_time}–${row.end_time}）重叠 ${ov} 分钟`, row.id));
    }
  }

  // 规则二：不在可排班日 / 超出每日可用时间段（硬冲突）
  const weekday = isoWeekday(cDate);
  const days = employee.availableDays ?? new Set();
  if (days.size > 0 && !days.has(weekday)) {
    const allowed = [...days].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]).join("、");
    conflicts.push(conflict("availability", SEVERITY_ERROR,
      `${fmtMD(cDate)}为${WEEKDAY_NAMES[weekday]}，不在该员工的可排班日（${allowed}）`));
  }
  const aFrom = employee.available_from || "", aTo = employee.available_to || "";
  if (aFrom && aTo) {
    const winStart = epochMin(cDate, aFrom), winEnd = epochMin(cDate, aTo);
    if (cStart < winStart || cEnd > winEnd) {
      conflicts.push(conflict("availability", SEVERITY_ERROR,
        `班次 ${candidate.start_time}–${candidate.end_time} 超出其每日可用时间段（${aFrom}–${aTo}）`));
    }
  }

  // 规则三：与前后班次的休息间隔低于配置值（提示）
  const rest = Number(settings.rest_minutes_min ?? 0);
  if (rest > 0) {
    for (const { s, e, row } of spans) {
      if (overlapMinutes(cStart, cEnd, s, e) > 0) continue; // 重叠已由规则一报告
      if (e <= cStart) {
        const gap = cStart - e;
        if (gap < rest) {
          conflicts.push(conflict("rest", SEVERITY_WARNING,
            `与前一班次（${fmtMD(row.work_date)} ${row.start_time}–${row.end_time}）之间仅休息 ` +
            `${Math.floor(gap / 60)} 小时 ${gap % 60} 分钟，低于设置的最小间隔 ${Math.floor(rest / 60)} 小时`, row.id));
        }
      } else if (s >= cEnd) {
        const gap = s - cEnd;
        if (gap < rest) {
          conflicts.push(conflict("rest", SEVERITY_WARNING,
            `与后一班次（${fmtMD(row.work_date)} ${row.start_time}–${row.end_time}）之间仅休息 ` +
            `${Math.floor(gap / 60)} 小时 ${gap % 60} 分钟，低于设置的最小间隔 ${Math.floor(rest / 60)} 小时`, row.id));
        }
      }
    }
  }

  // 规则四：每日有效工时上限（提示）
  const empType = employee.employment_type || "fulltime";
  const typeLabel = TYPE_LABELS[empType] ?? "全职";
  const sameDay = existing.filter((row) =>
    row.work_date === cDate && (candidate.id == null || row.id !== candidate.id));
  const dayTotal = cEff + sameDay.reduce(
    (sum, r) => sum + effectiveMinutes(r.start_time, r.end_time, r.break_minutes), 0);
  const dailyLimit = Number(empType === "fulltime"
    ? settings.daily_max_minutes_fulltime ?? 0
    : settings.daily_max_minutes_parttime ?? 0);
  if (dailyLimit > 0 && dayTotal > dailyLimit) {
    conflicts.push(conflict("daily_limit", SEVERITY_WARNING,
      `当日有效工时合计 ${fmtHours(dayTotal)}，超过${typeLabel}每日上限 ${fmtHours(dailyLimit)}`));
  }

  // 规则五：每周（周一至周日）有效工时上限，按班次开始日期归属（提示）
  const [wStart, wEnd] = weekRange(cDate);
  const weekRows = existing.filter((row) =>
    row.work_date >= wStart && row.work_date <= wEnd &&
    (candidate.id == null || row.id !== candidate.id));
  const weekTotal = cEff + weekRows.reduce(
    (sum, r) => sum + effectiveMinutes(r.start_time, r.end_time, r.break_minutes), 0);
  const weeklyLimit = Number(empType === "fulltime"
    ? settings.weekly_max_minutes_fulltime ?? 0
    : settings.weekly_max_minutes_parttime ?? 0);
  if (weeklyLimit > 0 && weekTotal > weeklyLimit) {
    conflicts.push(conflict("weekly_limit", SEVERITY_WARNING,
      `本周（${fmtMD(wStart)}–${fmtMD(wEnd)}）有效工时合计 ${fmtHours(weekTotal)}，` +
      `超过${typeLabel}每周上限 ${fmtHours(weeklyLimit)}`));
  }

  return conflicts;
}

/**
 * 按员工汇总 [startISO, endISO] 区间内的工时（与 Python worktime.summarize 等价）。
 * rows 每条需含 employee_id、employee_name、position、employment_type、
 * work_date(ISO)、start_time、end_time、break_minutes。
 */
export function summarize(rows, startISO, endISO) {
  const out = new Map();
  for (const row of rows) {
    if (row.work_date < startISO || row.work_date > endISO) continue;
    const span = shiftSpanMinutes(row.start_time, row.end_time);
    const brk = Number(row.break_minutes ?? 0);
    const eff = Math.max(0, span - brk);
    if (!out.has(row.employee_id)) {
      out.set(row.employee_id, {
        employee_id: row.employee_id,
        name: row.employee_name,
        position: row.position || "",
        employment_type: row.employment_type,
        type_label: TYPE_LABELS[row.employment_type] ?? "全职",
        shifts: 0, scheduled_minutes: 0, break_minutes: 0, effective_minutes: 0,
        by_date: {},
      });
    }
    const item = out.get(row.employee_id);
    item.shifts += 1;
    item.scheduled_minutes += span;
    item.break_minutes += brk;
    item.effective_minutes += eff;
    item.by_date[row.work_date] = (item.by_date[row.work_date] ?? 0) + eff;
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 分钟转小时（保留一位小数）。 */
export function hours(minutes) {
  return Math.round((minutes / 60) * 10) / 10;
}
