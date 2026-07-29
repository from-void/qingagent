// 交互式授权「快速收口」回归。
//
// 病根(0729 语雀真机,会话 94a8f56c):`yuque whoami --json` 约 1 秒就已确定本机 token 解不开,
// 随即自动转入交互式 OAuth 扫码等待;我们却一路等满 120 秒才把它掐掉,还归因成"系统超时",
// 并对用户断言"不是你的授权出了问题"——与事实正好相反。
//
// 这套用例锁住的是产品承诺:
// - 已登录的只读探测照旧秒回,绝不被误判收口;
// - 一旦进入交互式授权等待,**秒级**结束并给出独立终态 auth-required;
// - 普通长命令的 120 秒策略一寸不动;
// - **后台(background:true)的真授权流程绝不被这套逻辑打断**;
// - 用户可见文案不再有任何没有证据的断言,模型侧拿到明确的行为约束。
//
// 时间一律走假时钟:不真等,断言的是"虚拟耗时远小于 120 秒"。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@mastra/core/workspace";
import {
  createGatedExecuteCommandTool,
  type GatedCommandResult,
} from "../workspace/gatedExecuteCommandTool.js";
import {
  createInteractiveAuthDetector,
  normalizeAuthSignalLine,
} from "../workspace/interactiveAuthSignal.js";
import { diagnoseCredentialFailure } from "../credentials/credentialFailureDiagnosis.js";
import {
  SANDBOX_TIMEOUT_MS,
  __resetIsolationCacheForTest,
} from "../workspace/sessionWorkspace.js";
import { createBoundedGetProcessOutputTool } from "../workspace/boundedGetProcessOutputTool.js";
import { commandCardFromResult } from "../agent-run/toolCards.js";

const PROBE_COMMAND = "yuque whoami --json";

interface ScriptStep {
  atMs: number;
  channel: "stdout" | "stderr";
  text: string;
}

interface FakeCliOptions {
  script: ScriptStep[];
  /** 命令自己退出的时刻(不设则一直挂着,直到被 abort 或撞上超时上限)。 */
  selfExitAtMs?: number;
  selfExitCode?: number;
}

/**
 * 忠实复刻真机时间线的假 CLI:按脚本在指定时刻往 stdout/stderr 吐行,然后长睡。
 * 被 abort 时按真实沙箱行为返回 killed;撞上 options.timeout 时返回 timedOut。
 */
function createFakeCliHarness(sessionId: string, options: FakeCliOptions) {
  const executeCalls: { timeout?: number; abortSignal?: AbortSignal }[] = [];
  const workspace = {
    sandbox: {
      executeCommand: async (
        _command: string,
        _args: string[],
        callOptions: {
          timeout?: number;
          abortSignal?: AbortSignal;
          onStdout?: (data: string) => Promise<void>;
          onStderr?: (data: string) => Promise<void>;
        },
      ) => {
        executeCalls.push({ timeout: callOptions.timeout, abortSignal: callOptions.abortSignal });
        const startedAt = Date.now();
        let stdout = "";
        let stderr = "";
        return await new Promise((resolveCommand) => {
          const timers: ReturnType<typeof setTimeout>[] = [];
          const finish = (result: Record<string, unknown>) => {
            for (const timer of timers) clearTimeout(timer);
            resolveCommand(result);
          };
          for (const step of options.script) {
            timers.push(setTimeout(() => {
              if (step.channel === "stdout") {
                stdout += step.text;
                void callOptions.onStdout?.(step.text);
              } else {
                stderr += step.text;
                void callOptions.onStderr?.(step.text);
              }
            }, step.atMs));
          }
          if (typeof options.selfExitAtMs === "number") {
            timers.push(setTimeout(() => finish({
              success: (options.selfExitCode ?? 0) === 0,
              exitCode: options.selfExitCode ?? 0,
              stdout,
              stderr,
              executionTimeMs: Date.now() - startedAt,
            }), options.selfExitAtMs));
          }
          if (typeof callOptions.timeout === "number") {
            timers.push(setTimeout(() => finish({
              success: false,
              exitCode: -1,
              stdout,
              stderr,
              executionTimeMs: Date.now() - startedAt,
              timedOut: true,
              killed: true,
            }), callOptions.timeout));
          }
          callOptions.abortSignal?.addEventListener("abort", () => finish({
            success: false,
            exitCode: 143,
            stdout,
            stderr,
            executionTimeMs: Date.now() - startedAt,
            killed: true,
          }), { once: true });
        });
      },
    },
  } as unknown as Workspace;
  const tool = createGatedExecuteCommandTool({
    sessionId,
    getWorkspace: async () => workspace,
    resolveCredentialEnv: () => ({}),
  });
  return { tool, executeCalls };
}

/** 在假时钟下跑一条前台命令,返回终态与"虚拟耗时"。 */
async function runWithVirtualClock(
  tool: ReturnType<typeof createGatedExecuteCommandTool>,
  input: Record<string, unknown>,
  advanceMs = SANDBOX_TIMEOUT_MS + 5_000,
): Promise<{ result: GatedCommandResult; elapsedMs: number }> {
  if (!tool.execute) throw new Error("execute missing");
  const startedAt = Date.now();
  let settledAt = 0;
  const execution = (tool.execute(input as never, {
    toolCallId: "interactive-auth-test",
    messages: [],
  } as never) as Promise<GatedCommandResult>).then((value) => {
    settledAt = Date.now();
    return value;
  });
  await vi.advanceTimersByTimeAsync(advanceMs);
  const result = await execution;
  return { result, elapsedMs: settledAt - startedAt };
}

describe("交互式授权信号识别", () => {
  it("大小写与空白宽容,ANSI 颜色码不影响匹配", () => {
    expect(normalizeAuthSignalLine("  OPEN   THIS  URL   To Authenticate  ")).toBe(
      "open this url to authenticate",
    );
    const detector = createInteractiveAuthDetector();
    expect(detector.push("[33mWAITING   FOR  Authentication...[0m\n")).toBe(
      "waiting for authentication...",
    );
  });

  it("信号被劈成多块到达时跨块拼接仍能识别", () => {
    const detector = createInteractiveAuthDetector();
    expect(detector.push("Open this ")).toBeNull();
    expect(detector.push("URL to auth")).toBeNull();
    expect(detector.push("enticate: https://example.test/oauth")).toContain(
      "open this url to authenticate",
    );
  });

  it("没有换行的半行也能识别(交互提示常常打完就阻塞)", () => {
    const detector = createInteractiveAuthDetector();
    expect(detector.push("Waiting for authentication...")).toBe("waiting for authentication...");
  });

  it("只触发一次:命中后继续喂输出一律返回 null", () => {
    const detector = createInteractiveAuthDetector();
    expect(detector.push("Authorization URL obtained\n")).toBeTruthy();
    expect(detector.push("Authorization URL obtained\n")).toBeNull();
    expect(detector.push("Waiting for authentication\n")).toBeNull();
    expect(detector.matchedLine()).toBe("authorization url obtained");
  });

  it("普通输出不会被误判(只认信号表里的那几句)", () => {
    const detector = createInteractiveAuthDetector();
    expect(detector.push("Downloading 12%\n")).toBeNull();
    expect(detector.push('{"login":"jimmy","name":"Jimmy"}\n')).toBeNull();
    expect(detector.push("authentication succeeded\n")).toBeNull();
    expect(detector.matchedLine()).toBeNull();
  });
});

describe("前台命令:交互式授权快速收口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetIsolationCacheForTest();
    process.env.QINGAGENT_SANDBOX_ISOLATION = "bwrap";
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetIsolationCacheForTest();
    delete process.env.QINGAGENT_SANDBOX_ISOLATION;
  });

  it("回归 1:已登录的 whoami 秒回,不被误判收口", async () => {
    const { tool } = createFakeCliHarness("auth-fast-logged-in", {
      script: [{ atMs: 40, channel: "stdout", text: '{"login":"jimmy","name":"Jimmy"}\n' }],
      selfExitAtMs: 60,
    });

    const { result, elapsedMs } = await runWithVirtualClock(tool, {
      command: PROBE_COMMAND,
      timeoutSeconds: 5,
    });

    expect(result).toMatchObject({ success: true, exitCode: 0, terminatedBy: "command" });
    expect(result.authRequired).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
    expect(result.output).toContain('"login":"jimmy"');
  });

  it("回归 2:打出授权链接后立即结束,实际等待远小于 120 秒", async () => {
    // 真机时间线:1 秒左右打出授权链接,随后无限等待扫码。
    const { tool, executeCalls } = createFakeCliHarness("auth-fast-open-url", {
      script: [
        { atMs: 900, channel: "stdout", text: "Authorization URL obtained\n" },
        { atMs: 1_000, channel: "stdout", text: "hasToken=false\n" },
        { atMs: 1_100, channel: "stdout", text: "Open this URL to authenticate: https://example.test/oauth\n" },
        { atMs: 1_200, channel: "stdout", text: "Waiting for authentication...\n" },
      ],
    });

    const { result, elapsedMs } = await runWithVirtualClock(tool, { command: PROBE_COMMAND });

    expect(result.authRequired).toBe(true);
    expect(result.terminatedBy).toBe("auth-required");
    // 硬门槛:必须秒级收口,不许再出现两分钟干等。
    expect(elapsedMs).toBeLessThan(5_000);
    expect(elapsedMs).toBeLessThan(SANDBOX_TIMEOUT_MS / 10);
    // 全局上限一寸未动:仍然按 120 秒下发给沙箱。
    expect(executeCalls[0]?.timeout).toBe(SANDBOX_TIMEOUT_MS);
    // 工具只跑了一次,没有任何内部重试。
    expect(executeCalls).toHaveLength(1);
  });

  it("回归 3:出现等待授权提示时终态是 auth-required 而非 system-timeout", async () => {
    const { tool } = createFakeCliHarness("auth-fast-waiting", {
      script: [{ atMs: 1_000, channel: "stderr", text: "Waiting for authentication...\n" }],
    });

    const { result } = await runWithVirtualClock(tool, { command: PROBE_COMMAND });

    expect(result).toMatchObject({
      success: false,
      authRequired: true,
      terminatedBy: "auth-required",
      timedOut: false,
      cancelled: false,
    });
    expect(result.killed).toBeUndefined();
    expect(result.output).not.toContain("已被系统终止");
    expect(result.output).toContain("已进入交互式授权等待");
  });

  it("回归 4:普通长命令不受影响,照旧走 120 秒策略", async () => {
    const { tool, executeCalls } = createFakeCliHarness("auth-fast-long-command", {
      script: [
        { atMs: 1_000, channel: "stdout", text: "building...\n" },
        { atMs: 30_000, channel: "stdout", text: "still building 45%\n" },
        { atMs: 90_000, channel: "stdout", text: "still building 90%\n" },
      ],
    });

    const { result, elapsedMs } = await runWithVirtualClock(tool, { command: "npm run build" });

    expect(executeCalls[0]?.timeout).toBe(SANDBOX_TIMEOUT_MS);
    expect(result).toMatchObject({
      timedOut: true,
      terminatedBy: "system-timeout",
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    expect(result.authRequired).toBeUndefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(SANDBOX_TIMEOUT_MS);
  });

  it("回归 5:Keychain 被拒场景不再出现「不是你的授权出了问题」类断言", async () => {
    const { tool } = createFakeCliHarness("auth-fast-keychain", {
      script: [
        { atMs: 800, channel: "stderr", text: "key access denied service=AntOAuthSDK reason=denied\n" },
        { atMs: 1_100, channel: "stdout", text: "Open this URL to authenticate: https://example.test/oauth\n" },
      ],
    });

    const { result } = await runWithVirtualClock(tool, { command: PROBE_COMMAND });

    expect(result.terminatedBy).toBe("auth-required");
    expect(result.output).not.toContain("不是你的授权出了问题");
    // 隔离形态下的定稿文案:讲用户能懂的话,不出现任何内部机制词。
    expect(result.output).toContain("当前的安全设置下读不到你在终端里的登录状态");
    for (const forbidden of ["隔离模式", "Keychain", "钥匙串", "seatbelt", "bwrap", "沙箱"]) {
      expect(result.output.split("事实核对")[0]).not.toContain(forbidden);
    }
  });

  it("回归 6/7:给模型的事实里明确禁止重试 whoami、--force 与重复出码", async () => {
    const { tool, executeCalls } = createFakeCliHarness("auth-fast-constraints", {
      script: [
        { atMs: 1_100, channel: "stdout", text: "Open this URL to authenticate: https://example.test/oauth\n" },
      ],
    });

    const { result } = await runWithVirtualClock(tool, { command: PROBE_COMMAND });

    expect(result.output).toContain("不要反复重试 whoami");
    expect(result.output).toContain("--force");
    expect(result.output).toContain("不要重复生成二维码");
    expect(result.output).toContain("background:true");
    // 我们自己绝不代劳重试:整轮只调了一次底层执行。
    expect(executeCalls).toHaveLength(1);
  });

  it("用户取消优先于授权收口:同一轮里 abort 生效时照实说用户取消", async () => {
    const controller = new AbortController();
    const { tool } = createFakeCliHarness("auth-fast-user-cancel", {
      script: [
        { atMs: 1_100, channel: "stdout", text: "Open this URL to authenticate: https://example.test/oauth\n" },
      ],
    });
    if (!tool.execute) throw new Error("execute missing");
    const execution = tool.execute({ command: PROBE_COMMAND } as never, {
      toolCallId: "auth-fast-user-cancel",
      messages: [],
      abortSignal: controller.signal,
    } as never) as Promise<GatedCommandResult>;

    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await execution;

    expect(result).toMatchObject({ cancelled: true, terminatedBy: "user-cancel" });
    expect(result.authRequired).toBeUndefined();
  });
});

describe("回归 12:后台真授权流程不被快速收口打断", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("background:true 只负责拉起进程,授权信号不触发任何终止", async () => {
    let killCalls = 0;
    const handle = {
      pid: 4321,
      stdout: "",
      stderr: "",
      exitCode: undefined as number | undefined,
      kill: async () => {
        killCalls += 1;
        return true;
      },
      wait: async () => new Promise(() => {}),
    };
    const workspace = {
      sandbox: {
        executeCommand: async () => {
          throw new Error("后台路径不该走前台执行");
        },
        processes: {
          list: async () => [],
          spawn: async () => {
            // 后台进程照常打印授权链接并继续活着等扫码。
            handle.stdout = "Authorization URL obtained\nOpen this URL to authenticate: https://example.test/oauth\nWaiting for authentication...\n";
            return handle;
          },
          get: async () => handle,
        },
      },
    } as unknown as Workspace;
    const tool = createGatedExecuteCommandTool({
      sessionId: "auth-fast-background",
      getWorkspace: async () => workspace,
      resolveCredentialEnv: () => ({}),
    });
    if (!tool.execute) throw new Error("execute missing");

    const spawned = await tool.execute(
      { command: "yuque login", background: true } as never,
      { toolCallId: "auth-fast-background", messages: [] } as never,
    ) as GatedCommandResult;

    expect(spawned).toMatchObject({ success: true, background: true, pid: "4321" });
    expect(spawned.authRequired).toBeUndefined();
    expect(spawned.terminatedBy).toBeUndefined();
    expect(killCalls).toBe(0);

    // 轮询同样只把控制权还给模型,绝不 kill 进程、绝不给 auth-required 终态。
    const pollTool = createBoundedGetProcessOutputTool({
      getWorkspace: async () => workspace,
      waitMaxMs: 5_000,
    });
    if (!pollTool.execute) throw new Error("poll execute missing");
    const polled = await pollTool.execute(
      { pid: "4321", wait: true } as never,
      { toolCallId: "auth-fast-background-poll", messages: [] } as never,
    ) as string;

    expect(polled).toContain("Open this URL to authenticate");
    expect(polled).not.toContain("auth-required");
    expect(killCalls).toBe(0);
    expect(handle.exitCode).toBeUndefined();
  });
});

describe("命令卡:auth-required 单独成档", () => {
  it("卡面走 authRequired 终态,不被折算成超时/中止/普通失败", () => {
    const card = commandCardFromResult(
      { command: PROBE_COMMAND },
      {
        success: false,
        exitCode: 143,
        cancelled: false,
        timedOut: false,
        authRequired: true,
        terminatedBy: "auth-required",
        output: "命令已进入交互式授权等待,我已主动结束本次前台执行。",
      },
      false,
    );

    expect(card.terminalKind).toBe("authRequired");
    expect(card.phase).toBe("failed");
  });
});

describe("凭据归因:交互式授权档", () => {
  it("拿不到隔离证据时只作事实陈述,不猜成因", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: "Open this URL to authenticate: https://example.test/oauth",
      interactiveAuthDetected: true,
    });
    expect(diagnosis?.kind).toBe("interactive-auth-required");
    expect(diagnosis?.userMessage).toBe("当前命令没有读到可复用的登录状态，已经进入重新授权流程。");
    expect(diagnosis?.authCompleted).toBe(false);
    expect(diagnosis?.retryable).toBe(false);
  });

  it("确认处于隔离形态时才把成因说到「读不到本机登录态」这一层", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: "",
      interactiveAuthDetected: true,
      isolated: true,
    });
    expect(diagnosis?.userMessage).toBe(
      "当前的安全设置下读不到你在终端里的登录状态，所以这个工具要重新授权一次。",
    );
  });

  it("我方超时档不再断言用户授权没问题", () => {
    const diagnosis = diagnoseCredentialFailure({
      output: "waiting for authorization",
      timedOut: true,
    });
    expect(diagnosis?.kind).toBe("sandbox-timeout");
    expect(diagnosis?.userMessage).not.toContain("不是你的授权出了问题");
  });
});
