import type {
  AskUserQuestion,
  BridgeFrame,
  CancelConfirmedCommand,
  Command,
  CommandFailedResponse,
  ReviewType,
  SubmitConfirmDecision,
} from "@qingagent/contract-ts";
import { validateBridgeFrame } from "../../../system/validators";
import { visitorKeyHeaders } from "../../../overlays/settings/visitorKeyStore";
import type { AskUserAnswer, StreamError, WorkspaceLocalAction } from "./protocol";
import {
  genClientTraceId,
  logClientEvent,
  setClientLogSession,
} from "./clientLog";
import {
  RevisionedMutationCoordinator,
  askMoreMutationKey,
} from "./revisionedMutation";

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

export interface LoggedFrameObservability {
  frameSeq: number;
  frameBytes: number;
}

const loggedFrameObservability = new WeakMap<object, LoggedFrameObservability>();

export function loggedFrameObservabilityOf(
  frame: BridgeFrame,
): LoggedFrameObservability | null {
  return loggedFrameObservability.get(frame as object) ?? null;
}

function terminalDocumentFields(
  frame: BridgeFrame,
  frameSeq: number,
  frameBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength,
): (LoggedFrameObservability & {
  generationId: string;
  streamId: string | null;
  documentVersion: number;
  contentHash: string;
}) | null {
  if (
    frame.kind === "docGenerationEvent" &&
    frame.data.kind === "generation_finished"
  ) {
    return {
      frameSeq,
      frameBytes,
      generationId: frame.data.data.generationId,
      streamId: null,
      documentVersion: frame.data.data.finalVersion,
      contentHash: frame.data.data.contentHash,
    };
  }
  if (
    frame.kind === "stream" &&
    frame.data.kind === "end" &&
    frame.data.data.finalDocument
  ) {
    return {
      frameSeq,
      frameBytes,
      generationId: `terminal-${frame.data.data.streamId}`,
      streamId: frame.data.data.streamId,
      documentVersion: frame.data.data.finalDocument.version,
      contentHash: frame.data.data.finalDocument.contentHash,
    };
  }
  return null;
}

/** Web 比服务端 85 秒 deadline 多留 5 秒，用于接收失败帧和 422 响应。 */
const DRAFT_TEMPLATE_WAIT_TIMEOUT_MS = 90_000;

class CommandRequestError extends Error {
  readonly cancelAskUserServerFailure?: true;

  constructor(
    message: string,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
    commandKind: Command["kind"],
  ) {
    super(message);
    this.name = "CommandRequestError";
    if (commandKind === "cancelAskUser") {
      this.cancelAskUserServerFailure = true;
    }
  }
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

async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await response.json().catch(() => null) as {
    error?: string | { message?: unknown };
  } | null;
  return responseErrorBodyMessage(body, fallback);
}

function responseErrorBodyMessage(
  body: { error?: string | { message?: unknown } } | null,
  fallback: string,
): string {
  if (typeof body?.error === "string") return body.error;
  if (
    body?.error &&
    typeof body.error === "object" &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
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

/** 服务端 /events 心跳周期(stream.ts 每 15s 发一个 ping 帧)。 */
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;
/** 连续 3 个心跳周期收不到任何帧(含 ping)即判定连接半开。 */
export const STREAM_STALL_TIMEOUT_MS = 3 * STREAM_HEARTBEAT_INTERVAL_MS;
/** 看门狗轮询间隔:比心跳密,保证最坏 55s 内发现半开。 */
export const STREAM_WATCHDOG_INTERVAL_MS = 10_000;

/**
 * 半开连接判定(纯函数,便于单测):对端静默消失(沙箱网络/弱网/笔记本休眠唤醒)时
 * TCP 无 FIN/RST,EventSource 的 onerror 永不触发,只能靠"多久没收到帧"来判死。
 * lastActivityAt 非正数=还没建立过活动基线,不判定。
 */
export function isStreamStalled(
  nowMs: number,
  lastActivityAt: number,
  timeoutMs: number = STREAM_STALL_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs - lastActivityAt > timeoutMs;
}

interface FrameWaiter {
  predicate: (frame: BridgeFrame) => boolean;
  resolve: (frame: BridgeFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener: () => void;
  promise?: Promise<unknown>;
}

function frameWaiterAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Frame waiter cancelled");
  error.name = "AbortError";
  return error;
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
  private waiters = new Set<FrameWaiter>();
  private waiterByPromise = new WeakMap<
    Promise<unknown>,
    FrameWaiter
  >();
  /** Active abort controllers — one per in-flight command submit. */
  private activeControllers = new Set<AbortController>();
  private askMoreRequests = new Map<
    AbortController,
    {
      sessionId: string;
      reader: ReadableStreamDefaultReader<Uint8Array> | null;
    }
  >();
  private readonly requestMutations = new RevisionedMutationCoordinator();
  private eventSource: EventSource | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventProbeController: AbortController | null = null;
  private eventReconnectAttempt = 0;
  /** 最近一次收到任何 SSE 活动(open/frame/ping)的时间戳;0 = 无活跃连接。 */
  private lastStreamActivityAt = 0;
  private streamWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private activeSessionId: string | null = null;
  private lastSeq = 0;
  private epoch: number | null = null;
  private openStreamIds = new Set<string>();
  private readonly handleAuthChanged = () => {
    if (!this.activeSessionId) return;
    this.detach();
    this.connectEvents(this.activeSessionId, { resetCursor: false });
  };
  /**
   * 休眠唤醒/切回标签页兜底:后台标签的定时器会被浏览器降频到分钟级,
   * 看门狗轮询未必及时;回到前台立刻按同一阈值补判一次。
   */
  private readonly handleVisibilityChange = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    this.checkStreamLiveness();
  };

  constructor(
    private readonly dispatchLocal?: (action: WorkspaceLocalAction) => void,
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("qa-auth-changed", this.handleAuthChanged);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }

  subscribe(listener: (frame: BridgeFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCommand(command: Command, abortSignal?: AbortSignal): Promise<unknown> {
    return this.sendCommandInternal(command, undefined, abortSignal);
  }

  /** secret 专用上行：不经过 Command/client_event 摘要，也不读取或回显请求体。 */
  async resolveConfirm(
    submission: SubmitConfirmDecision,
    options: { activateSession?: boolean } = {},
  ): Promise<{
    accepted: true;
    remembered: boolean;
    grantState?: { present: boolean; grantId: string | null; version: number };
    rememberFailure?: "not-saved" | "settings-changed";
    /** 用户在卡上勾了「以后不用再问我」时,服务端回报开关是否真的存下来了。 */
    bypassEnabled?: boolean;
  }> {
    // 旧组件的决策仍必须送达原 session，但不得把当前共享 EventSource 拉回旧会话。
    if (options.activateSession !== false) this.connectEvents(submission.sessionId);
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const response = await fetch("/api/v1/confirms/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === "string" && body.error.trim()
            ? body.error
            : "确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。",
        );
      }
      const body = await response.json().catch(() => null) as {
        accepted?: unknown;
        remembered?: unknown;
        present?: unknown;
        grantId?: unknown;
        version?: unknown;
        rememberFailure?: unknown;
        bypassEnabled?: unknown;
      } | null;
      if (body?.accepted !== true || typeof body.remembered !== "boolean") {
        throw new Error("确认没有提交成功，命令尚未确定是否执行。请先查看命令卡，不要连续重复点击。");
      }
      const hasGrantState =
        typeof body.present === "boolean" &&
        (body.grantId === null || typeof body.grantId === "string") &&
        Number.isSafeInteger(body.version) &&
        Number(body.version) >= 0;
      const rememberFailure = body.rememberFailure === "not-saved" ||
        body.rememberFailure === "settings-changed"
        ? body.rememberFailure
        : undefined;
      return {
        accepted: true,
        remembered: body.remembered,
        ...(hasGrantState
          ? {
              grantState: {
                present: body.present as boolean,
                grantId: body.grantId as string | null,
                version: Number(body.version),
              },
            }
          : {}),
        ...(rememberFailure ? { rememberFailure } : {}),
        ...(typeof body.bypassEnabled === "boolean"
          ? { bypassEnabled: body.bypassEnabled }
          : {}),
      };
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  async cancelConfirmedCommand(input: CancelConfirmedCommand): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    try {
      const response = await fetch("/api/v1/confirms/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === "string" && body.error.trim()
            ? body.error
            : "停止失败，请再试一次。",
        );
      }
    } finally {
      this.activeControllers.delete(controller);
    }
  }

  async ignoreAnnotationGroups(
    sessionId: string,
    reason: Extract<Command, { kind: "ignoreAnnotationGroups" }>["data"]["reason"],
    options: Pick<Extract<Command, { kind: "ignoreAnnotationGroups" }>["data"], "groupIds" | "rememberDismissal"> = {},
  ): Promise<void> {
    const expectedIds = new Set(options.groupIds ?? []);
    const framePromise = this.waitForFrame(
      (frame) =>
        frame.kind === "annotationGroupsReady" &&
        (expectedIds.size === 0 ||
          [...expectedIds].every((id) =>
            frame.data.groups.some((group) => group.id === id && group.status === "ignored"),
          )),
      "ignoreAnnotationGroups completed without receiving authoritative annotationGroupsReady frame",
    );
    await this.sendCommandAndWaitFrame(
      {
        kind: "ignoreAnnotationGroups",
        data: { sessionId, reason, ...options },
      },
      framePromise,
    );
  }

  async updateMaterialSummary(
    sessionId: string,
    materialId: string,
    summary: string,
  ): Promise<void> {
    const framePromise = this.waitForFrame(
      (frame) =>
        frame.kind === "resourceUpdated" &&
        frame.data.resourceRef.domain.kind === "file" &&
        frame.data.resourceRef.id === materialId &&
        (frame.data.summary ?? "") === summary,
      "updateMaterialSummary completed without receiving authoritative resourceUpdated frame",
    );
    await this.sendCommandAndWaitFrame(
      {
        kind: "updateMaterialSummary",
        data: { sessionId, materialId, summary },
      },
      framePromise,
    );
  }

  async listLexicons(sessionId: string): Promise<Extract<BridgeFrame, { kind: "lexiconsListed" }>["data"]["lexicons"]> {
    const framePromise = this.waitForFrame(
      (frame) => frame.kind === "lexiconsListed",
      "listLexicons completed without receiving lexiconsListed frame",
    );
    const frame = await this.sendCommandAndWaitFrame(
      { kind: "listLexicons", data: { sessionId } },
      framePromise,
    );
    if (frame.kind !== "lexiconsListed") throw new Error("词库列表响应类型错误");
    return frame.data.lexicons;
  }

  async listLexiconEntries(sessionId: string, resourceId: string): Promise<Extract<BridgeFrame, { kind: "lexiconEntriesListed" }>["data"]["entries"]> {
    const framePromise = this.waitForFrame(
      (frame) => frame.kind === "lexiconEntriesListed" && frame.data.resourceId === resourceId,
      "listLexiconEntries completed without receiving lexiconEntriesListed frame",
    );
    const frame = await this.sendCommandAndWaitFrame(
      { kind: "listLexiconEntries", data: { sessionId, resourceId } },
      framePromise,
    );
    if (frame.kind !== "lexiconEntriesListed") throw new Error("词条列表响应类型错误");
    return frame.data.entries;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.sendCommand({ kind: "renameSession", data: { sessionId, title } });
  }

  async draftTemplate(
    data: Omit<Extract<Command, { kind: "draftTemplate" }>["data"], "requestId">,
    abortSignal?: AbortSignal,
  ): Promise<Extract<BridgeFrame, { kind: "templateDrafted" }>["data"]> {
    const requestId = crypto.randomUUID();
    const requestController = new AbortController();
    const framePromise = this.waitForFrame(
      (frame) => frame.kind === "templateDrafted" && frame.data.requestId === requestId,
      "draftTemplate completed without receiving templateDrafted frame",
      DRAFT_TEMPLATE_WAIT_TIMEOUT_MS,
      (timeoutError) => requestController.abort(timeoutError),
    );
    const requestSignal = abortSignal
      ? AbortSignal.any([abortSignal, requestController.signal])
      : requestController.signal;
    const frame = await this.sendCommandAndWaitFrame(
      { kind: "draftTemplate", data: { ...data, requestId } },
      framePromise,
      requestSignal,
    );
    if (frame.kind !== "templateDrafted") throw new Error("AI 起草响应类型错误");
    return frame.data;
  }

  private async derivativeFrame<K extends "derivativesListed" | "derivativeCreated" | "derivativeParamsUpdated" | "derivativeDeleted" | "derivativeDocLoaded" | "styleTemplatesListed" | "styleTemplateLoaded" | "styleTemplateSaved" | "styleTemplateDeleted" | "reviewTemplatesListed" | "reviewTemplateSaved" | "reviewTemplateDeleted" | "reviewTemplateSelected" | "reviewSupplementLoaded" | "reviewSupplementSaved">(
    command: Extract<Command, { kind: "listDerivatives" | "createDerivative" | "updateDerivativeParams" | "deleteDerivative" | "getDerivativeDoc" | "listStyleTemplates" | "getStyleTemplate" | "saveStyleTemplate" | "deleteStyleTemplate" | "listReviewTemplates" | "saveReviewTemplate" | "deleteReviewTemplate" | "selectReviewTemplate" | "getReviewSupplement" | "upsertReviewSupplement" }>,
    kind: K,
  ): Promise<Extract<BridgeFrame, { kind: K }>> {
    const framePromise = this.waitForFrame(
      (frame) => frame.kind === kind && frame.data.requestId === command.data.requestId,
      `${kind} response missing`,
    );
    return await this.sendCommandAndWaitFrame(command, framePromise) as Extract<BridgeFrame, { kind: K }>;
  }

  async listDerivatives(sessionId: string) {
    const frame = await this.derivativeFrame({ kind: "listDerivatives", data: { sessionId, requestId: crypto.randomUUID() } }, "derivativesListed");
    return frame.data.items;
  }

  async createDerivative(sessionId: string, dtype: "gzh" | "xhs" | "translate", templateId: string, privatePrompt: string, writingStyleId?: string, layoutStyleId?: string | null, targetLang?: string) {
    const frame = await this.derivativeFrame({ kind: "createDerivative", data: { sessionId, requestId: crypto.randomUUID(), dtype, templateId, writingStyleId, layoutStyleId, targetLang, privatePrompt } }, "derivativeCreated");
    return frame.data.item;
  }

  async generateTranslations(sessionId: string, docIds: string[]): Promise<void> {
    await this.sendCommand({ kind: "generateTranslations", data: { sessionId, docIds } });
  }

  async updateDerivativeCoverTemplate(sessionId: string, docId: string, coverTemplate: "poster" | "magazine" | "wenkai" | "impact" | "note") {
    const frame = await this.derivativeFrame({ kind: "updateDerivativeParams", data: { sessionId, requestId: crypto.randomUUID(), docId, coverTemplate } }, "derivativeParamsUpdated");
    return frame.data.item;
  }

  async listStyleTemplates(sessionId: string, dtype: string, slot?: "layout" | "writing" | "instruction") {
    const frame = await this.derivativeFrame({ kind: "listStyleTemplates", data: { sessionId, requestId: crypto.randomUUID(), dtype, slot } }, "styleTemplatesListed");
    return frame.data.items;
  }

  async getStyleTemplate(sessionId: string, id: string) {
    const frame = await this.derivativeFrame({ kind: "getStyleTemplate", data: { sessionId, requestId: crypto.randomUUID(), id } }, "styleTemplateLoaded");
    return frame.data.item;
  }

  async saveStyleTemplate(sessionId: string, input: { id?: string; dtype: string; slot: "layout" | "writing" | "instruction"; name: string; detail?: string; prompt: string }) {
    const frame = await this.derivativeFrame({ kind: "saveStyleTemplate", data: { sessionId, requestId: crypto.randomUUID(), ...input } }, "styleTemplateSaved");
    return frame.data.item;
  }

  async deleteStyleTemplate(sessionId: string, id: string) {
    const frame = await this.derivativeFrame({ kind: "deleteStyleTemplate", data: { sessionId, requestId: crypto.randomUUID(), id } }, "styleTemplateDeleted");
    if (frame.data.error) throw new Error(frame.data.error);
  }

  async listReviewTemplates(sessionId: string, type: ReviewType) {
    const frame = await this.derivativeFrame({ kind: "listReviewTemplates", data: { sessionId, requestId: crypto.randomUUID(), type } }, "reviewTemplatesListed");
    return frame.data;
  }

  async saveReviewTemplate(sessionId: string, input: { id?: string; type: ReviewType; name: string; prompt: string }) {
    const frame = await this.derivativeFrame({ kind: "saveReviewTemplate", data: { sessionId, requestId: crypto.randomUUID(), ...input } }, "reviewTemplateSaved");
    return frame.data.item;
  }

  async deleteReviewTemplate(sessionId: string, id: string) {
    const frame = await this.derivativeFrame({ kind: "deleteReviewTemplate", data: { sessionId, requestId: crypto.randomUUID(), id } }, "reviewTemplateDeleted");
    if (frame.data.error) throw new Error(frame.data.error);
    return frame.data.selectedTemplateId;
  }

  async selectReviewTemplate(sessionId: string, type: ReviewType, templateId: string) {
    await this.derivativeFrame({ kind: "selectReviewTemplate", data: { sessionId, requestId: crypto.randomUUID(), type, templateId } }, "reviewTemplateSelected");
  }

  async getReviewSupplement(sessionId: string, type: ReviewType) {
    const frame = await this.derivativeFrame({ kind: "getReviewSupplement", data: { sessionId, requestId: crypto.randomUUID(), type } }, "reviewSupplementLoaded");
    return frame.data.supplement;
  }

  async upsertReviewSupplement(sessionId: string, type: ReviewType, supplement: string) {
    const frame = await this.derivativeFrame({ kind: "upsertReviewSupplement", data: { sessionId, requestId: crypto.randomUUID(), type, supplement } }, "reviewSupplementSaved");
    return frame.data.supplement;
  }

  async deleteDerivative(sessionId: string, docId: string) {
    await this.derivativeFrame({ kind: "deleteDerivative", data: { sessionId, requestId: crypto.randomUUID(), docId } }, "derivativeDeleted");
  }

  async getDerivativeDoc(sessionId: string, docId: string) {
    const frame = await this.derivativeFrame({ kind: "getDerivativeDoc", data: { sessionId, requestId: crypto.randomUUID(), docId } }, "derivativeDocLoaded");
    return frame.data;
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

  private async sendCommandAndWaitFrame(
    command: Command,
    framePromise: Promise<BridgeFrame>,
    abortSignal?: AbortSignal,
  ): Promise<BridgeFrame> {
    try {
      const [, frame] = await Promise.all([
        this.sendCommandInternal(command, undefined, abortSignal),
        framePromise,
      ]);
      return frame;
    } catch (error) {
      const waiterError = error instanceof Error
        ? error
        : new Error(String(error));
      // HTTP 失败与对应帧 waiter 使用同一个错误结算，避免留下 30 秒幽灵等待。
      this.rejectWaiter(framePromise, waiterError);
      throw error;
    }
  }

  private async sendCommandInternal(
    command: Command,
    /** When set, resolve with the sessionId from the first matching frame kind. */
    interceptKind?: "sessionMeta",
    abortSignal?: AbortSignal,
  ): Promise<string | unknown> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const abortFromCaller = () => controller.abort(abortSignal?.reason);
    if (abortSignal?.aborted) abortFromCaller();
    else abortSignal?.addEventListener("abort", abortFromCaller, { once: true });

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
        const body = await response.json().catch(() => null) as (
          Partial<CommandFailedResponse> & {
            error?: string | { code?: unknown; message?: unknown };
          }
        ) | null;
        const message = responseErrorBodyMessage(
          body,
          `Stream request failed: ${response.status}`,
        );
        const code = body?.error &&
            typeof body.error === "object" &&
            typeof body.error.code === "string"
          ? body.error.code
          : undefined;
        const requestId = typeof body?.requestId === "string"
          ? body.requestId
          : undefined;
        this.dispatchLocal?.({
          kind: "streamErrorSet",
          error: response.status === 409 || response.status === 410
            ? {
                kind: "failed",
                reason: message,
                retriable: false,
                statusCode: response.status,
                category: "unknown",
                userMessage: message,
                action: "none",
              }
            : streamErrorForHttpStatus(response.status),
        });
        throw new CommandRequestError(
          message,
          code,
          requestId,
          command.kind,
        );
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
        this.rejectWaiter(docWritePromise, e);
        if (abortSignal) throw e;
        if (interceptKind) {
          throw new Error("startSession aborted before sessionMeta received");
        }
        return;
      }
      this.rejectWaiter(
        docWritePromise,
        e instanceof Error ? e : new Error(String(e)),
      );
      throw e;
    } finally {
      abortSignal?.removeEventListener("abort", abortFromCaller);
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
    return this.requestMutations.run(
      askMoreMutationKey(sessionId, toolCallId),
      async () => {
        const controller = new AbortController();
        const request = { sessionId, reader: null as ReadableStreamDefaultReader<Uint8Array> | null };
        this.activeControllers.add(controller);
        this.askMoreRequests.set(controller, request);
        try {
          const response = await fetch("/api/v1/ask-more", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...visitorKeyHeaders() },
            body: JSON.stringify({ sessionId, toolCallId, currentQuestions, currentAnswers }),
            signal: controller.signal,
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
          request.reader = reader;

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

          if (controller.signal.aborted) {
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new DOMException("ask-more cancelled", "AbortError");
          }
          return finalQuestions;
        } finally {
          const reader = request.reader;
          request.reader = null;
          if (reader) await reader.cancel().catch(() => undefined);
          this.askMoreRequests.delete(controller);
          this.activeControllers.delete(controller);
        }
      },
    );
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
      throw new Error(await responseErrorMessage(res, `commit failed: ${res.status}`));
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
      throw new Error(await responseErrorMessage(res, `commit failed: ${res.status}`));
    }

    const loggedFrames = await this.readLoggedCommitFrames(res);
    for (const { seq, frame } of loggedFrames) {
      this.emitLoggedFrame(seq, frame);
    }
    return loggedFrames.map((entry) => entry.frame);
  }

  stop(): void {
    this.dispatchStreamTerminated("stop");
    this.abortAskMoreRequests();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  async cancel(
    commands?: readonly Extract<Command, { kind: "cancelStream" }>[],
  ): Promise<void> {
    const resolvedCommands = commands?.length
      ? [...commands]
      : [...this.openStreamIds].map(
          (streamId): Extract<Command, { kind: "cancelStream" }> => ({
            kind: "cancelStream",
            data: { streamId },
          }),
        );
    if (resolvedCommands.length === 0) return;

    const streamIds = [
      ...new Set(
        resolvedCommands.flatMap((command) =>
          command.data.streamId ? [command.data.streamId] : [],
        ),
      ),
    ];
    this.dispatchStreamTerminated(
      "stop",
      streamIds.length > 0 ? streamIds : undefined,
    );
    for (const streamId of streamIds) this.openStreamIds.delete(streamId);
    await Promise.all(
      resolvedCommands.map((command) => this.sendCommand(command)),
    );
  }

  detach(): void {
    this.stopStreamWatchdog();
    if (this.eventReconnectTimer) clearTimeout(this.eventReconnectTimer);
    this.eventReconnectTimer = null;
    this.eventProbeController?.abort();
    this.eventProbeController = null;
    this.eventReconnectAttempt = 0;
    this.eventSource?.close();
    this.eventSource = null;
  }

  dispose(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("qa-auth-changed", this.handleAuthChanged);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.detach();
    this.abortAskMoreRequests();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(new Error("ServerStream disposed"));
    }
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
      this.removeWaiter(waiter);
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
      this.reconnectAfterRestoreReset();
      return;
    }
    if (normalizedSeq <= this.lastSeq) return;
    this.lastSeq = normalizedSeq;
    const terminalFields = terminalDocumentFields(frame, normalizedSeq);
    if (terminalFields) {
      loggedFrameObservability.set(frame as object, terminalFields);
      console.info("[terminal-document] validated", {
        stage: "validated",
        sessionId: this.activeSessionId,
        ...terminalFields,
      });
    }
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
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      this.abortAskMoreRequests(this.activeSessionId);
    }
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
    this.openEventSource(sessionId, params);
  }

  private openEventSource(sessionId: string, params?: URLSearchParams): void {
    const query = params ?? (() => {
      const next = new URLSearchParams({ sessionId, after: String(this.lastSeq) });
      if (this.epoch !== null) next.set("epoch", String(this.epoch));
      return next;
    })();
    const url = `/api/v1/events?${query.toString()}`;
    const source = new EventSource(url);
    source.addEventListener("open", () => {
      if (this.eventSource !== source) return;
      this.eventReconnectAttempt = 0;
      this.markStreamActivity(source);
    });
    // 服务端 15s 一个 ping:它是半开检测唯一的常态信号,必须显式监听刷新活动时间。
    source.addEventListener("ping", () => {
      this.markStreamActivity(source);
    });
    source.addEventListener("frame", (event) => {
      this.markStreamActivity(source);
      const message = event as MessageEvent<string>;
      const seq = Number(message.lastEventId);
      const json = message.data;
      try {
        const frame: BridgeFrame = JSON.parse(json);
        const terminalFields = terminalDocumentFields(
          frame,
          Number.isFinite(seq) ? Math.floor(seq) : 0,
          new TextEncoder().encode(json).byteLength,
        );
        if (terminalFields) {
          console.info("[terminal-document] received", {
            stage: "received",
            sessionId,
            ...terminalFields,
          });
        }
        validateBridgeFrame(frame);
        this.emitLoggedFrame(seq, frame);
      } catch (e) {
        console.error("[ServerStream] frame error", e, json);
      }
    });
    source.onerror = () => {
      if (this.eventSource !== source) return;
      source.close();
      this.eventSource = null;
      void this.scheduleEventReconnect(sessionId);
    };
    this.eventSource = source;
    this.startStreamWatchdog();
  }

  /** 任何 SSE 活动(open/frame/ping)都刷新看门狗基线;陈旧连接的事件不算数。 */
  private markStreamActivity(source: EventSource): void {
    if (this.eventSource !== source) return;
    this.lastStreamActivityAt = Date.now();
  }

  /** 看门狗只在有活跃会话+活跃连接时起转;重复调用不会叠加 timer。 */
  private startStreamWatchdog(): void {
    this.lastStreamActivityAt = Date.now();
    if (this.streamWatchdogTimer) return;
    this.streamWatchdogTimer = setInterval(() => {
      this.checkStreamLiveness();
    }, STREAM_WATCHDOG_INTERVAL_MS);
  }

  private stopStreamWatchdog(): void {
    if (this.streamWatchdogTimer) clearInterval(this.streamWatchdogTimer);
    this.streamWatchdogTimer = null;
    this.lastStreamActivityAt = 0;
  }

  /**
   * 半开连接兜底:超过 3 个心跳周期没有任何帧就主动断开,复用既有 onerror 的重连通道
   * (/health 探活 + 指数退避 + after=lastSeq 续传;有 gap/epoch 变更时服务端会补发
   * restoreReset + 权威快照)。重连排程期间 eventSource 为 null,不会重复判定。
   */
  private checkStreamLiveness(): void {
    const sessionId = this.activeSessionId;
    const source = this.eventSource;
    if (!sessionId || !source) return;
    if (!isStreamStalled(Date.now(), this.lastStreamActivityAt)) return;
    this.lastStreamActivityAt = 0;
    source.close();
    this.eventSource = null;
    void this.scheduleEventReconnect(sessionId);
  }

  private reconnectAfterRestoreReset(): void {
    const sessionId = this.activeSessionId;
    if (!sessionId || !this.eventSource) return;
    this.eventSource.close();
    this.eventSource = null;
    this.openEventSource(sessionId);
  }

  private abortAskMoreRequests(sessionId?: string): void {
    for (const [controller, request] of this.askMoreRequests) {
      if (sessionId && request.sessionId !== sessionId) continue;
      controller.abort(new DOMException("ask-more cancelled", "AbortError"));
      void request.reader?.cancel().catch(() => undefined);
    }
  }

  private async scheduleEventReconnect(sessionId: string): Promise<void> {
    if (this.activeSessionId !== sessionId || this.eventReconnectTimer) return;
    this.eventReconnectAttempt += 1;
    const probe = new AbortController();
    this.eventProbeController?.abort();
    this.eventProbeController = probe;
    try {
      await fetch("/health", {
        method: "HEAD",
        signal: AbortSignal.any([
          probe.signal,
          AbortSignal.timeout(3_000),
        ]),
      });
    } catch {
      // 断网时探测也会失败；仍按应用级指数退避重连。
    } finally {
      if (this.eventProbeController === probe) this.eventProbeController = null;
    }
    if (probe.signal.aborted || this.activeSessionId !== sessionId) return;
    const exponentialMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.eventReconnectAttempt - 1, 5));
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      if (this.activeSessionId === sessionId && !this.eventSource) {
        this.openEventSource(sessionId);
      }
    }, exponentialMs);
  }

  waitForFrame(
    predicate: (frame: BridgeFrame) => boolean,
    timeoutMessage: string,
    timeoutMs = 30_000,
    onTimeout?: (error: Error) => void,
    abortSignal?: AbortSignal,
  ): Promise<BridgeFrame> {
    let waiter: FrameWaiter;
    const promise = new Promise<BridgeFrame>((resolve, reject) => {
      const abortListener = () => {
        this.removeWaiter(waiter);
        reject(frameWaiterAbortError(abortSignal));
      };
      waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          const error = new Error(timeoutMessage);
          reject(error);
          onTimeout?.(error);
        }, timeoutMs),
        abortSignal,
        abortListener,
      };
      if (abortSignal?.aborted) {
        clearTimeout(waiter.timer);
        reject(frameWaiterAbortError(abortSignal));
        return;
      }
      abortSignal?.addEventListener("abort", abortListener, { once: true });
      this.waiters.add(waiter);
    });
    waiter!.promise = promise;
    if (this.waiters.has(waiter!)) {
      this.waiterByPromise.set(promise, waiter!);
    }
    return promise;
  }

  private removeWaiter(waiter: FrameWaiter): void {
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.abortSignal?.removeEventListener("abort", waiter.abortListener);
    if (waiter.promise) this.waiterByPromise.delete(waiter.promise);
  }

  private rejectWaiter(
    promise: Promise<unknown> | null,
    error = new Error("Frame waiter cancelled"),
  ): void {
    if (!promise) return;
    const waiter = this.waiterByPromise.get(promise);
    if (waiter) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
    // 命令原始错误由调用方抛出；内部 waiter 的取消拒绝只负责及时清理。
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
