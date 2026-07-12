import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import {
  __getSafeRegexPoolStatsForTest,
  __setSafeRegexWorkerCtorForTest,
  compileSafeRegex,
  execSafeRegexAll,
  terminateSafeRegexWorkersForTest,
} from "../safeRegex.js";

afterEach(() => {
  delete process.env.QINGAGENT_SAFE_REGEX_DISABLE_WORKER;
  delete process.env.QINGAGENT_SAFE_REGEX_WORKERS;
  __setSafeRegexWorkerCtorForTest(Worker);
  terminateSafeRegexWorkersForTest();
});

describe("safeRegex", () => {
  it("sr-literal-ok: 合法短 pattern 编译成功并强制 g", () => {
    const result = compileSafeRegex("2023");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.re.flags).toContain("g");
  });

  it("sr-tooLong: pattern 超长 fail-closed", () => {
    expect(compileSafeRegex("a".repeat(257))).toMatchObject({
      ok: false,
      error: "unsafe regex (pattern too long)",
    });
  });

  it("sr-rejectNestedQuant: 拒绝嵌套量词", () => {
    expect(compileSafeRegex("(a+)+")).toMatchObject({
      ok: false,
      error: "unsafe regex (nested quantifier)",
    });
    expect(compileSafeRegex("(.*)*")).toMatchObject({
      ok: false,
      error: "unsafe regex (nested quantifier)",
    });
  });

  it("sr-rejectBackref/lookbehind: 拒绝反向引用和 lookbehind", () => {
    expect(compileSafeRegex("(a)\\1")).toMatchObject({
      ok: false,
      error: "unsafe regex (backreference)",
    });
    expect(compileSafeRegex("(?<=x)y")).toMatchObject({
      ok: false,
      error: "unsafe regex (lookbehind)",
    });
  });

  it("sr-flags: 仅允许 i/u/m 且内部强制 g", () => {
    const result = compileSafeRegex("abc", "iu");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.re.flags).toContain("g");
    expect(result.re.flags).toContain("i");
    expect(result.re.flags).toContain("u");
    expect(compileSafeRegex("abc", "s")).toMatchObject({ ok: false });
    expect(compileSafeRegex("abc", "y")).toMatchObject({ ok: false });
    expect(compileSafeRegex("abc", "g")).toMatchObject({ ok: false });
  });

  it("sr-textTooLong: 文本过长或匹配过多 fail-closed", async () => {
    const compiled = compileSafeRegex("a");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    await expect(execSafeRegexAll(compiled.re, "a".repeat(20_001))).resolves.toMatchObject({
      ok: false,
      error: "unsafe regex (text too long)",
    });
    await expect(execSafeRegexAll(compiled.re, "a".repeat(1001))).resolves.toMatchObject({
      ok: false,
      error: "unsafe regex (too many matches)",
    });
  }, 5000);

  it("sr-timeout-realBacktrack: 真实回溯超时 fail-closed", async () => {
    const compiled = compileSafeRegex("(?:a|aa)+$");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const startedAt = Date.now();
    const result = await execSafeRegexAll(compiled.re, `${"a".repeat(12_000)}!`);

    expect(result).toMatchObject({
      ok: false,
      error: "unsafe regex (timeout)",
    });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, 5000);

  it("sr-workerDowngrade: worker 不可用时主线程长度闸仍 fail-closed", async () => {
    __setSafeRegexWorkerCtorForTest(null);
    const compiled = compileSafeRegex("a");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const result = await execSafeRegexAll(compiled.re, "a".repeat(20_001));

    expect(result).toMatchObject({
      ok: false,
      error: "unsafe regex (text too long)",
    });
  }, 5000);

  it("sr-poolReuse: 并发执行复用固定小池", async () => {
    process.env.QINGAGENT_SAFE_REGEX_WORKERS = "2";
    const compiled = compileSafeRegex("a\\d");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => execSafeRegexAll(
        compiled.re,
        `a${index} b${index} a${index + 1}`,
      )),
    );
    const stats = __getSafeRegexPoolStatsForTest();

    expect(results.every((result) => result.ok)).toBe(true);
    expect(stats.createdWorkers).toBeGreaterThan(0);
    expect(stats.createdWorkers).toBeLessThanOrEqual(2);
    expect(stats.liveWorkers).toBeLessThanOrEqual(2);
  }, 5000);
});
