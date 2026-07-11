import type { Command, BridgeFrame, AskUserQuestion } from "@qingagent/contract-ts";
import { validateBridgeFrame } from "../../../system/validators";
import { visitorKeyHeaders } from "../../../overlays/settings/visitorKeyStore";
import type { AskUserAnswer, StreamError, WorkspaceLocalAction } from "./protocol";
import {
  genClientTraceId,
  logClientEvent,
  setClientLogSession,
} from "./clientLog";

/**
 * 从命令里尽力解析 sessionId（仅用于点击流埋点的关联，不影响请求逻辑）。
 */
function sessionIdOf(command: Command): string | undefined {
  const data = (command as { data?: { sessionId?: string } }).data;
  return data?.sessionId;
}

/**
 * 命令的非敏感摘要（点击流 meta 用）：只放长度/计数/枚举，不放正文，
 * 避免点击流里重复存用户消息正文（后端 command span 已有参数摘要）。
 */
function summarizeCommandForLog(command: Command): Record<string, unknown> {
  switch (command.kind) {
    case "sendMessage": {
      const d = command.data;
      return {
        textLength: d.text?.length ?? 0,
        mentions: d.mentions?.length ?? 0,
        skills: d.skills?.length ?? 0,
        chips: d.chips?.length ?? 0,
        fileIds: d.fileIds?.length ?? 0,
      };
    }
    case "acceptPatch":
    case "rejectPatch":
      return { patchId: command.data.id };
    case "commitPatches":
      return { count: command.data.ids?.length ?? 0 };
    case "updateDoc":
      return {
        sectionsCount: command.data.legacySections?.length ?? null,
        hasPmDoc: command.data.doc !== undefined,
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
      };
    case "startSession":
      return { mode: (command.data.mode as { kind?: string })?.kind };
    default:
      return {};
  }
}

interface LoggedBridgeFrame {
  seq: number;
  frame: BridgeFrame;
}

function streamErrorForHttpStatus(status: number): StreamError {
  if (status === 401 || status === 403) {
    return {
      kind: "draftingFailed",
      reason: "模型密钥无效或权限不足，请检查模型配置。",
      retriable: false,
      statusCode: status,
      category: "auth",
      userMessage: "模型密钥无效或权限不足，请检查模型配置。",
      action: "check_model_settings",
    };
  }
  if (status === 402) {
    return {
      kind: "draftingFailed",
      reason: "模型余额或调用额度不足，请检查模型设置或账户余额。",
      retriable: false,
      statusCode: status,
      category: "quota",
      userMessage: "模型余额或调用额度不足，请检查模型设置或账户余额。",
      action: "check_balance",
    };
  }
  if (status === 429) {
    return {
      kind: "draftingFailed",
      reason: "请求太频繁，请稍后重试。",
      retriable: true,
      statusCode: status,
      category: "rate_limit",
      userMessage: "请求太频繁，请稍后重试。",
      action: "retry",
    };
  }
  if (status >= 500) {
    return {
      kind: "draftingFailed",
      reason: "模型服务暂时不可用，请稍后重试。",
      retriable: true,
      statusCode: status,
      category: "upstream",
      userMessage: "模型服务暂时不可用，请稍后重试。",
      action: "retry",
    };
  }
  return {
    kind: "failed",
    reason: `请求失败：${status}`,
    retriable: false,
    statusCode: status,
    category: "unknown",
    userMessage: `请求失败：${status}`,
    action: "none",
  };
}

function summarizeCommitResponseBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "<empty>";
  const redacted = normalized
    .replace(/Bearer\s+[^\s<>"']+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(
      /(["']?(?:api[_-]?key|token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^"',<>\s]+/gi,
      "$1[redacted]",
    );
  return redacted.length > 180 ? `${redacted.slice(0, 180)}...` : redacted;
}

function jsonValueKind(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * 防御性读取 /commit 响应体(合并 dev 02a1238 的非 JSON 防御):代理/网关错误页是 HTML,
 * 直接 res.json() 会抛裸 SyntaxError。text→JSON.parse,失败给可读错误(脱敏截断)。
 */
async function parseCommitResponseArray(res: Response): Promise<unknown[]> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `commit failed: HTTP ${res.status} returned non-JSON response; body: ${summarizeCommitResponseBody(text)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `commit failed: HTTP ${res.status} returned JSON ${jsonValueKind(parsed)}, expected BridgeFrame array`,
    );
  }
  return parsed;
}

/**
 * Real server stream — sends `Command` objects to `POST /api/v1/stream`
 * and parses the SSE response, validating each frame with the wire
 * contract before emitting to subscribers.
 *
 * Replaces the Stage B mock `WorkspaceDocStream`. The subscriber
 * signature matches so the page's `useReducer(workspaceReducer, ...)`
 * wiring remains unchanged.
 */
export class ServerStream {
  private listeners = new Set<(frame: BridgeFrame) => void>();
  private waiters = new Set<{
    predicate: (frame: BridgeFrame) => boolean;
    resolve: (frame: BridgeFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Active abort controllers — one per in-flight command submit. */
  private activeControllers = new Set<AbortController>();
  private eventSource: EventSource | null = null;
  private activeSessionId: string | null = null;
  private lastSeq = 0;
  private epoch: number | null = null;
  private openStreamIds = new Set<string>();
  private readonly handleAuthChanged = () => {
    if (!this.activeSessionId) return;
    this.detach();
    this.connectEvents(this.activeSessionId, { resetCursor: false });
  };

  constructor(
    private readonly dispatchLocal?: (action: WorkspaceLocalAction) => void,
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("qa-auth-changed", this.handleAuthChanged);
    }
  }

  subscribe(listener: (frame: BridgeFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCommand(command: Command): Promise<unknown> {
    return this.sendCommandInternal(command);
  }

  /**
   * Start a new session and return the server-assigned sessionId.
   *
   * Unlike plain `sendCommand`, this watches the SSE response for the
   * `sessionMeta` frame and resolves with the `sessionId` it carries.
   * This avoids the race condition where `state.sessionId` is still
   * stale in the React closure when the next `sendMessage` fires.
   */
  async startSession(
    data: Extract<Command, { kind: "startSession" }>["data"],
  ): Promise<string> {
    return this.sendCommandInternal(
      { kind: "startSession", data },
      "sessionMeta",
    ) as Promise<string>;
  }

  private async sendCommandInternal(
    command: Command,
    /** When set, resolve with the sessionId from the first matching frame kind. */
    interceptKind?: "sessionMeta",
  ): Promise<string | unknown> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    // 阶段5a — 为本次用户动作生成 clientTraceId（32hex）并经 `x-client-trace-id`
    // 透传给后端（补全阶段4 协议的前端半边）。阶段5c — 自动记一条 client_event
    // 点击流（command 即用户意图，最低侵入），与后端 ②③④ span 同 clientTraceId 关联。
    const clientTraceId = genClientTraceId();
    const cmdSessionId = sessionIdOf(command);
    if (cmdSessionId) setClientLogSession(cmdSessionId);
    logClientEvent(command.kind, {
      clientTraceId,
      sessionId: cmdSessionId,
      meta: summarizeCommandForLog(command),
    });

    const docWritePromise =
      command.kind === "updateDoc"
        ? this.waitForFrame(
            (frame) =>
              frame.kind === "docWriteResult" &&
              frame.data.clientMutationId === command.data.clientMutationId,
            "updateDoc completed without receiving docWriteResult frame",
          )
        : null;

    try {
      if (cmdSessionId && command.kind !== "startSession") {
        this.connectEvents(cmdSessionId);
      }

      const response = await fetch("/api/v1/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-trace-id": clientTraceId,
          // F1 两层 key:visitor 层 key 随流式请求透传(无则不带该 header)
          ...visitorKeyHeaders(),
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.dispatchLocal?.({
          kind: "streamErrorSet",
          error: streamErrorForHttpStatus(response.status),
        });
        throw new Error(`Stream request failed: ${response.status}`);
      }

      const result = await response.json().catch(() => ({})) as {
        accepted?: boolean;
        sessionId?: string;
        epoch?: number;
      };

      if (command.kind === "startSession") {
        const sessionId =
          command.data.mode.kind === "existing"
            ? command.data.mode.data.id
            : result.sessionId;
        if (!sessionId) {
          throw new Error("startSession accepted without sessionId");
        }
        if (typeof result.epoch === "number") this.epoch = result.epoch;
        const sessionMetaPromise =
          interceptKind === "sessionMeta"
            ? this.waitForFrame(
                (frame) => frame.kind === "sessionMeta" && frame.data.sessionId === sessionId,
                "startSession completed without receiving sessionMeta frame",
              )
            : null;
        this.connectEvents(sessionId, { resetCursor: this.activeSessionId !== sessionId });
        if (sessionMetaPromise) {
          const frame = await sessionMetaPromise;
          if (frame.kind !== "sessionMeta") {
            throw new Error("startSession completed without receiving sessionMeta frame");
          }
          setClientLogSession(frame.data.sessionId);
          return frame.data.sessionId;
        }
      }

      if (docWritePromise) await docWritePromise;
      return result;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        this.rejectWaiter(docWritePromise);
        if (interceptKind) {
          throw new Error("startSession aborted before sessionMeta received");
        }
        return;
      }
      this.rejectWaiter(docWritePromise);
      throw e;
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  /**
   * Ask for more questions via LLM — plain REST call, not SSE.
   * Returns the generated follow-up questions array.
   */
  async askMore(
    sessionId: string,
    toolCallId: string,
    currentQuestions: Array<{
      id: string;
      label: string;
      kind: { kind: string };
      options: Array<{ value: string; label: string }>;
    }>,
    currentAnswers: Record<string, AskUserAnswer>,
    onProgress?: (questions: AskUserQuestion[]) => void,
  ): Promise<AskUserQuestion[]> {
    const response = await fetch("/api/v1/ask-more", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...visitorKeyHeaders() },
      body: JSON.stringify({ sessionId, toolCallId, currentQuestions, currentAnswers }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `ask-more failed: ${response.status}`,
      );
    }

    // Parse SSE stream for progressive question delivery
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let finalQuestions: AskUserQuestion[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const json = line.slice(6).trim();
          if (!json) continue;
          try {
            const parsed = JSON.parse(json) as { questions?: AskUserQuestion[]; error?: string };
            if (parsed.error) throw new Error(parsed.error);
            if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
              finalQuestions = parsed.questions;
              onProgress?.(parsed.questions);
            }
          } catch (e) {
            if (e instanceof Error && e.message !== json) throw e;
          }
        }
      }
    }

    return finalQuestions;
  }

  /**
   * Commit all patches via the non-streaming REST endpoint.
   *
   * The server accepts any "reviewing" patches and commits atomically,
   * returning collected BridgeFrame events as a JSON array. This avoids
   * the browser's HTTP/1.1 connection-limit issues that plague sequential
   * SSE requests during commit.
   */
  async commitAll(sessionId: string, patchIds: string[]): Promise<BridgeFrame[]> {
    // 阶段5c — commitAll 走独立 REST 端点（绕过 send），手动记一条点击流并透传 trace。
    const clientTraceId = genClientTraceId();
    setClientLogSession(sessionId);
    logClientEvent("commitAll", {
      clientTraceId,
      sessionId,
      meta: { count: patchIds.length },
    });
    this.connectEvents(sessionId);
    const res = await fetch("/api/v1/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-trace-id": clientTraceId,
      },
      body: JSON.stringify({ sessionId, patchIds }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `commit failed: ${res.status}`,
      );
    }

    const loggedFrames = await this.readLoggedCommitFrames(res);
    for (const { seq, frame } of loggedFrames) {
      this.emitLoggedFrame(seq, frame);
    }
    return loggedFrames.map((entry) => entry.frame);
  }

  async commitReviewGroups(
    sessionId: string,
    input: {
      acceptReviewBatchIds: string[];
      rejectReviewBatchIds?: string[];
      keepPendingReviewBatchIds?: string[];
    },
  ): Promise<BridgeFrame[]> {
    const clientTraceId = genClientTraceId();
    setClientLogSession(sessionId);
    logClientEvent("commitReviewGroups", {
      clientTraceId,
      sessionId,
      meta: {
        acceptCount: input.acceptReviewBatchIds.length,
        rejectCount: input.rejectReviewBatchIds?.length ?? 0,
        keepPendingCount: input.keepPendingReviewBatchIds?.length ?? 0,
      },
    });
    this.connectEvents(sessionId);
    const res = await fetch("/api/v1/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-trace-id": clientTraceId,
      },
      body: JSON.stringify({ sessionId, ...input }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error ?? `commit failed: ${res.status}`,
      );
    }

    const loggedFrames = await this.readLoggedCommitFrames(res);
    for (const { seq, frame } of loggedFrames) {
      this.emitLoggedFrame(seq, frame);
    }
    return loggedFrames.map((entry) => entry.frame);
  }

  stop(): void {
    this.dispatchStreamTerminated("stop");
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  async cancel(): Promise<void> {
    const streamIds = [...this.openStreamIds];
    if (streamIds.length === 0) return;
    this.dispatchStreamTerminated("stop", streamIds);
    await Promise.all(
      streamIds.map((streamId) =>
        this.sendCommand({ kind: "cancelStream", data: { streamId } }),
      ),
    );
  }

  detach(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("qa-auth-changed", this.handleAuthChanged);
    }
    this.detach();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("ServerStream disposed"));
    }
    this.waiters.clear();
    this.listeners.clear();
  }

  private emit(frame: BridgeFrame): void {
    if (frame.kind === "restoreReset") {
      this.epoch = frame.data.epoch;
    }
    if (frame.kind === "stream") {
      if (frame.data.kind === "start") {
        this.openStreamIds.add(frame.data.data.streamId);
      } else if (
        frame.data.kind === "end" ||
        frame.data.kind === "draftingFailed"
      ) {
        this.openStreamIds.delete(frame.data.data.streamId);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(frame);
    }
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private emitLoggedFrame(seq: number, frame: BridgeFrame): void {
    const normalizedSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : null;
    if (normalizedSeq === null) {
      this.emit(frame);
      return;
    }
    // restoreReset = 服务端 FrameLog 已重置(热重启/epoch 变更),seq 从头计。此时必须无条件
    // 接受并把去重游标回拨到该帧,否则:客户端 lastSeq 停在旧日志的大 seq,新日志的恢复帧
    // (seq 小)全部被下面的单调去重丢弃 → 页面从此收不到任何帧、永久静默
    // (真机复现:dev 热重载重启 server 后,发消息 server 正常跑完、UI 却零反应)。
    if (frame.kind === "restoreReset") {
      this.lastSeq = normalizedSeq;
      this.emit(frame);
      return;
    }
    if (normalizedSeq <= this.lastSeq) return;
    this.lastSeq = normalizedSeq;
    this.emit(frame);
  }

  private async readLoggedCommitFrames(res: Response): Promise<LoggedBridgeFrame[]> {
    // 非 JSON/非数组响应走 parseCommitResponseArray 的可读错误(合并 dev 02a1238 防御)。
    const loggedFrames = await parseCommitResponseArray(res);
    return loggedFrames.map((entry): LoggedBridgeFrame => {
      if (entry === null || typeof entry !== "object") {
        throw new Error("commit response entry must be an object");
      }
      const { seq, frame } = entry as { seq?: unknown; frame?: unknown };
      if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) {
        throw new Error("commit response entry seq must be a positive number");
      }
      const bridgeFrame = frame as BridgeFrame;
      validateBridgeFrame(bridgeFrame);
      return { seq: Math.floor(seq), frame: bridgeFrame };
    });
  }

  private connectEvents(
    sessionId: string,
    options: { resetCursor?: boolean } = {},
  ): void {
    if (this.eventSource && this.activeSessionId === sessionId) return;
    this.detach();
    if (this.activeSessionId !== sessionId || options.resetCursor) {
      this.lastSeq = 0;
      this.epoch = null;
      this.openStreamIds.clear();
    }
    this.activeSessionId = sessionId;

    const params = new URLSearchParams({
      sessionId,
      after: String(this.lastSeq),
    });
    if (this.epoch !== null) params.set("epoch", String(this.epoch));
    const source = new EventSource(`/api/v1/events?${params.toString()}`);
    source.addEventListener("frame", (event) => {
      const message = event as MessageEvent<string>;
      const seq = Number(message.lastEventId);
      const json = message.data;
      try {
        const frame: BridgeFrame = JSON.parse(json);
        validateBridgeFrame(frame);
        this.emitLoggedFrame(seq, frame);
      } catch (e) {
        console.error("[ServerStream] frame error", e, json);
      }
    });
    source.onerror = () => {
      // EventSource 会自动用 Last-Event-ID 重连；这里不把断线等同于停止生成。
    };
    this.eventSource = source;
  }

  private waitForFrame(
    predicate: (frame: BridgeFrame) => boolean,
    timeoutMessage: string,
    timeoutMs = 30_000,
  ): Promise<BridgeFrame> {
    return new Promise<BridgeFrame>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(timeoutMessage));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private rejectWaiter(promise: Promise<unknown> | null): void {
    if (!promise) return;
    // waiter 自身会在 dispose/timeout 清理；这里避免未 await 的 promise 产生未处理拒绝。
    promise.catch(() => undefined);
  }

  private dispatchStreamTerminated(
    reason: Extract<
      WorkspaceLocalAction,
      { kind: "streamTerminated" }
    >["reason"],
    streamIds?: string[],
  ): void {
    this.dispatchLocal?.({
      kind: "streamTerminated",
      reason,
      ...(streamIds ? { streamIds } : {}),
    });
  }
}
