import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@mastra/core/workspace";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BUILTIN_SKILLS_DIR } from "../skills/paths.js";
import {
  EXECUTE_COMMAND_MAX_RETAINED_BYTES,
  createGatedExecuteCommandTool,
} from "../workspace/gatedExecuteCommandTool.js";
import { SANDBOX_TIMEOUT_MS, sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";
import { RequestContext } from "@mastra/core/request-context";
import { createSession } from "../session/sessionState.js";
import { commandConfirmationDigest } from "../confirm/commandConfirmation.js";
import { issueApprovalProof } from "../confirm/approvalProof.js";
import type { SessionState } from "../session/sessionState.js";

interface GatedExecuteInput {
  command: string;
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
const dingtalkScript = resolve(BUILTIN_SKILLS_DIR, "capability", "dingtalk-docs", "scripts", "dingtalk.mjs");
const allowedFileCommand = `node ${JSON.stringify(calcScript)} stats --file passwd`;
const dingtalkCommand = `node ${JSON.stringify(dingtalkScript)} doc-list`;
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
    workspaceStatus?: "ready" | "error";
    sandboxStatus?: "ready" | "running" | "error";
  } = {},
) {
  const executeCalls: SandboxExecuteOptions[] = [];
  const spawnCalls: SandboxSpawnOptions[] = [];
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
        return {
          success: true,
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          executionTimeMs: 1,
        };
      },
      processes: {
        spawn: async (_command: string, options: SandboxSpawnOptions) => {
          spawnCalls.push(options);
          return { pid: 12345 };
        },
      },
    },
  } as unknown as Workspace;
  const tool = createGatedExecuteCommandTool({
    sessionId,
    state: options.state,
    getWorkspace: async () => workspace,
    resolveCredentialEnv: options.resolveCredentialEnv ?? (() => ({})),
    sandboxBinDir: options.sandboxBinDir,
  });
  return { tool, executeCalls, spawnCalls };
}

async function executeTool(
  tool: ReturnType<typeof createGatedExecuteCommandTool>,
  input: GatedExecuteInput,
  context = toolInvocationOptions,
): Promise<string> {
  if (!tool.execute) throw new Error("execute_command execute missing");
  return await tool.execute(input, context) as string;
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
  it("rejects empty and overlong command inputs", () => {
    const tool = createGatedExecuteCommandTool({
      sessionId: "schema-test",
      getWorkspace: async () => {
        throw new Error("schema test does not execute commands");
      },
    });

    expect(validateToolInput(tool, { command: "" }).success).toBe(false);
    expect(validateToolInput(tool, { command: "x".repeat(8192) }).success).toBe(true);
    expect(validateToolInput(tool, { command: "x".repeat(8193) }).success).toBe(false);
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
    expect(await predicate({ command: allowedFileCommand })).toBe(false);
    expect(await predicate({ command: "node /workspace/untrusted.mjs" })).toBe(false);
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
    const deniedInput = { command: "node /workspace/untrusted.mjs" };
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

    const fg = (await tool.execute({ command: allowedFileCommand }, ctx)) as string;
    const bg = (await tool.execute({ command: allowedFileCommand, background: true }, ctx)) as string;

    expect(fg).toContain("命令已取消");
    expect(bg).toContain("命令已取消");
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
      ) as Promise<string>;

      await vi.advanceTimersByTimeAsync(120_000);

      expect(await execution).toBe("ok");
      expect(controller.signal.aborted).toBe(false);
      expect(writer.write).toHaveBeenCalled();
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      vi.useRealTimers();
    }
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

    const result = await executeTool(tool, { command: allowedFileCommand, background: true });

    expect(result).toBe("Started background process (PID: 12345)");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.maxRetainedBytes).toBe(EXECUTE_COMMAND_MAX_RETAINED_BYTES);
  });

  it("Gap3 回归:后台进程有意长跑,未传 timeout 时不套前台默认超时", async () => {
    const { tool, spawnCalls } = createToolHarness("gated-background-no-default-timeout");

    const result = await executeTool(tool, { command: allowedFileCommand, background: true });

    expect(result).toBe("Started background process (PID: 12345)");
    expect(spawnCalls).toHaveLength(1);
    // 默认超时只对前台;后台不传则保持 undefined(生命周期由 process manager / abortSignal 管理)
    expect(spawnCalls[0]?.timeout).toBeUndefined();
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
        return { DINGTALK_APP_KEY: "app_x", DINGTALK_APP_SECRET: "sec_y" };
      },
    });

    expect(await executeTool(tool, { command: dingtalkCommand })).toBe("ok");
    expect(await executeTool(tool, { command: dingtalkCommand, background: true })).toContain("Started background process");
    expect(resolveCount).toBe(2);
    expect(executeCalls[0]?.env).toEqual({
      DINGTALK_APP_KEY: "app_x",
      DINGTALK_APP_SECRET: "sec_y",
    });
    expect(spawnCalls[0]?.env).toEqual({
      DINGTALK_APP_KEY: "app_x",
      DINGTALK_APP_SECRET: "sec_y",
    });
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
        return { DINGTALK_APP_SECRET: "must-not-leak" };
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
        return { DINGTALK_APP_SECRET: "must-not-leak" };
      },
    });

    expect(await executeTool(tool, { command: allowedFileCommand })).toBe("ok");
    expect(resolveCount).toBe(0);
    expect(executeCalls[0]?.env).toBeUndefined();
  });
});
