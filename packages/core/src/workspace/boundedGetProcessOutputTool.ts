import { createTool } from "@mastra/core/tools";
import {
  SandboxFeatureNotSupportedError,
  SandboxNotAvailableError,
  WORKSPACE_TOOLS,
  type CommandResult,
  type Workspace,
} from "@mastra/core/workspace";
import { z } from "zod";
import { startToolHeartbeat } from "../tools/toolHeartbeat.js";

/** 与 Mastra 1.49.0 workspace get_process_output 的默认 tail 行数一致。 */
export const GET_PROCESS_OUTPUT_DEFAULT_TAIL_LINES = 200;

const TRUNCATED_OUTPUT_NOTICE =
  "[This is the tail of the complete output. To see more, increase tail or use 0 for all output; do not rerun the command to obtain complete output because it may have side effects.]";

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
): string {
  if (!stdout && !stderr) return "(no output yet)";
  const parts: string[] = [];
  if (stdout && stderr) {
    parts.push("stdout:", stdout, "", "stderr:", stderr);
  } else if (stdout) {
    parts.push(stdout);
  } else {
    parts.push("stderr:", stderr);
  }
  if (exitCode !== undefined) {
    parts.push("", `Exit code: ${exitCode}`);
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

/**
 * wait race 超时后，ProcessHandle 仍保留回调直到进程退出。writer 此时可能已经收尾，
 * 所以所有流式回调必须同时吞掉同步异常和异步 rejection，不能污染后续 agent 轮次。
 */
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
        if (shouldWait && handle.exitCode === undefined) {
          const waitPromise = handle.wait({
            onStdout: writer
              ? (data) => safeCustom(writer, {
                  type: "data-sandbox-stdout",
                  data: { output: data, timestamp: Date.now(), toolCallId },
                  transient: true,
                })
              : undefined,
            onStderr: writer
              ? (data) => safeCustom(writer, {
                  type: "data-sandbox-stderr",
                  data: { output: data, timestamp: Date.now(), toolCallId },
                  transient: true,
                })
              : undefined,
          });
          // race 输掉后 wait 仍会在进程退出时 settle；显式挂 rejection handler，避免
          // provider 的 wait 实现或迟到 writer 回调形成 unhandled rejection。
          void waitPromise.catch(() => {});

          let timeout: ReturnType<typeof setTimeout> | undefined;
          const abortSignal = context?.abortSignal;
          let abortListener: (() => void) | undefined;
          try {
            const races: Array<Promise<
              | { kind: "exited"; result: CommandResult }
              | { kind: "timeout" }
              | { kind: "aborted" }
            >> = [
              waitPromise.then((result) => ({ kind: "exited" as const, result })),
              new Promise<{ kind: "timeout" }>((resolve) => {
                timeout = setTimeout(() => resolve({ kind: "timeout" }), waitMaxMs);
              }),
            ];
            if (abortSignal) {
              races.push(new Promise<{ kind: "aborted" }>((resolve) => {
                abortListener = () => resolve({ kind: "aborted" });
                if (abortSignal.aborted) abortListener();
                else abortSignal.addEventListener("abort", abortListener, { once: true });
              }));
            }

            const outcome = await Promise.race(races);
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
              waitTimedOut = handle.exitCode === undefined;
              if (waitTimedOut) {
                // 有界读取返回后，原 wait 仍掌握真实退出结果。若 agent 流尚存活，
                // 用同一原生退出帧补发；writer 已关闭时 safeCustom 安静降级到下次轮询。
                void waitPromise.then(async (result) => {
                  if (exitEventEmitted) return;
                  exitEventEmitted = true;
                  await safeCustom(writer, {
                    type: "data-sandbox-exit",
                    data: {
                      pid,
                      exitCode: result.exitCode,
                      success: result.success,
                      timedOut: result.timedOut === true,
                      executionTimeMs: result.executionTimeMs,
                      toolCallId,
                    },
                  });
                }).catch(() => {});
              }
            }
          } finally {
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

        const stdout = applyTail(handle.stdout, tail);
        const stderr = applyTail(handle.stderr, tail);
        const output = formatOutput(stdout, stderr, handle.exitCode);
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
