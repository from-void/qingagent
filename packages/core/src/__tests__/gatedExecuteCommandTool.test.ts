import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@mastra/core/workspace";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BUILTIN_SKILLS_DIR } from "../skills/paths.js";
import {
  EXECUTE_COMMAND_MAX_RETAINED_BYTES,
  SANDBOX_BACKGROUND_TTL_MS,
  SANDBOX_MAX_BACKGROUND_PROCESSES,
  createGatedExecuteCommandTool,
  type GatedCommandResult,
} from "../workspace/gatedExecuteCommandTool.js";
import { formatCommandDuration } from "../workspace/backgroundCommandLimits.js";
import { SANDBOX_TIMEOUT_MS, sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import { RequestContext } from "@mastra/core/request-context";
import { createSession } from "../session/sessionState.js";
import { commandConfirmationDigest } from "../confirm/commandConfirmation.js";
import { issueApprovalProof } from "../confirm/approvalProof.js";
import type { SessionState } from "../session/sessionState.js";

interface GatedExecuteInput {
  command: string;
  reason?: string;
  timeout?: number | null;
  cwd?: string | null;
  tail?: number | null;
  background?: boolean;
}

interface SandboxExecuteOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxRetainedBytes?: number;
  abortSignal?: AbortSignal;
  onStdout?: (data: string) => Promise<void>;
  onStderr?: (data: string) => Promise<void>;
}

interface SandboxSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxRetainedBytes?: number;
  abortSignal?: AbortSignal;
}

const calcScript = resolve(BUILTIN_SKILLS_DIR, "capability", "doc-calc", "scripts", "calc.mjs");
const allowedFileCommand = `node ${JSON.stringify(calcScript)} stats --file passwd`;
const trustedNodeCommand = `node ${JSON.stringify(calcScript)} sum --data "[1,2]"`;
const toolInvocationOptions = { toolCallId: "gated-execute-test", messages: [] } as never;

function validateToolInput(
  toolDef: { inputSchema?: unknown },
  input: unknown,
): { success: boolean; error?: string } {
  const schema = toolDef.inputSchema as { parse: (v: unknown) => unknown } | undefined;
  if (!schema) return { success: false, error: "Tool has no inputSchema" };
  try {
    schema.parse(input);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createToolHarness(
  sessionId = "gated-cwd-test",
  options: {
    resolveCredentialEnv?: () => Promise<Record<string, string>> | Record<string, string>;
    sandboxBinDir?: string;
    state?: SessionState;
    workspaceStatus?: "pending" | "initializing" | "ready" | "paused" | "error" | "destroying" | "destroyed";
    sandboxStatus?: "pending" | "initializing" | "ready" | "starting" | "running" | "stopping" | "stopped" | "destroying" | "destroyed" | "error";
    runningProcesses?: number;
    simulateBackgroundTimeout?: boolean;
    backgroundWait?: Promise<void>;
    retainWorkspace?: () => () => void;
    firstListGate?: Promise<void>;
    commandResult?: {
      success: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
      executionTimeMs: number;
      timedOut?: boolean;
      killed?: boolean;
    };
  } = {},
) {
  const executeCalls: SandboxExecuteOptions[] = [];
  const spawnCalls: SandboxSpawnOptions[] = [];
  let spawnedRunning = 0;
  let listCalls = 0;
  const mockedCommandResult = options.commandResult;
  const workspace = {
    ...(options.workspaceStatus ? { status: options.workspaceStatus } : {}),
    sandbox: {
      ...(options.sandboxStatus ? { status: options.sandboxStatus } : {}),
      executeCommand: async (
        _command: string,
        _args: string[],
        options: SandboxExecuteOptions,
      ) => {
        executeCalls.push(options);
        return mockedCommandResult ?? {
          success: true,
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          executionTimeMs: 1,
        };
      },
      processes: {
        list: async () => {
          listCalls += 1;
          if (listCalls === 1) await options.firstListGate;
          return [
            ...Array.from({ length: options.runningProcesses ?? 0 }, (_, index) => ({
              pid: `existing-${index}`,
              running: true,
            })),
            ...Array.from({ length: spawnedRunning }, (_, index) => ({
              pid: `spawned-${index}`,
              running: true,
            })),
          ];
        },
        spawn: async (_command: string, spawnOptions: SandboxSpawnOptions) => {
          spawnCalls.push(spawnOptions);
          spawnedRunning += 1;
          if (options.simulateBackgroundTimeout && spawnOptions.timeout) {
            setTimeout(() => {
              spawnedRunning = Math.max(0, spawnedRunning - 1);
            }, spawnOptions.timeout);
          }
          return {
            pid: 12345,
            wait: async () => {
              await options.backgroundWait;
              return {
                success: true,
                exitCode: 0,
                stdout: "",
                stderr: "",
                executionTimeMs: 1,
              };
            },
          };
        },
      },
    },
  } as unknown as Workspace;
  const tool = createGatedExecuteCommandTool({
    sessionId,
    state: options.state,
    getWorkspace: async () => workspace,
    retainWorkspace: options.retainWorkspace,
    resolveCredentialEnv: options.resolveCredentialEnv ?? (() => ({})),
    sandboxBinDir: options.sandboxBinDir,
  });
  return {
    tool,
    executeCalls,
    spawnCalls,
    listCallCount: () => listCalls,
    runningProcessCount: () => (options.runningProcesses ?? 0) + spawnedRunning,
  };
}

async function executeTool(
  tool: ReturnType<typeof createGatedExecuteCommandTool>,
  input: GatedExecuteInput,
  context = toolInvocationOptions,
): Promise<string> {
  return (await executeToolResult(tool, input, context)).output;
}

async function executeToolResult(
  tool: ReturnType<typeof createGatedExecuteCommandTool>,
  input: GatedExecuteInput,
  context = toolInvocationOptions,
): Promise<GatedCommandResult> {
  if (!tool.execute) throw new Error("execute_command execute missing");
  return await tool.execute(input, context) as GatedCommandResult;
}

function approvalContext(runId: string, toolCallId: string) {
  return {
    toolCallId,
    messages: [],
    requestContext: new RequestContext([["runId", runId]]),
    agent: { toolCallId },
  } as never;
}

describe("gated execute_command tool schema", () => {
  it("rejects empty/overlong commands and reasons longer than 80 characters", () => {
    const tool = createGatedExecuteCommandTool({
      sessionId: "schema-test",
      getWorkspace: async () => {
        throw new Error("schema test does not execute commands");
      },
    });

    expect(validateToolInput(tool, { command: "" }).success).toBe(false);
    expect(validateToolInput(tool, { command: "x".repeat(8192) }).success).toBe(true);
    expect(validateToolInput(tool, { command: "x".repeat(8193) }).success).toBe(false);
    expect(validateToolInput(tool, {
      command: "npm install zod",
      reason: "你".repeat(80),
    }).success).toBe(true);
    expect(validateToolInput(tool, {
      command: "npm install zod",
      reason: "你".repeat(81),
    }).success).toBe(false);
  });
});

describe("gated execute_command 沙箱健康状态", () => {
  it.each([
    ["undefined", {}],
    ["pending", { workspaceStatus: "pending", sandboxStatus: "pending" }],
    ["initializing", { workspaceStatus: "initializing", sandboxStatus: "initializing" }],
    ["starting", { workspaceStatus: "ready", sandboxStatus: "starting" }],
    ["ready", { workspaceStatus: "ready", sandboxStatus: "ready" }],
    ["running", { workspaceStatus: "ready", sandboxStatus: "running" }],
  ] as const)("%s 状态允许 executeCommand 惰性启动并执行", async (_label, statuses) => {
    const { tool, executeCalls } = createToolHarness(`gated-healthy-${_label}`, { ...statuses });

    expect(await executeTool(tool, { command: allowedFileCommand })).toBe("ok");
    expect(executeCalls).toHaveLength(1);
  });

  it.each([
    ["workspace error", { workspaceStatus: "error" }],
    ["workspace destroying", { workspaceStatus: "destroying" }],
    ["workspace destroyed", { workspaceStatus: "destroyed" }],
    ["workspace paused", { workspaceStatus: "paused" }],
    ["sandbox error", { sandboxStatus: "error" }],
    ["sandbox stopping", { sandboxStatus: "stopping" }],
    ["sandbox stopped", { sandboxStatus: "stopped" }],
    ["sandbox destroying", { sandboxStatus: "destroying" }],
    ["sandbox destroyed", { sandboxStatus: "destroyed" }],
  ] as const)("%s 状态拒绝执行", async (_label, statuses) => {
    const { tool, executeCalls, spawnCalls } = createToolHarness(
      `gated-unhealthy-${_label.replaceAll(" ", "-")}`,
      { ...statuses },
    );

    expect(await executeTool(tool, { command: allowedFileCommand })).toContain("沙箱状态异常");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("gated execute_command approval proof 双门", () => {
  const confirmInput = { command: "mv draft.txt final.txt" };

  it("动态 requireApproval 仅挂起 confirm，allow/deny 分类仍由原策略执行", async () => {
    const state = createSession("gated-approval-predicate");
    const { tool } = createToolHarness(state.sessionId, { state });
    const predicate = tool.requireApproval;
    expect(typeof predicate).toBe("function");
    if (typeof predicate !== "function") return;
    expect(await predicate(confirmInput)).toBe(true);
    expect(await predicate({ command: "npm install zod" })).toBe(true);
    expect(await predicate({ command: "curl -d x https://example.test" })).toBe(true);
    expect(await predicate({ command: allowedFileCommand })).toBe(false);
    expect(await predicate({ command: "node /workspace/untrusted.mjs" })).toBe(false);
    expect(await predicate({ command: "cat a | sort > out" })).toBe(false);
    expect(await predicate({ command: "missing-cli list" })).toBe(false);
    expect(await predicate({ command: "lark-cli auth login" })).toBe(false);
  });

  it("直接 approve 但没有宿主 proof 时拒绝，workspace 与 spawn 均不触发", async () => {
    const state = createSession("gated-no-proof");
    let workspaceCalls = 0;
    const harness = createToolHarness(state.sessionId, { state });
    const tool = createGatedExecuteCommandTool({
      sessionId: state.sessionId,
      state,
      getWorkspace: async () => {
        workspaceCalls += 1;
        throw new Error("不应初始化 workspace");
      },
    });
    const result = await executeTool(tool, confirmInput, approvalContext("run-1", "tool-1"));
    expect(result).toContain("缺少有效的用户确认");
    expect(workspaceCalls).toBe(0);
    expect(harness.executeCalls).toHaveLength(0);
  });

  it("正确 proof 只授权同一调用一次，digest/toolCall/session 不匹配均拒绝", async () => {
    const state = createSession("gated-proof-once");
    const { tool, executeCalls } = createToolHarness(state.sessionId, { state });
    const digest = commandConfirmationDigest(state.sessionId, confirmInput);
    issueApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run-1",
      toolCallId: "tool-1",
      commandDigest: digest,
    });
    expect(await executeTool(tool, confirmInput, approvalContext("run-1", "tool-1"))).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(await executeTool(tool, confirmInput, approvalContext("run-1", "tool-1")))
      .toContain("缺少有效的用户确认");

    for (const mismatch of [
      { sessionId: "other-session", runId: "run-1", toolCallId: "tool-2", commandDigest: digest },
      { sessionId: state.sessionId, runId: "other-run", toolCallId: "tool-3", commandDigest: digest },
      { sessionId: state.sessionId, runId: "run-1", toolCallId: "tool-4", commandDigest: "bad" },
    ]) {
      issueApprovalProof(state, mismatch);
      const result = await executeTool(
        tool,
        confirmInput,
        approvalContext("run-1", mismatch.toolCallId),
      );
      expect(result).toContain("缺少有效的用户确认");
    }
    expect(executeCalls).toHaveLength(1);
  });

  it("sandbox 不健康时 proof 已通过也不执行", async () => {
    const state = createSession("gated-unhealthy");
    const { tool, executeCalls, spawnCalls } = createToolHarness(state.sessionId, {
      state,
      sandboxStatus: "error",
    });
    issueApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run",
      toolCallId: "tool",
      commandDigest: commandConfirmationDigest(state.sessionId, confirmInput),
    });
    expect(await executeTool(tool, confirmInput, approvalContext("run", "tool")))
      .toContain("沙箱状态异常");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("accept 后 policy 重算为 deny 时 proof 也不能放行", async () => {
    const state = createSession("gated-policy-changed-deny");
    const deniedInput = { command: "lark-cli auth login" };
    const { tool, executeCalls, spawnCalls } = createToolHarness(state.sessionId, { state });
    issueApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run",
      toolCallId: "tool",
      commandDigest: commandConfirmationDigest(state.sessionId, deniedInput),
    });

    expect(await executeTool(tool, deniedInput, approvalContext("run", "tool")))
      .toContain("命令已被拒绝");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("gated execute_command tool cwd 约束", () => {
  it("Round5 回归:会话外 cwd 加相对 --file 被拒绝且不进入前台 sandbox", async () => {
    const sessionId = "gated-cwd-outside";
    const sessionDir = sessionWorkspaceDir(sessionId);
    const { tool, executeCalls, spawnCalls } = createToolHarness(sessionId);

    for (const cwd of [resolve(sessionDir, ".."), "../escape"]) {
      const result = await executeTool(tool, { command: allowedFileCommand, cwd });
      expect(result, cwd).toContain("命令已被拒绝");
      expect(result, cwd).toContain("cwd 必须位于当前会话工作目录内");
    }
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("Round10 回归:调用前已 abort 则立即短路,不解析/不装配/不 spawn", async () => {
    const { tool, executeCalls, spawnCalls } = createToolHarness("gated-preabort");
    if (!tool.execute) throw new Error("execute missing");
    const controller = new AbortController();
    controller.abort();
    const ctx = { toolCallId: "t", messages: [], abortSignal: controller.signal } as never;

    const fg = (await tool.execute({ command: allowedFileCommand }, ctx)) as GatedCommandResult;
    const bg = (await tool.execute({ command: allowedFileCommand, background: true }, ctx)) as GatedCommandResult;

    expect(fg).toMatchObject({ success: false, exitCode: -1, cancelled: true, timedOut: false });
    expect(bg).toMatchObject({ success: false, exitCode: -1, cancelled: true, timedOut: false });
    expect(fg.output).toContain("命令已取消");
    expect(bg.output).toContain("命令已取消");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("Round5 回归:后台进程同样拒绝会话外 cwd", async () => {
    const sessionId = "gated-cwd-background-outside";
    const sessionDir = sessionWorkspaceDir(sessionId);
    const { tool, executeCalls, spawnCalls } = createToolHarness(sessionId);

    const result = await executeTool(tool, {
      command: allowedFileCommand,
      cwd: resolve(sessionDir, ".."),
      background: true,
    });

    expect(result).toContain("命令已被拒绝");
    expect(result).toContain("cwd 必须位于当前会话工作目录内");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("会话内子目录 cwd 正常传给前台 sandbox", async () => {
    const sessionId = "gated-cwd-inside";
    const sessionDir = sessionWorkspaceDir(sessionId);
    const nestedDir = resolve(sessionDir, "nested");
    mkdirSync(nestedDir, { recursive: true });
    const { tool, executeCalls } = createToolHarness(sessionId);

    const result = await executeTool(tool, {
      command: allowedFileCommand,
      cwd: "nested",
    });

    expect(result).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.cwd).toBe(nestedDir);
  });

  it("Round6 回归:会话内 symlink 指向会话外目录时 cwd 被拒绝", async () => {
    const sessionId = "gated-cwd-symlink-outside";
    const sessionDir = sessionWorkspaceDir(sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const outsideDir = mkdtempSync(resolve(tmpdir(), "gated-cwd-outside-"));
    const symlinkPath = resolve(sessionDir, "escape");
    rmSync(symlinkPath, { recursive: true, force: true });
    symlinkSync(outsideDir, symlinkPath, "dir");
    const { tool, executeCalls, spawnCalls } = createToolHarness(sessionId);

    const result = await executeTool(tool, {
      command: allowedFileCommand,
      cwd: "escape",
    });

    expect(result).toContain("命令已被拒绝");
    expect(result).toContain("cwd 必须位于当前会话工作目录内");
    expect(executeCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("不传 cwd 时默认使用会话目录", async () => {
    const sessionId = "gated-cwd-default";
    const sessionDir = sessionWorkspaceDir(sessionId);
    const { tool, executeCalls } = createToolHarness(sessionId);

    const result = await executeTool(tool, { command: allowedFileCommand });

    expect(result).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.cwd).toBe(sessionDir);
  });

  it("Gap3 回归:未传 timeout 时前台命令使用会话沙箱默认超时", async () => {
    const { tool, executeCalls } = createToolHarness("gated-default-timeout");

    const result = await executeTool(tool, { command: allowedFileCommand });

    expect(result).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.timeout).toBe(SANDBOX_TIMEOUT_MS);
  });

  it("Gap3 回归:显式 timeout 透传为毫秒且不被默认值覆盖", async () => {
    const { tool, executeCalls } = createToolHarness("gated-explicit-timeout");

    const result = await executeTool(tool, { command: allowedFileCommand, timeout: 7 });

    expect(result).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.timeout).toBe(7_000);
  });

  it("P1-4 回归:前台命令安静运行 120 秒时用心跳避免 90 秒 idle 看门狗误杀", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), 90_000);
    };
    resetIdleWatchdog();

    const workspace = {
      sandbox: {
        executeCommand: async (
          _command: string,
          _args: string[],
          options: SandboxExecuteOptions,
        ) => await new Promise<{
          success: boolean;
          exitCode: number;
          stdout: string;
          stderr: string;
          executionTimeMs: number;
        }>((resolveCommand, rejectCommand) => {
          const commandTimer = setTimeout(() => {
            resolveCommand({
              success: true,
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
              executionTimeMs: 120_000,
            });
          }, 120_000);
          options.abortSignal?.addEventListener("abort", () => {
            clearTimeout(commandTimer);
            rejectCommand(new Error("idle watchdog aborted command"));
          }, { once: true });
        }),
      },
    } as unknown as Workspace;
    const tool = createGatedExecuteCommandTool({
      sessionId: "gated-heartbeat-quiet-command",
      getWorkspace: async () => workspace,
      resolveCredentialEnv: () => ({}),
    });
    const writer = {
      write: vi.fn(() => resetIdleWatchdog()),
      custom: vi.fn(),
    };

    try {
      if (!tool.execute) throw new Error("execute missing");
      const execution = tool.execute(
        { command: allowedFileCommand, timeout: 120 },
        {
          toolCallId: "gated-heartbeat-test",
          messages: [],
          abortSignal: controller.signal,
          writer,
          agent: { toolCallId: "gated-heartbeat-test" },
        } as never,
      ) as Promise<GatedCommandResult>;

      await vi.advanceTimersByTimeAsync(120_000);

      expect(await execution).toMatchObject({ success: true, exitCode: 0, output: "ok" });
      expect(controller.signal.aborted).toBe(false);
      expect(writer.write).toHaveBeenCalled();
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      vi.useRealTimers();
    }
  });

  it("非零退出保留结构化失败信号，供命令卡直接落 failed", async () => {
    const { tool } = createToolHarness("gated-nonzero-result", {
      commandResult: {
        success: false,
        exitCode: 17,
        stdout: "partial output\n",
        stderr: "command failed\n",
        executionTimeMs: 5,
      },
    });

    await expect(executeToolResult(tool, { command: allowedFileCommand })).resolves.toEqual({
      success: false,
      exitCode: 17,
      cancelled: false,
      timedOut: false,
      output: "partial output\ncommand failed\nExit code: 17",
    });
  });

  it("tail 截断时附带禁止重跑提示，未截断时返回逐字不变", async () => {
    const commandResult = {
      success: true,
      exitCode: 0,
      stdout: "line-1\nline-2\nline-3",
      stderr: "",
      executionTimeMs: 5,
    };
    const { tool } = createToolHarness("gated-tail-notice", { commandResult });

    const untruncated = await executeTool(tool, {
      command: allowedFileCommand,
      tail: 3,
    });
    expect(untruncated).toBe("line-1\nline-2\nline-3");

    const truncated = await executeTool(tool, {
      command: allowedFileCommand,
      tail: 2,
    });
    expect(truncated).toContain("line-2\nline-3");
    expect(truncated).toContain("do not rerun the command");
    expect(truncated).toContain("it may have side effects");
  });

  it("stdout 与 stderr 同时截断时只追加一次禁止重跑提示", async () => {
    const { tool } = createToolHarness("gated-tail-notice-once", {
      commandResult: {
        success: false,
        exitCode: 9,
        stdout: "out-1\nout-2",
        stderr: "err-1\nerr-2",
        executionTimeMs: 5,
      },
    });

    const output = await executeTool(tool, {
      command: allowedFileCommand,
      tail: 1,
    });
    expect(output).toContain("out-2\nerr-2\nExit code: 9");
    expect(output.match(/do not rerun the command/g)).toHaveLength(1);
  });

  it("沙箱超时结果保留 timedOut，不以输出字符串猜测", async () => {
    const { tool } = createToolHarness("gated-timeout-result", {
      commandResult: {
        success: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        executionTimeMs: 7_000,
        timedOut: true,
        killed: true,
      },
    });

    await expect(executeToolResult(tool, { command: allowedFileCommand })).resolves.toEqual({
      success: false,
      exitCode: -1,
      cancelled: false,
      timedOut: true,
      output: "Exit code: -1",
    });
  });

  it("Gap4 回归:前台 executeCommand 显式设置输出保留上限", async () => {
    const { tool, executeCalls } = createToolHarness("gated-retained-foreground");

    const result = await executeTool(tool, { command: allowedFileCommand });

    expect(result).toBe("ok");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.maxRetainedBytes).toBe(EXECUTE_COMMAND_MAX_RETAINED_BYTES);
  });

  it("Gap4 回归:后台 spawn 显式设置输出保留上限", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-retained-background");

    const result = await executeToolResult(tool, {
      command: allowedFileCommand,
      background: true,
      timeout: 10,
    });

    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      pid: "12345",
      background: true,
    });
    expect(result.output).toContain("Started background process (PID: 12345");
    expect(result.output).toContain("最长运行: 10 秒");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.maxRetainedBytes).toBe(EXECUTE_COMMAND_MAX_RETAINED_BYTES);
  });

  it("后台进程退出前持续持有 Workspace 租约", async () => {
    let finishBackground!: () => void;
    const backgroundWait = new Promise<void>((resolve) => {
      finishBackground = resolve;
    });
    const releaseWorkspace = vi.fn();
    const retainWorkspace = vi.fn(() => releaseWorkspace);
    const { tool } = createToolHarness("gated-background-workspace-lease", {
      backgroundWait,
      retainWorkspace,
    });

    await expect(executeToolResult(tool, {
      command: allowedFileCommand,
      background: true,
    })).resolves.toMatchObject({ success: true, background: true });
    expect(retainWorkspace).toHaveBeenCalledTimes(1);
    expect(releaseWorkspace).not.toHaveBeenCalled();

    finishBackground();
    await vi.waitFor(() => expect(releaseWorkspace).toHaveBeenCalledTimes(1));
  });

  it("P2-6 回归:无 timeout 后台 dev 命令不确认，静默套用并展示实际 TTL", async () => {
    vi.useFakeTimers();
    const { tool, spawnCalls, runningProcessCount } = createToolHarness("gated-background-default-ttl", {
      simulateBackgroundTimeout: true,
    });
    const input = { command: "pnpm dev", background: true };
    const predicate = tool.requireApproval;
    expect(typeof predicate).toBe("function");
    if (typeof predicate !== "function") throw new Error("requireApproval missing");
    expect(await predicate(input)).toBe(false);
    try {
      const result = await executeTool(tool, input);
      expect(result).toContain("Started background process (PID: 12345");
      expect(result).toContain(`最长运行: ${formatCommandDuration(SANDBOX_BACKGROUND_TTL_MS)}`);
      expect(spawnCalls[0]?.timeout).toBe(SANDBOX_BACKGROUND_TTL_MS);
      expect(runningProcessCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(SANDBOX_BACKGROUND_TTL_MS);
      expect(runningProcessCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("P2-6 回归:上限内显式 timeout 后台命令直接执行", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-background-explicit-timeout");

    expect(await executeTool(tool, {
      command: allowedFileCommand,
      background: true,
      timeout: 7,
    })).toContain("Started background process (PID: 12345");
    expect(spawnCalls[0]?.timeout).toBe(7_000);
  });

  it("P2-6 回归:超大后台 timeout 被硬钳制到 TTL 上限并显示实际时长", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-background-timeout-clamped");

    const result = await executeTool(tool, {
      command: allowedFileCommand,
      background: true,
      timeout: 31_536_000,
    });

    expect(spawnCalls[0]?.timeout).toBe(SANDBOX_BACKGROUND_TTL_MS);
    expect(result).toContain(`最长运行: ${formatCommandDuration(SANDBOX_BACKGROUND_TTL_MS)}`);
    expect(result).toContain("已按后台上限钳制");
  });

  it("P2-6 回归:每会话后台进程达到上限时拒绝且不 spawn", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-background-process-limit", {
      runningProcesses: SANDBOX_MAX_BACKGROUND_PROCESSES,
    });

    const result = await executeTool(tool, {
      command: allowedFileCommand,
      background: true,
      timeout: 10,
    });
    expect(result).toContain(`后台进程已达上限 ${SANDBOX_MAX_BACKGROUND_PROCESSES}`);
    expect(spawnCalls).toHaveLength(0);
  });

  it("P2-6 回归:并发启动在配额边界串行复核，最多一个成功", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-background-process-limit-race", {
      runningProcesses: SANDBOX_MAX_BACKGROUND_PROCESSES - 1,
    });
    const input = {
      command: allowedFileCommand,
      background: true,
      timeout: 10,
    };

    const results = await Promise.all([
      executeTool(tool, input),
      executeTool(tool, input),
    ]);
    expect(results.filter((result) => result.startsWith("Started background process"))).toHaveLength(1);
    expect(results.filter((result) => result.includes("后台进程已达上限"))).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
  });

  it("后台命令等待会话锁期间取消后不再 list 或 spawn", async () => {
    let releaseFirstList!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseFirstList = resolve;
    });
    const { tool, spawnCalls, listCallCount } = createToolHarness(
      "gated-background-lock-cancel",
      { firstListGate },
    );
    const input = {
      command: allowedFileCommand,
      background: true,
      timeout: 10,
    };
    const first = executeToolResult(tool, input);
    await vi.waitFor(() => expect(listCallCount()).toBe(1));

    const abortController = new AbortController();
    const second = executeToolResult(tool, input, {
      toolCallId: "gated-execute-test",
      messages: [],
      abortSignal: abortController.signal,
    } as never);
    abortController.abort("user_abort");
    releaseFirstList();

    await expect(first).resolves.toMatchObject({ success: true, background: true });
    const secondResult = await second;
    expect(secondResult).toMatchObject({
      success: false,
      cancelled: true,
    });
    expect(secondResult).not.toHaveProperty("background");
    expect(listCallCount()).toBe(1);
    expect(spawnCalls).toHaveLength(1);
  });

  it("后台进程 list 期间取消后不再 spawn", async () => {
    let releaseList!: () => void;
    const firstListGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const { tool, spawnCalls, listCallCount } = createToolHarness(
      "gated-background-list-cancel",
      { firstListGate },
    );
    const abortController = new AbortController();
    const command = executeToolResult(tool, {
      command: allowedFileCommand,
      background: true,
      timeout: 10,
    }, {
      toolCallId: "gated-execute-test",
      messages: [],
      abortSignal: abortController.signal,
    } as never);
    await vi.waitFor(() => expect(listCallCount()).toBe(1));

    abortController.abort("user_abort");
    releaseList();

    await expect(command).resolves.toMatchObject({
      success: false,
      cancelled: true,
    });
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("gated execute_command tool 凭据按 consumer 发放", () => {
  const originalSwitch = process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS;

  afterEach(() => {
    if (originalSwitch === undefined) delete process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS;
    else process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = originalSwitch;
  });

  it("开关开启时受信 node skill 脚本拿到 per-call 凭据 env", async () => {
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";
    let resolveCount = 0;
    const { tool, executeCalls, spawnCalls } = createToolHarness("gated-credential-node", {
      resolveCredentialEnv: () => {
        resolveCount += 1;
        return { PLATFORM_API_KEY: "app_x", PLATFORM_API_SECRET: "sec_y" };
      },
    });

    expect(await executeTool(tool, { command: trustedNodeCommand })).toBe("ok");
    expect(await executeTool(tool, {
      command: trustedNodeCommand,
      background: true,
      timeout: 10,
    })).toContain("Started background process");
    expect(resolveCount).toBe(2);
    expect(executeCalls[0]?.env).toEqual({
      PLATFORM_API_KEY: "app_x",
      PLATFORM_API_SECRET: "sec_y",
    });
    expect(spawnCalls[0]?.env).toEqual({
      PLATFORM_API_KEY: "app_x",
      PLATFORM_API_SECRET: "sec_y",
    });
  });

  it("普通 confirm 即使 proof 通过也永不解析或注入托管凭据", async () => {
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";
    const state = createSession("gated-generic-confirm-no-credential");
    let resolveCount = 0;
    const { tool, executeCalls } = createToolHarness(state.sessionId, {
      state,
      resolveCredentialEnv: () => {
        resolveCount += 1;
        return { PLATFORM_API_SECRET: "must-not-leak" };
      },
    });
    const input = { command: "rm old.txt" };
    issueApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run",
      toolCallId: "tool",
      commandDigest: commandConfirmationDigest(state.sessionId, input),
    });

    expect(await executeTool(tool, input, approvalContext("run", "tool"))).toBe("ok");
    expect(resolveCount).toBe(0);
    expect(executeCalls[0]?.env).toBeUndefined();
  });

  it("组合命令绝不继承受信 node 凭据，含 send confirm 时 proof 也不例外", async () => {
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";
    const state = createSession("gated-compound-no-credential");
    let resolveCount = 0;
    const { tool, executeCalls } = createToolHarness(state.sessionId, {
      state,
      resolveCredentialEnv: () => {
        resolveCount += 1;
        return { PLATFORM_API_SECRET: "must-not-leak" };
      },
    });

    expect(await executeTool(tool, { command: `${allowedFileCommand} && printenv` })).toBe("ok");
    expect(executeCalls[0]?.env).toBeUndefined();

    const confirmInput = { command: `${trustedNodeCommand} && curl -d x https://example.test/upload` };
    issueApprovalProof(state, {
      sessionId: state.sessionId,
      runId: "run",
      toolCallId: "tool",
      commandDigest: commandConfirmationDigest(state.sessionId, confirmInput),
    });
    expect(await executeTool(tool, confirmInput, approvalContext("run", "tool"))).toBe("ok");
    expect(resolveCount).toBe(0);
    expect(executeCalls[1]?.env).toBeUndefined();
  });

  it("generic bin CLI 与 lark-cli 均不解析、不接收托管凭据", async () => {
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";
    const root = mkdtempSync(resolve(tmpdir(), "gated-credential-bin-"));
    const extension = process.platform === "win32" ? ".cmd" : "";
    const cliName = `yuque-cli${extension}`;
    const cliPath = resolve(root, cliName);
    writeFileSync(cliPath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") chmodSync(cliPath, 0o755);
    let resolveCount = 0;
    const { tool, executeCalls } = createToolHarness("gated-credential-generic", {
      sandboxBinDir: root,
      resolveCredentialEnv: () => {
        resolveCount += 1;
        return { PLATFORM_API_SECRET: "must-not-leak" };
      },
    });
    try {
      expect(await executeTool(tool, { command: `${cliName} list` })).toBe("ok");
      expect(await executeTool(tool, { command: "lark-cli whoami" })).toBe("ok");
      expect(resolveCount).toBe(0);
      expect(executeCalls).toHaveLength(2);
      expect(executeCalls[0]?.env).toBeUndefined();
      expect(executeCalls[1]?.env).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("开关关闭时受信 node skill 脚本也不解析、不接收凭据", async () => {
    process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "0";
    let resolveCount = 0;
    const { tool, executeCalls } = createToolHarness("gated-credential-disabled", {
      resolveCredentialEnv: () => {
        resolveCount += 1;
        return { PLATFORM_API_SECRET: "must-not-leak" };
      },
    });

    expect(await executeTool(tool, { command: allowedFileCommand })).toBe("ok");
    expect(resolveCount).toBe(0);
    expect(executeCalls[0]?.env).toBeUndefined();
  });
});
