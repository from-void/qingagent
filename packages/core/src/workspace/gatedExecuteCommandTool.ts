import { createTool } from "@mastra/core/tools";
import { WORKSPACE_TOOLS, type Workspace } from "@mastra/core/workspace";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { commandPolicyDenyMessage, evaluateCommandPolicy } from "./commandPolicy.js";
import { SANDBOX_TIMEOUT_MS, sessionWorkspaceDir } from "./sessionWorkspace.js";

const secondsSchema = z.preprocess(
  (value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return typeof value === "string" ? Number(value) : value;
  },
  z.number().positive().optional(),
);

const MAX_EXECUTE_COMMAND_LENGTH = 8192;
export const EXECUTE_COMMAND_MAX_RETAINED_BYTES =
  Number(process.env.QINGAGENT_SANDBOX_MAX_RETAINED_BYTES) || 1_048_576;

const executeCommandInputSchema = z.object({
  command: z.string().min(1).max(MAX_EXECUTE_COMMAND_LENGTH),
  timeout: secondsSchema.nullish(),
  cwd: z.string().nullish(),
  tail: z.number().nullish(),
  background: z.boolean().optional(),
});

export interface GatedExecuteCommandToolOptions {
  sessionId: string;
  getWorkspace: () => Promise<Workspace>;
}

function tailLines(output: string, tail?: number | null): string {
  if (!tail || tail <= 0) return output;
  const lines = output.split(/\r?\n/);
  return lines.slice(-tail).join("\n");
}

function formatCommandResult(result: {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}, tail?: number | null): string {
  const stdout = tailLines(result.stdout, tail).trimEnd();
  if (result.success) return stdout || "(no output)";
  const stderr = tailLines(result.stderr, tail).trimEnd();
  return [stdout, stderr, `Exit code: ${result.exitCode}`].filter(Boolean).join("\n");
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideRoot(path: string, root: string): boolean {
  const p = normalizeForCompare(path);
  const r = normalizeForCompare(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function existingRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveExecutionCwd(sessionDir: string, inputCwd?: string | null): string | null {
  if (inputCwd?.includes("\0")) return null;
  mkdirSync(sessionDir, { recursive: true });
  const sessionReal = existingRealpath(sessionDir);
  if (!sessionReal) return null;
  const cwd = inputCwd && inputCwd.length > 0 ? resolve(sessionDir, inputCwd) : sessionDir;
  const cwdReal = existingRealpath(cwd);
  if (!cwdReal) return null;
  return isInsideRoot(cwdReal, sessionReal) ? cwdReal : null;
}

export function createGatedExecuteCommandTool({ sessionId, getWorkspace }: GatedExecuteCommandToolOptions) {
  return createTool({
    id: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
    description:
      "Execute an allowlisted shell command in the workspace sandbox. " +
      "Only trusted packaged skill scripts and explicitly allowed read-only CLI commands can run.",
    inputSchema: executeCommandInputSchema,
    execute: async (input, context) => {
      // 已取消则立即短路,不解析 cwd / 不装配 workspace / 不 spawn 子进程——
      // 与 run_js/run_python 的预取消检查一致(底层 Mastra executeCommand 在 signal 已 aborted
      // 时仍会先 spawn 再 kill,对有副作用命令不是严格取消;本工具是模型唯一入口,在此兜住)。
      if (context?.abortSignal?.aborted) {
        return "命令已取消: 调用前请求已被取消";
      }
      const sessionDir = sessionWorkspaceDir(sessionId);
      const cwd = resolveExecutionCwd(sessionDir, input.cwd);
      if (!cwd) {
        return commandPolicyDenyMessage({
          action: "deny",
          reason: "cwd 必须位于当前会话工作目录内",
        });
      }

      const decision = evaluateCommandPolicy(input.command, {
        workspaceCwd: sessionDir,
        background: input.background === true,
      });
      if (decision.action !== "allow") {
        return commandPolicyDenyMessage(decision);
      }

      const workspace = await getWorkspace();
      const sandbox = workspace.sandbox;
      if (!sandbox) return "命令已被拒绝: 当前会话没有可用沙箱";
      const timeoutSeconds = typeof input.timeout === "number" ? input.timeout : undefined;
      const explicitTimeout = timeoutSeconds == null ? undefined : timeoutSeconds * 1_000;
      // 前台命令套默认超时挡 runaway;后台进程是有意长跑的(dev server 等),只用模型显式值、不强加默认。
      const foregroundTimeout = explicitTimeout ?? SANDBOX_TIMEOUT_MS;
      const toolCallId = context?.agent?.toolCallId;

      if (input.background) {
        if (!sandbox.processes) return "命令已被拒绝: 当前沙箱不支持后台进程";
        const handle = await sandbox.processes.spawn(input.command, {
          cwd,
          timeout: explicitTimeout,
          maxRetainedBytes: EXECUTE_COMMAND_MAX_RETAINED_BYTES,
          abortSignal: context?.abortSignal,
        });
        return `Started background process (PID: ${handle.pid})`;
      }

      if (!sandbox.executeCommand) return "命令已被拒绝: 当前沙箱不支持命令执行";
      const startedAt = Date.now();
      try {
        const result = await sandbox.executeCommand(input.command, [], {
          cwd,
          timeout: foregroundTimeout,
          maxRetainedBytes: EXECUTE_COMMAND_MAX_RETAINED_BYTES,
          abortSignal: context?.abortSignal,
          onStdout: async (data) => {
            await context?.writer?.custom({
              type: "data-sandbox-stdout",
              data: { output: data, timestamp: Date.now(), toolCallId },
              transient: true,
            });
          },
          onStderr: async (data) => {
            await context?.writer?.custom({
              type: "data-sandbox-stderr",
              data: { output: data, timestamp: Date.now(), toolCallId },
              transient: true,
            });
          },
        });
        await context?.writer?.custom({
          type: "data-sandbox-exit",
          data: {
            exitCode: result.exitCode,
            success: result.success,
            executionTimeMs: result.executionTimeMs,
            toolCallId,
          },
        });
        return formatCommandResult(result, input.tail);
      } catch (error) {
        await context?.writer?.custom({
          type: "data-sandbox-exit",
          data: {
            exitCode: -1,
            success: false,
            executionTimeMs: Date.now() - startedAt,
            toolCallId,
          },
        });
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
