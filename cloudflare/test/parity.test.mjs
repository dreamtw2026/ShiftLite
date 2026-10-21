// 业务核心对齐测试：以 Python 版输出（fixture.json）为基准，逐字比对 JS 实现。
// 运行：npm test（node --test test/）

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkConflicts, summarize, fmtHours } from "../src/core.js";

const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf-8"));

test(`冲突检测对齐（${fixture.conflictCases.length} 个场景）`, () => {
  for (const c of fixture.conflictCases) {
    const actual = checkConflicts(
      c.candidate, c.existing,
      { ...c.employee, availableDays: new Set(c.employee.available_days) },
      c.settings);
    assert.deepStrictEqual(actual, c.expected, `场景「${c.name}」的冲突输出与 Python 版不一致`);
  }
});

test(`工时汇总对齐（${fixture.summaryCases.length} 个场景）`, () => {
  for (const c of fixture.summaryCases) {
    const actual = summarize(c.rows, c.start, c.end);
    assert.deepStrictEqual(actual, c.expected, `场景「${c.name}」的汇总输出与 Python 版不一致`);
  }
});

test(`小时格式化对齐（${fixture.fmtHoursCases.length} 个值，含 x.25 平局）`, () => {
  for (const c of fixture.fmtHoursCases) {
    assert.strictEqual(fmtHours(c.minutes), c.expected,
      `fmtHours(${c.minutes}) 与 Python 版不一致`);
  }
});
