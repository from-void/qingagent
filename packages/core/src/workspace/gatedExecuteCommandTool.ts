import { createTool } from "@mastra/core/tools";
import {
  SandboxTimeoutError,
  WORKSPACE_TOOLS,
  type ProcessHandle,
  type Workspace,
} from "@mastra/core/workspace";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";
import { commandPolicyDenyMessage, evaluateCommandPolicy } from "./commandPolicy.js";
import { consumeApprovalProof, type ApprovalProofSession } from "../confirm/approvalProof.js";
import {
  commandConfirmationDigest,
  executeCommandInputSchema,
} from "../confirm/commandConfirmation.js";
import {
  SANDBOX_TIMEOUT_MS,
  sessionWorkspaceDir,
  shouldInjectCredentials,
} from "./sessionWorkspace.js";
import {
  effectiveBackgroundTimeoutMs,
  formatCommandDuration,
  SANDBOX_BACKGROUND_TTL_MS,
} from "./backgroundCommandLimits.js";
import { formatRetainedOutputNotice } from "./retainedOutputNotice.js";
import {
  credentialFailureNotice,
  diagnoseCredentialFailure,
} from "../credentials/credentialFailureDiagnosis.js";

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const EXECUTE_COMMAND_MAX_RETAINED_BYTES =
  positiveIntegerEnv("QINGAGENT_SANDBOX_MAX_RETAINED_BYTES", 1_048_576);
export const SANDBOX_MAX_BACKGROUND_PROCESSES =
  positiveIntegerEnv("QINGAGENT_SANDBOX_MAX_BACKGROUND_PROCESSES", 4);
export { SANDBOX_BACKGROUND_TTL_MS } from "./backgroundCommandLimits.js";

const backgroundSpawnLocks = new Map<string, Promise<void>>();

const UNHEALTHY_WORKSPACE_STATUSES = new Set<Workspace["status"]>([
  "error",
  "destroying",
  "destroyed",
  "paused",
]);
const UNHEALTHY_SANDBOX_STATUSES = new Set<NonNullable<Workspace["sandbox"]>["status"]>([
  "error",
  "stopping",
  "stopped",
  "destroying",
  "destroyed",
]);

const TRUNCATED_OUTPUT_NOTICE =
  "[This is the tail of the complete output. To see more, increase tail or use 0 for all output; do not rerun the command to obtain complete output because it may have side effects.]";

export interface GatedExecuteCommandToolOptions {
  sessionId: string;
  /** proof 仅绑定当前内存会话；缺失时 confirm 命令必须 fail-closed。 */
  state?: ApprovalProofSession;
  getWorkspace: () => Promise<Workspace>;
  /** 后台进程需把 Workspace 租约延长到自身退出。 */
  retainWorkspace?: () => () => void;
  /** 仅供受信 node skill 脚本按次获取托管凭据；其它命令不会调用。 */
  resolveCredentialEnv?: () => Promise<Record<string, string>> | Record<string, string>;
  /** 测试可注入临时产品 CLI 目录；生产默认使用 SANDBOX_BIN_DIR。 */
  sandboxBinDir?: string;
}

function tailLines(
  output: string,
  tail?: number | null,
): { output: string; truncated: boolean } {
  if (!tail || tail <= 0) return { output, truncated: false };
  const lines = output.split(/\r?\n/);
  if (lines.length <= tail) return { output, truncated: false };
  return {
    output: lines.slice(-tail).join("\n"),
    truncated: true,
  };
}

export interface GatedCommandResult {
  success: boolean;
  exitCode: number;
  /** 只代表"用户/系统主动取消"(abortSignal 触发)。被信号打死不算。 */
  cancelled: boolean;
  timedOut: boolean;
  /**
   * 进程被信号终止,且不是我们主动取消、也不是超时。常见于沙箱写墙拒绝、OOM、
   * 外部 kill。历史上它被并入 cancelled,模型看到"已取消"就会替用户编理由
   * ("可能是你没及时点确认"),真机上已实证。必须单独成态。
   */
  killed?: boolean;
  output: string;
  pid?: string;
  background?: true;
}

/**
 * 凭据/登录类失败的如实说明。与 killedCommandNotice 同一位置、同一风格:
 * 命令本身没被我们掐死,但输出里已经写明"扫码成功却存不下登录",
 * 不追加说明的话模型会照旧编成"你没扫码"并再发一张二维码(0729 真机实证)。
 * 判不出来就返回空串,绝不瞎归因。
 */
export function credentialFailureNoticeFor(result: {
  output: string;
  timedOut?: boolean;
  killed?: boolean;
}): string {
  const diagnosis = diagnoseCredentialFailure(result);
  return diagnosis ? credentialFailureNotice(diagnosis) : "";
}

/** 被信号打死时给模型的如实说明:讲清事实与常见成因,并堵死"用户取消"的误读。 */
export function killedCommandNotice(exitCode: number): string {
  return [
    `进程被信号终止(退出码 ${exitCode})。`,
    "这不是用户取消,也不是用户没有确认——确认已经通过,命令确实启动过。",
    "常见成因:命令试图写入沙箱不允许写的目录、内存不足、或被外部进程结束。",
    "如需继续,请先根据输出判断是权限还是资源问题,再决定换路径重试或改用后台执行。",
  ].join("");
}

type SandboxWriter = {
  custom: (chunk: Record<string, unknown>) => Promise<unknown> | unknown;
};

async function safeCustom(
  writer: SandboxWriter | undefined,
  chunk: Record<string, unknown>,
): Promise<void> {
  try {
    await writer?.custom(chunk);
  } catch {
    // 流式帧只是附加信息；writer 故障不得改写已经确定的命令终态。
  }
}

function formatCommandOutput(result: {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutDroppedBytes?: number;
  stderrDroppedBytes?: number;
}, tail?: number | null): string {
  const stdoutTail = tailLines(result.stdout, tail);
  const stderrTail = tailLines(result.stderr, tail);
  const stdout = stdoutTail.output.trimEnd();
  const stderr = stderrTail.output.trimEnd();
  const retainedOutputNotice = formatRetainedOutputNotice(result);
  if (result.success) {
    const output = stdout && stderr
      ? [`stdout:\n${stdout}\n\nstderr:\n${stderr}`]
      : stdout
        ? [stdout]
        : stderr
          ? ["stderr:", stderr]
          : ["(no output)"];
    return [
      ...output,
      stdoutTail.truncated || stderrTail.truncated ? TRUNCATED_OUTPUT_NOTICE : "",
      retainedOutputNotice,
    ].filter(Boolean).join("\n");
  }
  return [
    stdout,
    stderr,
    `Exit code: ${result.exitCode}`,
    stdoutTail.truncated || stderrTail.truncated ? TRUNCATED_OUTPUT_NOTICE : "",
    retainedOutputNotice,
  ].filter(Boolean).join("\n");
}

function commandResult(input: {
  success: boolean;
  exitCode: number;
  output: string;
  cancelled?: boolean;
  timedOut?: boolean;
  killed?: boolean;
  pid?: string;
  background?: true;
}): GatedCommandResult {
  return {
    success: input.success,
    exitCode: input.exitCode,
    cancelled: input.cancelled ?? false,
    timedOut: input.timedOut ?? false,
    ...(input.killed ? { killed: true } : {}),
    output: input.output,
    ...(input.pid ? { pid: input.pid } : {}),
    ...(input.background ? { background: true as const } : {}),
  };
}

function rejectedCommandResult(reason: string): GatedCommandResult {
  return commandResult({ success: false, exitCode: -1, output: reason });
}

function cancelledCommandResult(reason: string): GatedCommandResult {
  return commandResult({
    success: false,
    exitCode: -1,
    cancelled: true,
    output: reason,
  });
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

async function withBackgroundSpawnLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = backgroundSpawnLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const queued = previous.then(() => current);
  backgroundSpawnLocks.set(sessionId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (backgroundSpawnLocks.get(sessionId) === queued) {
      backgroundSpawnLocks.delete(sessionId);
    }
  }
}

async function terminateSpawnedProcess(handle: ProcessHandle): Promise<void> {
  try {
    const killed = await handle.kill();
    if (!killed) {
      console.warn("[gatedExecuteCommandTool] 后台进程取消时已退出，继续等待回收", {
        pid: handle.pid,
      });
    }
  } catch (error) {
    console.warn("[gatedExecuteCommandTool] 后台进程终止失败，继续等待回收", {
      pid: handle.pid,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  } finally {
    try {
      await handle.wait();
    } catch (error) {
      console.warn("[gatedExecuteCommandTool] 后台进程等待回收失败", {
        pid: handle.pid,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

export function createGatedExecuteCommandTool({
  sessionId,
  state,
  getWorkspace,
  retainWorkspace,
  resolveCredentialEnv = resolveManagedCredentialEnv,
  sandboxBinDir,
}: GatedExecuteCommandToolOptions) {
  return createTool({
    id: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
    description:
      "Execute a shell command in the workspace sandbox. " +
      "Install, external-send, and destructive effects require explicit user approval. " +
      "Commands that block waiting for user authorization (QR-scan / login / init flows that " +
      "print an auth link then wait) MUST run with background:true; then poll " +
      "mastra_workspace_get_process_output for the auth URL and present it via show_qr.",
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
        return cancelledCommandResult("命令已取消: 调用前请求已被取消");
      }
      const stopHeartbeat = startToolHeartbeat(context, {
        tool: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
      });
      try {
      const sessionDir = sessionWorkspaceDir(sessionId);
      const cwd = resolveExecutionCwd(sessionDir, input.cwd);
      if (!cwd) {
        return rejectedCommandResult(commandPolicyDenyMessage({
          action: "deny",
          reason: "cwd 必须位于当前会话工作目录内",
        }));
      }

      const decision = evaluateCommandPolicy(input.command, {
        workspaceCwd: sessionDir,
        background: input.background === true,
        sandboxBinDir,
      });
      if (decision.action === "deny") {
        return rejectedCommandResult(commandPolicyDenyMessage(decision));
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
          return rejectedCommandResult("命令已被拒绝: 缺少有效的用户确认");
        }
        proofConsumed = true;
      }

      const workspace = await getWorkspace();
      const sandbox = workspace.sandbox;
      if (!sandbox) return rejectedCommandResult("命令已被拒绝: 当前会话没有可用沙箱");
      if (
        UNHEALTHY_WORKSPACE_STATUSES.has(workspace.status) ||
        UNHEALTHY_SANDBOX_STATUSES.has(sandbox.status)
      ) {
        return rejectedCommandResult("命令已被拒绝: 当前会话沙箱状态异常");
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
        return cancelledCommandResult("命令已取消: 执行前请求已被取消");
      }
      const timeoutSeconds = typeof input.timeout === "number" ? input.timeout : undefined;
      const explicitTimeout = timeoutSeconds == null ? undefined : timeoutSeconds * 1_000;
      // 前台挡 runaway；后台未显式限时时使用可配置 TTL，避免页面关闭/正常轮次结束后无限存活。
      const foregroundTimeout = explicitTimeout ?? SANDBOX_TIMEOUT_MS;
      // 后台显式 timeout 与默认值共享同一个硬上限，模型无法靠填写超大秒数绕过 TTL。
      const backgroundTimeout = effectiveBackgroundTimeoutMs(timeoutSeconds);
      const backgroundTimeoutClamped =
        explicitTimeout !== undefined && explicitTimeout > SANDBOX_BACKGROUND_TTL_MS;
      const toolCallId = context?.agent?.toolCallId;
      const writer = context?.writer as SandboxWriter | undefined;

      if (input.background) {
        if (!sandbox.processes) {
          return rejectedCommandResult("命令已被拒绝: 当前沙箱不支持后台进程");
        }
        return await withBackgroundSpawnLock(sessionId, async () => {
          if (context?.abortSignal?.aborted) {
            return cancelledCommandResult("命令已取消: 等待后台启动锁期间请求已被取消");
          }
          const processes = await sandbox.processes!.list();
          if (context?.abortSignal?.aborted) {
            return cancelledCommandResult("命令已取消: 后台进程检查期间请求已被取消");
          }
          const runningCount = processes.filter((process) => process.running).length;
          if (runningCount >= SANDBOX_MAX_BACKGROUND_PROCESSES) {
            return rejectedCommandResult(
              `命令已被拒绝: 当前会话后台进程已达上限 ${SANDBOX_MAX_BACKGROUND_PROCESSES}`,
            );
          }
          // 当前 Mastra SpawnProcessOptions 只暴露 timeout/output/abort/env/cwd，
          // LocalSandbox/bwrap 没有 per-process cgroup 或 RLIMIT hook；非特权桌面进程也
          // 不能可靠创建 cgroup。现阶段以 TTL、进程数和输出上限三层有界化，CPU/内存
          // 硬配额仍是残留边界，待框架提供资源控制接口后接入。
          const releaseWorkspace = retainWorkspace?.();
          const abortSignal = context?.abortSignal;
          let abortedDuringSpawn = abortSignal?.aborted === true;
          const markSpawnAborted = () => {
            abortedDuringSpawn = true;
          };
          abortSignal?.addEventListener("abort", markSpawnAborted);
          let handle: ProcessHandle;
          try {
            handle = await sandbox.processes!.spawn(input.command, {
              cwd,
              ...perCallCredentialEnv,
              timeout: backgroundTimeout,
              maxRetainedBytes: EXECUTE_COMMAND_MAX_RETAINED_BYTES,
              abortSignal,
            });
          } catch (error) {
            abortSignal?.removeEventListener("abort", markSpawnAborted);
            releaseWorkspace?.();
            throw error;
          }
          if (abortedDuringSpawn || abortSignal?.aborted) {
            try {
              await terminateSpawnedProcess(handle);
            } finally {
              abortSignal?.removeEventListener("abort", markSpawnAborted);
              releaseWorkspace?.();
            }
            return cancelledCommandResult("命令已取消: 后台进程启动期间请求已被取消");
          }
          // 检查与移除监听之间没有 await，abort 不能插入这段同步临界区。
          abortSignal?.removeEventListener("abort", markSpawnAborted);
          // wait 可被轮询工具重复调用；这里只负责在真实退出后释放后台活动引用。
          void handle.wait().then(
            () => releaseWorkspace?.(),
            () => releaseWorkspace?.(),
          );
          const clampedLabel = backgroundTimeoutClamped ? "，已按后台上限钳制" : "";
          return commandResult({
            success: true,
            exitCode: 0,
            output: `Started background process (PID: ${handle.pid}; 最长运行: ${
              formatCommandDuration(backgroundTimeout)
            }${clampedLabel})`,
            pid: String(handle.pid),
            background: true,
          });
        });
      }

      if (!sandbox.executeCommand) {
        return rejectedCommandResult("命令已被拒绝: 当前沙箱不支持命令执行");
      }
      const startedAt = Date.now();
      try {
        const result = await sandbox.executeCommand(input.command, [], {
          cwd,
          ...perCallCredentialEnv,
          timeout: foregroundTimeout,
          maxRetainedBytes: EXECUTE_COMMAND_MAX_RETAINED_BYTES,
          abortSignal: context?.abortSignal,
          onStdout: async (data) => {
            await safeCustom(writer, {
              type: "data-sandbox-stdout",
              data: { output: data, timestamp: Date.now(), toolCallId },
              transient: true,
            });
          },
          onStderr: async (data) => {
            await safeCustom(writer, {
              type: "data-sandbox-stderr",
              data: { output: data, timestamp: Date.now(), toolCallId },
              transient: true,
            });
          },
        });
        const timedOut = result.timedOut === true;
        // 只有我们自己的 abortSignal 触发才叫"取消"。被信号打死(killed)另算一态:
        // 沙箱写墙拒绝 / OOM / 外部 kill 都会走到这里,把它说成"用户取消"会让模型
        // 反过来责怪用户没点确认(0729 真机 P1 实证:319ms 被 SIGKILL、exitCode 128)。
        const cancelled = !timedOut && context?.abortSignal?.aborted === true;
        const killed = !timedOut && !cancelled && result.killed === true;
        const commandOutput = formatCommandOutput(result, input.tail);
        const succeeded = result.success && result.exitCode === 0 && !cancelled && !timedOut && !killed;
        // 凭据诊断只在非成功回合追加,成功回合不打扰模型。
        const credentialNotice = succeeded
          ? ""
          : credentialFailureNoticeFor({ output: commandOutput, timedOut, killed });
        const terminalResult = commandResult({
          success: succeeded,
          exitCode: result.exitCode,
          cancelled,
          timedOut,
          killed,
          output: [
            commandOutput,
            killed ? killedCommandNotice(result.exitCode) : "",
            credentialNotice,
          ].filter(Boolean).join("\n"),
        });
        await safeCustom(writer, {
          type: "data-sandbox-exit",
          data: {
            exitCode: result.exitCode,
            success: result.success,
            executionTimeMs: result.executionTimeMs,
            toolCallId,
          },
        });
        return terminalResult;
      } catch (error) {
        const timedOut = error instanceof SandboxTimeoutError;
        const cancelled = !timedOut && context?.abortSignal?.aborted === true;
        const reason = error instanceof Error ? error.message : String(error);
        const terminalResult = commandResult({
          success: false,
          exitCode: -1,
          cancelled,
          timedOut,
          output: timedOut
            ? `命令执行超时: ${reason}`
            : cancelled
              ? `命令已取消: ${reason}`
              : `Error: ${reason}`,
        });
        await safeCustom(writer, {
          type: "data-sandbox-exit",
          data: {
            exitCode: -1,
            success: false,
            executionTimeMs: Date.now() - startedAt,
            toolCallId,
          },
        });
        return terminalResult;
      }
      } finally {
        stopHeartbeat();
      }
    },
  });
}
