import {
  sanitizeVisibleText,
  type BridgeFrame,
  type MessagePart,
} from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";
import { appendPartToChatHistory, nextSeq } from "../session/sessionState.js";
import { chatMessageAppended } from "./frames.js";
import type { AgentStreamErrorEvent } from "./agentStreamEvents.js";

export const USER_ABORT_REASON = "user_abort";
export const IDLE_TIMEOUT_ABORT_REASON = "idle_timeout";

export interface IdleTimeoutOptions<T> {
  /** 每个模型段首个内容性 chunk 到达前允许等待的时间；默认沿用常规 idle。 */
  firstChunkTimeoutMs?: number;
  /** 连续只有 heartbeat 时允许维持主流的最长时间。 */
  heartbeatOnlyTimeoutMs?: number;
  isHeartbeat?: (chunk: T) => boolean;
  /** 只有实际产出才结束段首宽限；start/step-start 等元数据不算。 */
  isContentful?: (chunk: T) => boolean;
  /** 工具结果等边界会开启下一模型段的首内容宽限。 */
  startsContentSegment?: (chunk: T) => boolean;
  /** 外部取消时提前结束等待，并走底层迭代器收尾。 */
  abortSignal?: AbortSignal;
}

export function isUserAbortSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== IDLE_TIMEOUT_ABORT_REASON;
}

export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => void,
  options: IdleTimeoutOptions<T> = {},
): AsyncGenerator<T | AgentStreamErrorEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let timedOut = false;
  let waitingForSegmentContent = true;
  let heartbeatOnlySince: number | null = null;
  const idleTimeoutSignal = Symbol("idle-timeout");
  const heartbeatTimeoutSignal = Symbol("heartbeat-only-timeout");
  const abortedSignal = Symbol("aborted");
  let naturallyEnded = false;
  try {
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
      const activeIdleTimeoutMs = waitingForSegmentContent
        ? options.firstChunkTimeoutMs ?? timeoutMs
        : timeoutMs;
      const idleTimeout = new Promise<typeof idleTimeoutSignal>((resolve) => {
        idleTimer = setTimeout(() => resolve(idleTimeoutSignal), activeIdleTimeoutMs);
      });
      const next = iterator.next();
      const races: Array<
        Promise<
          | IteratorResult<T>
          | typeof idleTimeoutSignal
          | typeof heartbeatTimeoutSignal
          | typeof abortedSignal
        >
      > = [next, idleTimeout];
      let abortListener: (() => void) | null = null;
      if (options.abortSignal) {
        races.push(new Promise<typeof abortedSignal>((resolve) => {
          abortListener = () => resolve(abortedSignal);
          if (options.abortSignal?.aborted) abortListener();
          else options.abortSignal?.addEventListener("abort", abortListener, { once: true });
        }));
      }
      if (
        heartbeatOnlySince !== null &&
        options.heartbeatOnlyTimeoutMs !== undefined
      ) {
        const remainingMs = Math.max(
          0,
          options.heartbeatOnlyTimeoutMs - (Date.now() - heartbeatOnlySince),
        );
        races.push(new Promise<typeof heartbeatTimeoutSignal>((resolve) => {
          heartbeatTimer = setTimeout(
            () => resolve(heartbeatTimeoutSignal),
            remainingMs,
          );
        }));
      }
      const raced = await Promise.race(races);
      if (abortListener) options.abortSignal?.removeEventListener("abort", abortListener);
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (raced === abortedSignal) {
        void next.then(
          () => undefined,
          () => undefined,
        );
        return;
      }
      if (raced === idleTimeoutSignal || raced === heartbeatTimeoutSignal) {
        timedOut = true;
        // 竞态护栏:timeout 赢了,挂起的 next 还在跑;吞掉它后续可能的 reject,
        // 否则上游在 abort 后才报错会变成 unhandledRejection。
        void next.then(
          () => undefined,
          () => undefined,
        );
        onTimeout();
        yield {
          type: "error",
          payload: {
            idleTimeout: true,
            heartbeatOnly: raced === heartbeatTimeoutSignal,
            error: new Error("agent stream idle timeout"),
          },
        };
        return;
      }
      if (raced.done) {
        naturallyEnded = true;
        return;
      }
      if (options.isHeartbeat?.(raced.value)) {
        heartbeatOnlySince ??= Date.now();
      } else {
        heartbeatOnlySince = null;
        if (options.startsContentSegment?.(raced.value)) {
          waitingForSegmentContent = true;
        } else if (options.isContentful?.(raced.value) ?? true) {
          waitingForSegmentContent = false;
        }
      }
      yield raced.value;
    }
  } finally {
    if (timedOut || !naturallyEnded) {
      // 非阻塞收尾:不能 await(底层 next 仍 pending 时 return() 可能挂起);
      // 但要 catch,防 return() 自身 reject 变 unhandledRejection。
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}

function streamErrorStatusCode(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== "object") return undefined;
  const payload = (chunk as { payload?: unknown }).payload;
  const error =
    payload && typeof payload === "object"
      ? (payload as { error?: unknown }).error
      : undefined;
  if (payload && typeof payload === "object") {
    const statusCode = (payload as { statusCode?: unknown }).statusCode;
    if (statusCode !== undefined) return statusCode;
  }
  if (error && typeof error === "object") {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode !== undefined) return statusCode;
    const status = (error as { status?: unknown }).status;
    if (status !== undefined) return status;
  }
  return undefined;
}

function normalizedStreamErrorStatusCode(chunk: unknown): number | undefined {
  const raw = streamErrorStatusCode(chunk);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

export function streamErrorMessage(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return String(chunk);
  const payload = (chunk as { payload?: unknown }).payload;
  const error =
    payload && typeof payload === "object"
      ? (payload as { error?: unknown }).error
      : undefined;
  if (error instanceof Error) return error.message;
  if (error !== undefined) return String(error);
  return String(chunk);
}

function streamErrorName(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const payload = (chunk as { payload?: unknown }).payload;
  const error =
    payload && typeof payload === "object"
      ? (payload as { error?: unknown }).error
      : undefined;
  if (error && typeof error === "object") {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

export type StreamErrorCategory =
  | "auth"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "upstream"
  | "network"
  | "unknown";

export type StreamErrorAction =
  | "retry"
  | "check_model_settings"
  | "check_balance"
  | "reload"
  | "none";

export interface StreamErrorDetails {
  reason: string;
  retriable: boolean;
  statusCode?: number;
  category: StreamErrorCategory;
  userMessage: string;
  action: StreamErrorAction;
}

export function isIdleTimeoutChunk(chunk: unknown): boolean {
  return Boolean(
    chunk &&
      typeof chunk === "object" &&
      (chunk as { payload?: { idleTimeout?: boolean } }).payload?.idleTimeout === true,
  );
}

function isAbortOrCancelErrorChunk(chunk: unknown): boolean {
  const name = streamErrorName(chunk).toLowerCase();
  const message = streamErrorMessage(chunk).toLowerCase();
  return (
    name.includes("abort") ||
    name.includes("cancel") ||
    message.includes("aborted") ||
    message.includes("cancelled") ||
    message.includes("canceled") ||
    message.includes("operation was aborted")
  );
}

export function isTransientStreamErrorChunk(chunk: unknown): boolean {
  if (isIdleTimeoutChunk(chunk) || isAbortOrCancelErrorChunk(chunk)) return false;
  if (normalizedStreamErrorStatusCode(chunk) !== undefined) return false;
  const message = streamErrorMessage(chunk).toLowerCase();
  return [
    "econnreset",
    "etimedout",
    "socket hang up",
    "other side closed",
    "fetch failed",
    "terminated",
  ].some((needle) => message.includes(needle));
}

export function streamErrorDetails(chunk: unknown): StreamErrorDetails {
  if (isIdleTimeoutChunk(chunk)) {
    const userMessage = "生成长时间无响应，请重试。";
    return {
      reason: userMessage,
      retriable: true,
      category: "timeout",
      userMessage,
      action: "retry",
    };
  }
  const statusCode = normalizedStreamErrorStatusCode(chunk);
  if (statusCode === 401 || statusCode === 403) {
    const userMessage = "模型密钥无效或权限不足，请检查模型配置。";
    return {
      reason: userMessage,
      retriable: false,
      statusCode,
      category: "auth",
      userMessage,
      action: "check_model_settings",
    };
  }
  if (statusCode === 402) {
    const userMessage = "模型余额或调用额度不足，请检查模型设置或账户余额。";
    return {
      reason: userMessage,
      retriable: false,
      statusCode,
      category: "quota",
      userMessage,
      action: "check_balance",
    };
  }
  if (statusCode === 429) {
    const userMessage = "请求太频繁，请稍后重试。";
    return {
      reason: userMessage,
      retriable: true,
      statusCode,
      category: "rate_limit",
      userMessage,
      action: "retry",
    };
  }
  if (statusCode !== undefined && statusCode >= 500) {
    const userMessage = "模型服务暂时不可用，请稍后重试。";
    return {
      reason: userMessage,
      retriable: true,
      statusCode,
      category: "upstream",
      userMessage,
      action: "retry",
    };
  }
  const userMessage = "模型服务连接失败，请重试。";
  return {
    reason: userMessage,
    retriable: true,
    category: "network",
    userMessage,
    action: "retry",
  };
}

export function guardrailTripwireMessage(chunk: unknown): string {
  const payload =
    chunk && typeof chunk === "object"
      ? (chunk as { payload?: unknown }).payload
      : undefined;
  const reason =
    payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
      ? (payload as { reason: string }).reason.trim()
      : "";
  const processorId =
    payload && typeof payload === "object" && typeof (payload as { processorId?: unknown }).processorId === "string"
      ? (payload as { processorId: string }).processorId.trim()
      : "";
  const detail = reason || "模型输入/输出被安全护栏阻断";
  return processorId
    ? `安全护栏 ${processorId} 已阻断本轮请求：${detail}`
    : `安全护栏已阻断本轮请求：${detail}`;
}

export function isLikelyInternalTextDelta(text: string): boolean {
  return text.trim().length > 0 && sanitizeVisibleText(text) === null;
}

export function appendVisibleStreamErrorText(
  state: SessionState,
  agentMessageId: string,
  reason: string,
): BridgeFrame {
  const seq = nextSeq(state, agentMessageId);
  const textPart: MessagePart = { kind: "text", data: { body: reason } };
  appendPartToChatHistory(state, agentMessageId, textPart);
  return chatMessageAppended(agentMessageId, seq, textPart);
}

export function draftingFailedFrame(
  streamId: string,
  reason: string | StreamErrorDetails,
  retriable = true,
): BridgeFrame {
  const details =
    typeof reason === "string"
      ? { reason, retriable }
      : reason;
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId,
        reason: details.reason,
        retriable: details.retriable,
        ...("statusCode" in details && typeof details.statusCode === "number" ? { statusCode: details.statusCode } : {}),
        ...("category" in details ? { category: details.category } : {}),
        ...("userMessage" in details ? { userMessage: details.userMessage } : {}),
        ...("action" in details ? { action: details.action } : {}),
      },
    },
  };
}

export function turnRetryDelayMs(attempt: number): number {
  return Math.min(2_000, 400 * 2 ** attempt);
}

export function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
