import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  it("sr-workerDowngrade: worker 不可用时直接 fail-closed，绝不回退主线程", async () => {
    __setSafeRegexWorkerCtorForTest(null);
    const compiled = compileSafeRegex("a");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const result = await execSafeRegexAll(compiled.re, "a".repeat(20_001));

    expect(result).toMatchObject({
      ok: false,
      error: "安全正则执行器不可用",
    });
  }, 5000);

  it("sr-workerDisabled-child: OS 超时护栏证明灾难回溯不会冻结进程", () => {
    const moduleUrl = new URL("../safeRegex.ts", import.meta.url).href;
    const workspaceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    const script = [
      `import { compileSafeRegex, execSafeRegexAll, terminateSafeRegexWorkersForTest } from ${JSON.stringify(moduleUrl)};`,
      `const compiled = compileSafeRegex("(?:a|aa)+$");`,
      `if (!compiled.ok) throw new Error(compiled.error);`,
      `const result = await execSafeRegexAll(compiled.re, "a".repeat(12000) + "!");`,
      `terminateSafeRegexWorkersForTest();`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          QINGAGENT_SAFE_REGEX_DISABLE_WORKER: "1",
        },
        encoding: "utf8",
        timeout: 8_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      ok: false,
      error: "安全正则执行器不可用",
    });
  });

  it("sr-inlineWorker-esm: ESM 父模块无需旁车 worker 产物也能正常执行", () => {
    const moduleUrl = new URL("../safeRegex.ts", import.meta.url).href;
    const workspaceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    const script = [
      `import { compileSafeRegex, execSafeRegexAll, terminateSafeRegexWorkersForTest } from ${JSON.stringify(moduleUrl)};`,
      `const compiled = compileSafeRegex("a\\\\d");`,
      `if (!compiled.ok) throw new Error(compiled.error);`,
      `const result = await execSafeRegexAll(compiled.re, "a1 b2 a3");`,
      `terminateSafeRegexWorkersForTest();`,
      `process.stdout.write(JSON.stringify({ ok: result.ok, count: result.ok ? result.matches.length : 0, error: result.ok ? null : result.error }));`,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          QINGAGENT_SAFE_REGEX_DISABLE_WORKER: "0",
        },
        encoding: "utf8",
        timeout: 8_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      ok: true,
      count: 2,
      error: null,
    });
  });

  it("sr-workerStartup: 冷启动不占用正则执行预算", async () => {
    class SlowStartingWorker extends Worker {
      constructor(source: string, options: { eval: true }) {
        super(
          `const readyAt = Date.now() + 300; while (Date.now() < readyAt) {}\n${source}`,
          options,
        );
      }
    }
    __setSafeRegexWorkerCtorForTest(SlowStartingWorker as unknown as typeof Worker);
    const compiled = compileSafeRegex("a\\d");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    await expect(execSafeRegexAll(compiled.re, "a1 b2 a3")).resolves.toMatchObject({
      ok: true,
      matches: [{ 0: "a1" }, { 0: "a3" }],
    });
  }, 5000);

  it("sr-workerExit: 运行中 worker 异常退出返回稳定不可用错误", async () => {
    const compiled = compileSafeRegex("(?:a|aa)+$");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const pending = execSafeRegexAll(
      compiled.re,
      `${"a".repeat(12_000)}!`,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (__getSafeRegexPoolStatsForTest().liveWorkers > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(__getSafeRegexPoolStatsForTest().liveWorkers).toBeGreaterThan(0);
    terminateSafeRegexWorkersForTest();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "安全正则执行器不可用",
    });
  });

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
