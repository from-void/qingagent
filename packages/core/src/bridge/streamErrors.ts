import type { BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import type { SessionState } from "./sessionState.js";
import { appendPartToChatHistory, nextSeq } from "./sessionState.js";
import { chatMessageAppended } from "./frames.js";
import type { AgentStreamErrorEvent } from "./agentStreamEvents.js";

export const USER_ABORT_REASON = "user_abort";
export const IDLE_TIMEOUT_ABORT_REASON = "idle_timeout";

export function isUserAbortSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== IDLE_TIMEOUT_ABORT_REASON;
}

export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => void,
): AsyncGenerator<T | AgentStreamErrorEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let timedOut = false;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const next = iterator.next();
      const raced = await Promise.race([next, timeout]);
      if (timer) clearTimeout(timer);
      if (raced === "timeout") {
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
            error: new Error("agent stream idle timeout"),
          },
        };
        return;
      }
      if (raced.done) return;
      yield raced.value;
    }
  } finally {
    if (timedOut) {
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
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (
    /\bAI-IR\b/i.test(trimmed) ||
    /\bblock-[A-Za-z0-9_-]+\b/.test(trimmed) ||
    /\bnumericValue\b/.test(trimmed) ||
    /\[(?:tool-result|tool-call|askUserAnswers|internal|transcript)\]/i.test(trimmed)
  ) {
    return true;
  }
  if (/^(?:let me|let's|i need to|i should|i will|i'll|we need to|we should|now i|the user wants|need to)\b/i.test(trimmed)) {
    return true;
  }
  return /\b(?:different approach|tool result|tool call|system prompt|developer instruction)\b/i.test(trimmed);
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

export function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
