import { createTool } from "@mastra/core/tools";
import { WORKSPACE_TOOLS, type Workspace } from "@mastra/core/workspace";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";
import { commandPolicyDenyMessage, evaluateCommandPolicy } from "./commandPolicy.js";
import type { SessionState } from "../session/sessionState.js";
import { consumeApprovalProof } from "../confirm/approvalProof.js";
import {
  commandConfirmationDigest,
  executeCommandInputSchema,
} from "../confirm/commandConfirmation.js";
import {
  SANDBOX_TIMEOUT_MS,
  sessionWorkspaceDir,
  shouldInjectCredentials,
} from "./sessionWorkspace.js";

export const EXECUTE_COMMAND_MAX_RETAINED_BYTES =
  Number(process.env.QINGAGENT_SANDBOX_MAX_RETAINED_BYTES) || 1_048_576;

export interface GatedExecuteCommandToolOptions {
  sessionId: string;
  /** proof 仅绑定当前内存会话；缺失时 confirm 命令必须 fail-closed。 */
  state?: SessionState;
  getWorkspace: () => Promise<Workspace>;
  /** 仅供受信 node skill 脚本按次获取托管凭据；其它命令不会调用。 */
  resolveCredentialEnv?: () => Promise<Record<string, string>> | Record<string, string>;
  /** 测试可注入临时产品 CLI 目录；生产默认使用 SANDBOX_BIN_DIR。 */
  sandboxBinDir?: string;
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

async function resolveManagedCredentialEnv(): Promise<Record<string, string>> {
  try {
    const { getAllCredentialEnv } = await import("../credentials/credentialsRepo.js");
    return await getAllCredentialEnv();
  } catch (error) {
    console.error("[gatedExecuteCommandTool] 凭据注入读取失败", error);
    return {};
  }
}

export function createGatedExecuteCommandTool({
  sessionId,
  state,
  getWorkspace,
  resolveCredentialEnv = resolveManagedCredentialEnv,
  sandboxBinDir,
}: GatedExecuteCommandToolOptions) {
  return createTool({
    id: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
    description:
      "Execute a shell command in the workspace sandbox. " +
      "Install, external-send, and destructive effects require explicit user approval.",
    inputSchema: executeCommandInputSchema,
    requireApproval: (input) => {
      try {
        return evaluateCommandPolicy(input.command, {
          workspaceCwd: sessionWorkspaceDir(sessionId),
          background: input.background === true,
          sandboxBinDir,
        }).action === "confirm";
      } catch {
        // Mastra 也将 predicate 异常按需审批处理；这里显式保持 fail-safe。
        return true;
      }
    },
    execute: async (input, context) => {
      // 已取消则立即短路,不解析 cwd / 不装配 workspace / 不 spawn 子进程——
      // 与 run_js/run_python 的预取消检查一致(底层 Mastra executeCommand 在 signal 已 aborted
      // 时仍会先 spawn 再 kill,对有副作用命令不是严格取消;本工具是模型唯一入口,在此兜住)。
      if (context?.abortSignal?.aborted) {
        return "命令已取消: 调用前请求已被取消";
      }
      const stopHeartbeat = startToolHeartbeat(context, {
        tool: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
      });
      try {
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
        sandboxBinDir,
      });
      if (decision.action === "deny") {
        return commandPolicyDenyMessage(decision);
      }

      let proofConsumed = false;
      if (decision.action === "confirm") {
        const runId = context?.requestContext?.get("runId");
        const toolCallId = context?.agent?.toolCallId;
        const hasProof =
          state !== undefined &&
          typeof runId === "string" && runId.length > 0 &&
          typeof toolCallId === "string" && toolCallId.length > 0 &&
          consumeApprovalProof(state, {
            sessionId,
            runId,
            toolCallId,
            commandDigest: commandConfirmationDigest(sessionId, input),
          });
        if (!hasProof) {
          return "命令已被拒绝: 缺少有效的用户确认";
        }
        proofConsumed = true;
      }

      const workspace = await getWorkspace();
      const sandbox = workspace.sandbox;
      if (!sandbox) return "命令已被拒绝: 当前会话没有可用沙箱";
      if (
        (workspace.status !== undefined && workspace.status !== "ready") ||
        (sandbox.status !== undefined && sandbox.status !== "ready" && sandbox.status !== "running")
      ) {
        return "命令已被拒绝: 当前会话沙箱状态异常";
      }
      // LocalSandbox 基础 env 永不含托管凭据。只有策略已确认的受信 node skill 脚本，
      // 且部署开关显式开启时，才通过 Mastra 的 per-call env 向这个进程发放。
      const credentialEnv =
        decision.credentialConsumer === "trusted-node-skill" &&
        (decision.action === "allow" || proofConsumed) &&
        shouldInjectCredentials() &&
        resolveCredentialEnv
          ? await resolveCredentialEnv()
          : undefined;
      const perCallCredentialEnv = credentialEnv && Object.keys(credentialEnv).length > 0
        ? { env: credentialEnv }
        : {};
      if (context?.abortSignal?.aborted) {
        return "命令已取消: 执行前请求已被取消";
      }
      const timeoutSeconds = typeof input.timeout === "number" ? input.timeout : undefined;
      const explicitTimeout = timeoutSeconds == null ? undefined : timeoutSeconds * 1_000;
      // 前台命令套默认超时挡 runaway;后台进程是有意长跑的(dev server 等),只用模型显式值、不强加默认。
      const foregroundTimeout = explicitTimeout ?? SANDBOX_TIMEOUT_MS;
      const toolCallId = context?.agent?.toolCallId;

      if (input.background) {
        if (!sandbox.processes) return "命令已被拒绝: 当前沙箱不支持后台进程";
        const handle = await sandbox.processes.spawn(input.command, {
          cwd,
          ...perCallCredentialEnv,
          timeout: explicitTimeout,
          maxRetainedBytes: EXECUTE_COMMAND_MAX_RETAINED_BYTES,
          abortSignal: context?.abortSignal,
        });
        return `Started background process (PID: ${handle.pid})`;
      }

      if (!sandbox.executeCommand) return "命令已被拒绝: 当前沙箱不支持命令执行";
      const stopHeartbeat = startToolHeartbeat(context, {
        tool: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
      });
      const startedAt = Date.now();
      try {
        const result = await sandbox.executeCommand(input.command, [], {
          cwd,
          ...perCallCredentialEnv,
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
      } finally {
        stopHeartbeat();
      }
      } finally {
        stopHeartbeat();
      }
    },
  });
}
