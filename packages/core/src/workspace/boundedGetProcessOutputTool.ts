import { createTool } from "@mastra/core/tools";
import {
  SandboxFeatureNotSupportedError,
  SandboxNotAvailableError,
  WORKSPACE_TOOLS,
  type CommandResult,
  type ProcessHandle,
  type Workspace,
} from "@mastra/core/workspace";
import { z } from "zod";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";
import {
  formatRetainedOutputNotice,
  type RetainedOutputState,
} from "./retainedOutputNotice.js";

/** 与 Mastra 1.49.0 workspace get_process_output 的默认 tail 行数一致。 */
export const GET_PROCESS_OUTPUT_DEFAULT_TAIL_LINES = 200;

const TRUNCATED_OUTPUT_NOTICE =
  "[This is the tail of the complete output. To see more, increase tail or use 0 for all output; do not rerun the command to obtain complete output because it may have side effects.]";

/**
 * 交互式授权进程往往先打印可扫码/可点击 URL，再停住等待用户操作。这里仅在
 * “URL + 授权语义”同时出现时提前结束本次 wait，避免把普通长任务的进度输出误判成授权。
 */
export const INTERACTIVE_AUTH_OUTPUT_KEYWORDS: readonly RegExp[] = [
  /扫码/u,
  /扫描/u,
  /授权/u,
  /二维码/u,
  /登录/u,
  /认证/u,
  /\bscan(?:s|ned|ning)?\b/iu,
  /\bauthori[sz](?:e|es|ed|ing|ation)\b/iu,
  /\bauthenticat(?:e|es|ed|ing|ion)\b/iu,
  /\bqr[\s_-]*code\b/iu,
  /\blog[\s_-]?in\b/iu,
  /\bsign[\s_-]?in\b/iu,
];

const INTERACTIVE_AUTH_URL_PATTERN = /https?:\/\/[^\s"'<>]+/iu;
const PROCESS_OUTPUT_POLL_INTERVAL_MS = 100;
const processExitPromises = new WeakMap<ProcessHandle, Promise<CommandResult>>();

function hasInteractiveAuthOutputSignal(stdout: string, stderr: string): boolean {
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return (
    INTERACTIVE_AUTH_URL_PATTERN.test(output) &&
    INTERACTIVE_AUTH_OUTPUT_KEYWORDS.some((keyword) => keyword.test(output))
  );
}

function observeProcessExit(handle: ProcessHandle): Promise<CommandResult> {
  const existing = processExitPromises.get(handle);
  if (existing) return existing;
  const waitPromise = handle.wait();
  processExitPromises.set(handle, waitPromise);
  void waitPromise.then(
    () => processExitPromises.delete(handle),
    () => processExitPromises.delete(handle),
  );
  return waitPromise;
}

function retainedOutputDelta(previous: string, current: string): string {
  if (current === previous) return "";
  return current.startsWith(previous) ? current.slice(previous.length) : current;
}

/**
 * 必须显著小于默认 AGENT_IDLE_TIMEOUT_MS(90s)，确保即使模型误传 wait:true，
 * 也会在 agent 空闲看门狗前把控制权交还模型。环境变量只供部署按需收紧或调整。
 */
export const PROCESS_WAIT_MAX_MS = normalizeWaitMaxMs(
  Number(process.env.QINGAGENT_PROCESS_WAIT_MAX_MS) || 60_000,
);

export interface BoundedGetProcessOutputToolOptions {
  getWorkspace: () => Promise<Workspace>;
  /** 仅供单测注入较短等待上限；生产使用 PROCESS_WAIT_MAX_MS。 */
  waitMaxMs?: number;
}

type SandboxWriter = {
  custom: (chunk: Record<string, unknown>) => Promise<unknown> | unknown;
};

function normalizeWaitMaxMs(value: number): number {
  if (!Number.isFinite(value)) return 60_000;
  return Math.max(1, Math.floor(value));
}

/** 对齐 Mastra applyTail：负数取绝对值，0 不限，默认保留最后 200 行。 */
function applyTail(output: string, tail: number | null | undefined): string {
  if (!output) return output;
  const n = Math.abs(tail ?? GET_PROCESS_OUTPUT_DEFAULT_TAIL_LINES);
  if (n === 0) return output;
  const trailingNewline = output.endsWith("\n");
  const lines = (trailingNewline ? output.slice(0, -1) : output).split("\n");
  if (lines.length <= n) return output;
  const sliced = lines.slice(-n).join("\n");
  const body = trailingNewline ? `${sliced}\n` : sliced;
  return `[showing last ${n} of ${lines.length} lines]\n${TRUNCATED_OUTPUT_NOTICE}\n${body}`;
}

function formatOutput(
  stdout: string,
  stderr: string,
  exitCode: number | undefined,
  retainedOutputState: RetainedOutputState,
): string {
  const parts: string[] = [];
  if (!stdout && !stderr) {
    parts.push(exitCode === undefined ? "(no output yet)" : "(no output)");
  } else if (stdout && stderr) {
    parts.push("stdout:", stdout, "", "stderr:", stderr);
  } else if (stdout) {
    parts.push(stdout);
  } else {
    parts.push("stderr:", stderr);
  }
  if (exitCode !== undefined) {
    parts.push("", `Exit code: ${exitCode}`);
  }
  const retainedOutputNotice = formatRetainedOutputNotice(retainedOutputState);
  if (retainedOutputNotice) {
    parts.push("", retainedOutputNotice);
  }
  return parts.join("\n");
}

function formatWaitDuration(waitMaxMs: number): string {
  return waitMaxMs % 1_000 === 0 ? `${waitMaxMs / 1_000}s` : `${waitMaxMs}ms`;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Process output wait aborted",
  );
  error.name = "AbortError";
  return error;
}

async function safeCustom(
  writer: SandboxWriter | undefined,
  chunk: Record<string, unknown>,
): Promise<void> {
  try {
    await writer?.custom(chunk);
  } catch {
    // 流式事件是附加信息；writer 已关闭不应让悬挂 wait 产生未捕获异常。
  }
}

export function createBoundedGetProcessOutputTool({
  getWorkspace,
  waitMaxMs: configuredWaitMaxMs = PROCESS_WAIT_MAX_MS,
}: BoundedGetProcessOutputToolOptions) {
  const waitMaxMs = normalizeWaitMaxMs(configuredWaitMaxMs);
  return createTool({
    id: WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT,
    description: `Get the current output (stdout, stderr) and status of a background process by its PID.

Use this after starting a background command with execute_command (background: true) to check if the process is still running and read its output. Waiting is bounded; if the process has not exited by the limit, the tool returns its current output so it can be polled again.`,
    inputSchema: z.object({
      pid: z.string().describe("The process ID returned when the background command was started"),
      tail: z.number().optional().describe(
        `Number of lines to return, similar to tail -n. Positive or negative returns last N lines from end. Defaults to ${GET_PROCESS_OUTPUT_DEFAULT_TAIL_LINES}. Use 0 for no limit.`,
      ),
      wait: z.boolean().optional().describe(
        "If true, wait up to a bounded limit for the process to exit. If it is still running at the limit, return the current output instead of blocking indefinitely.",
      ),
    }),
    execute: async ({ pid, tail, wait: shouldWait }, context) => {
      const stopHeartbeat = startToolHeartbeat(context, {
        tool: "get_process_output",
      });
      try {
        const workspace = await getWorkspace();
        const sandbox = workspace.sandbox;
        if (!sandbox) throw new SandboxNotAvailableError();
        if (!sandbox.processes) throw new SandboxFeatureNotSupportedError("processes");

        const handle = await sandbox.processes.get(pid);
        if (!handle) {
          return `No background process found with PID ${pid}.`;
        }

        const writer = context?.writer as SandboxWriter | undefined;
        const toolCallId = context?.agent?.toolCallId;
        if (handle.command) {
          await writer?.custom({
            type: "data-sandbox-command",
            data: { command: handle.command, pid, toolCallId },
          });
        }

        let waitTimedOut = false;
        let exitEventEmitted = false;
        let authorizationSignalDetected = false;
        let observedStdout = handle.stdout;
        let observedStderr = handle.stderr;
        if (shouldWait && handle.exitCode === undefined) {
          let resolveAuthorizationSignal: (() => void) | undefined;
          const authorizationSignalPromise = new Promise<{ kind: "authorizationSignal" }>(
            (resolve) => {
              resolveAuthorizationSignal = () => resolve({ kind: "authorizationSignal" });
            },
          );
          const detectAuthorizationSignal = () => {
            if (
              !authorizationSignalDetected &&
              hasInteractiveAuthOutputSignal(observedStdout, observedStderr)
            ) {
              authorizationSignalDetected = true;
              resolveAuthorizationSignal?.();
            }
          };
          detectAuthorizationSignal();

          const waitPromise = observeProcessExit(handle);
          const pollRetainedOutput = async () => {
            const nextStdout = handle.stdout;
            const nextStderr = handle.stderr;
            const stdoutDelta = retainedOutputDelta(observedStdout, nextStdout);
            const stderrDelta = retainedOutputDelta(observedStderr, nextStderr);
            observedStdout = nextStdout;
            observedStderr = nextStderr;
            detectAuthorizationSignal();
            if (stdoutDelta) {
              await safeCustom(writer, {
                type: "data-sandbox-stdout",
                data: { output: stdoutDelta, timestamp: Date.now(), toolCallId },
                transient: true,
              });
            }
            if (stderrDelta) {
              await safeCustom(writer, {
                type: "data-sandbox-stderr",
                data: { output: stderrDelta, timestamp: Date.now(), toolCallId },
                transient: true,
              });
            }
          };
          const pollInterval = setInterval(
            () => void pollRetainedOutput(),
            Math.min(PROCESS_OUTPUT_POLL_INTERVAL_MS, waitMaxMs),
          );

          let timeout: ReturnType<typeof setTimeout> | undefined;
          const abortSignal = context?.abortSignal;
          let abortListener: (() => void) | undefined;
          try {
            const races: Array<Promise<
              | { kind: "exited"; result: CommandResult }
              | { kind: "timeout" }
              | { kind: "aborted" }
              | { kind: "authorizationSignal" }
            >> = [
              waitPromise.then((result) => ({ kind: "exited" as const, result })),
              new Promise<{ kind: "timeout" }>((resolve) => {
                timeout = setTimeout(() => resolve({ kind: "timeout" }), waitMaxMs);
              }),
              authorizationSignalPromise,
            ];
            if (abortSignal) {
              races.push(new Promise<{ kind: "aborted" }>((resolve) => {
                abortListener = () => resolve({ kind: "aborted" });
                if (abortSignal.aborted) abortListener();
                else abortSignal.addEventListener("abort", abortListener, { once: true });
              }));
            }

            const outcome = await Promise.race(races);
            await pollRetainedOutput();
            if (outcome.kind === "exited") {
              await safeCustom(writer, {
                type: "data-sandbox-exit",
                data: {
                  pid,
                  exitCode: outcome.result.exitCode,
                  success: outcome.result.success,
                  timedOut: outcome.result.timedOut === true,
                  executionTimeMs: outcome.result.executionTimeMs,
                  toolCallId,
                },
              });
              exitEventEmitted = true;
            } else if (outcome.kind === "aborted") {
              // 只结束本次有界读取；后台 ProcessHandle 继续存活，绝不在这里隐式 kill。
              throw abortError(abortSignal!);
            } else {
              waitTimedOut =
                outcome.kind === "timeout" && handle.exitCode === undefined;
            }
          } finally {
            clearInterval(pollInterval);
            if (timeout) clearTimeout(timeout);
            if (abortListener) {
              abortSignal?.removeEventListener("abort", abortListener);
            }
          }
        }

        if (!exitEventEmitted && handle.exitCode !== undefined) {
          exitEventEmitted = true;
          await safeCustom(writer, {
            type: "data-sandbox-exit",
            data: {
              pid,
              exitCode: handle.exitCode,
              success: handle.exitCode === 0,
              timedOut: false,
              toolCallId,
            },
          });
        }

        const currentStdout = authorizationSignalDetected ? observedStdout : handle.stdout;
        const currentStderr = authorizationSignalDetected ? observedStderr : handle.stderr;
        const stdout = applyTail(currentStdout, tail);
        const stderr = applyTail(currentStderr, tail);
        const output = formatOutput(stdout, stderr, handle.exitCode, handle);
        if (!waitTimedOut) return output;
        return [
          output,
          "",
          `进程仍在运行（等待 ${formatWaitDuration(waitMaxMs)} 未退出）。可稍后不带 wait 再次轮询，或用 kill_process 终止后重试。`,
        ].join("\n");
      } finally {
        stopHeartbeat();
      }
    },
  });
}
