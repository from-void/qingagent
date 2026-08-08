import { SpanType } from "@mastra/core/observability";
import { deriveSessionTraceId } from "../observability/innerLlmSpan.js";
import { mastra, getObservability } from "../mastra.js";
import type { SessionState } from "../session/sessionState.js";
import type { ModelCallSite } from "../llm/modelCallSites.js";
import { normalizeLlmUsageCounts } from "../llm/usageAccounting.js";
import { truncateLargeStrings } from "./redaction.js";

const logger = mastra.getLogger();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Derive a Mastra-tracing-compatible `traceId` from a backend value (currently
 * the sessionId; later a frontend-supplied clientTraceId).
 *
 * Mastra's `TracingOptions.traceId` must be 1-32 hex chars. Session ids are
 * UUIDs (`8-4-4-4-12` hex with dashes = 32 hex once dashes are stripped), so the
 * common case maps cleanly and every span for a session shares one trace. We
 * defensively strip any non-hex character and clamp to 32 chars so a
 * non-standard id can never produce an invalid traceId, and return `undefined`
 * when no usable hex remains so callers can omit `traceId` (Mastra then
 * auto-generates one) rather than passing an empty string.
 */
export function sessionIdToTraceId(sessionId: string): string | undefined {
  // 委托 observability 模块的同一实现,防 trace 关联算法双份漂移(prd-review 建议)。
  return deriveSessionTraceId(sessionId);
}

function parseRequestBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return body;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

export function buildLlmRequestSpanInput(requestBody: unknown): Record<string, unknown> {
  if (requestBody === undefined) return {};
  const parsed = parseRequestBody(requestBody);
  const parsedRecord = asRecord(parsed);
  if (parsedRecord) {
    const input: Record<string, unknown> = {};
    if ("messages" in parsedRecord) {
      input.messages = truncateLargeStrings(parsedRecord.messages);
    }
    if ("input" in parsedRecord) {
      input.input = truncateLargeStrings(parsedRecord.input);
    }
    if (Object.keys(input).length > 0) return input;
  }

  return { body: truncateLargeStrings(parsed) };
}

export function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeLlmUsage(usage: unknown): Record<string, unknown> | null {
  const usageRecord = asRecord(usage);
  if (!usageRecord) return null;
  const counts = normalizeLlmUsageCounts(usageRecord) ?? {};
  const { promptCacheHitTokens, promptCacheMissTokens } = counts;
  const promptCacheTotalTokens =
    promptCacheHitTokens != null || promptCacheMissTokens != null
      ? (promptCacheHitTokens ?? 0) + (promptCacheMissTokens ?? 0)
      : undefined;
  const promptCacheHitRate =
    promptCacheTotalTokens != null && promptCacheTotalTokens > 0
      ? (promptCacheHitTokens ?? 0) / promptCacheTotalTokens
      : undefined;
  const normalized = {
    ...usageRecord,
    ...counts,
    ...(promptCacheTotalTokens != null ? { promptCacheTotalTokens } : {}),
    ...(promptCacheHitRate != null ? { promptCacheHitRate } : {}),
  };
  return truncateLargeStrings(normalized) as Record<string, unknown>;
}

export function buildLlmStepResponseSpanEnd(payload: unknown): {
  attributes: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const payloadRecord = asRecord(payload);
  const outputRecord = asRecord(payloadRecord?.output);
  const stepResult = asRecord(payloadRecord?.stepResult);
  const text = outputRecord?.text;
  const usage = normalizeLlmUsage(outputRecord?.usage);
  const promptCacheHitRate = usage ? toNumber(usage.promptCacheHitRate) : undefined;
  const promptCacheTotalTokens = usage ? toNumber(usage.promptCacheTotalTokens) : undefined;
  if (promptCacheHitRate != null && promptCacheTotalTokens != null && promptCacheTotalTokens >= 1024 && promptCacheHitRate < 0.2) {
    logger.warn("Low prompt-cache hit rate observed", {
      promptCacheHitRate,
      promptCacheTotalTokens,
      promptCacheHitTokens: usage?.promptCacheHitTokens,
      promptCacheMissTokens: usage?.promptCacheMissTokens,
    });
  }
  const output: Record<string, unknown> = {
    text: typeof text === "string" ? truncateLargeStrings(text) : text ?? null,
    textLength: typeof text === "string" ? text.length : 0,
    toolCalls: truncateLargeStrings(outputRecord?.toolCalls ?? []),
    usage,
    finishReason: stepResult?.reason ?? null,
  };
  return {
    attributes: usage ? { usage } : {},
    output,
  };
}

/**
 * 挂起步的合成 llm_response end 载荷(纯函数,便于单测)。
 *
 * 模型吐完工具参数(tool-call chunk)那一刻,本次模型请求就已经"有响应"了;
 * 但 askUser 挂起的步永远等不到 step-finish,旧逻辑因此漏记
 * llm_response,日志台上该步显示"无耗时"。这里在 tool-call-suspended 返回前
 * 补记一条:finishReason="suspended",metadata.modelEndedAt 取最后一个模型
 * 输出 chunk 的时刻——不含工具执行耗时(askUser 出题可达数秒),是真实的
 * 模型延迟。
 */
export function buildLlmSuspendedResponseSpanEnd(fields: {
  toolName: string;
  toolCallId: string;
  modelEndedAt: string | null;
}): {
  metadata: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  return {
    metadata: {
      suspended: true,
      ...(fields.modelEndedAt ? { modelEndedAt: fields.modelEndedAt } : {}),
    },
    output: {
      text: null,
      textLength: 0,
      toolCalls: [],
      usage: null,
      finishReason: "suspended",
      suspendedToolName: fields.toolName,
      suspendedToolCallId: fields.toolCallId,
    },
  };
}

export interface LlmSpanMetadataFields {
  sessionId: string;
  clientTraceId?: string | null;
  streamId: string;
  runId: string;
  origin?: string | null;
  stepIndex?: number | null;
  messageId?: string | null;
  eventKind: "llm_request" | "llm_response";
  scope: "step" | "turn";
}

export function buildLlmSpanMetadata(fields: LlmSpanMetadataFields): Record<string, unknown> {
  return {
    sessionId: fields.sessionId,
    clientTraceId: fields.clientTraceId ?? null,
    streamId: fields.streamId,
    runId: fields.runId,
    origin: fields.origin ?? "manual",
    ...(fields.stepIndex != null ? { stepIndex: fields.stepIndex } : {}),
    messageId: fields.messageId ?? null,
    eventKind: fields.eventKind,
    scope: fields.scope,
  };
}

export function buildAgentTracingMetadata(
  state: Pick<SessionState, "sessionId" | "clientTraceId" | "origin">,
  streamId: string,
  runId: string | null | undefined,
  site: ModelCallSite,
): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    runId: runId ?? null,
    streamId,
    clientTraceId: state.clientTraceId ?? null,
    origin: state.origin ?? "manual",
    site,
  };
}

/**
 * 阶段2 — 记录模型 response 正文（Layer ③ 缺口补齐）。
 *
 * 在 agent 流正常结束、已聚合出完整回复文本时调用一次，写一条自定义
 * `SpanType.GENERIC`（name=`llm_response`）span，把完整正文放进该 span 的
 * `output.text`。这是框架自身永不记录的数据：@mastra/core 1.36.0 的
 * LLM_GENERATION span 的 output 被硬编码为
 * `{ usage, finishReason, providerMetadata, warnings }`（见
 * loop/index.js 的 `llmAISpan.end(...)`），即使纯文本回合也不含正文，且 Mastra
 * observability 配置里没有任何开关（无 recordOutput/captureIO/maxStringLength 等）
 * 能让它带上回复正文。
 *
 * 设计要点：
 * - 一次性记录：仅在流结束、拿到完整 `fullText` 时记一条 span，绝不逐
 *   text-delta 记录（那会制造 chunk 噪音，阶段1 已用 excludeSpanTypes 排除）。
 * - 关联：用阶段1 的 `sessionIdToTraceId(sessionId)` 作为本 span 的 `traceId`
 *   （`StartSpanOptions` 继承 `CreateSpanOptions.traceId`，与 runAgentTurn 给
 *   agent.stream 传的 `tracingOptions.traceId` 同源），使 llm_response 落进与本
 *   会话 model_generation/agent_run 同一条 trace，可按 trace 聚合查看完整一轮；
 *   同时保留 `metadata.sessionId`（阶段1 模式）以便按会话过滤。
 * - 大文本：出版长文可达几十 KB，按用户要求存"完整 response"，不截断。
 * - 永不影响主链路：observability 是旁路，整体 try/catch，失败只 warn。
 * - 空正文（纯工具调用回合）由调用方跳过，这里再防御一次。
 */
export function recordLlmResponseSpan(
  state: SessionState,
  streamId: string,
  runId: string,
  fullText: string,
): void {
  if (!fullText) return;
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;

    // Land this span in the SAME trace as the session's agent run, so the
    // console can show prompt (model_generation.input) and response
    // (llm_response.output) side-by-side in one trace. `StartSpanOptions`
    // extends `CreateSpanOptions`, which carries `traceId?: string` (1-32 hex,
    // used for root spans); we reuse the same `sessionIdToTraceId(sessionId)`
    // helper that stage-1's runAgentTurn passes as `tracingOptions.traceId` so
    // model_generation and llm_response share one traceId. Returns undefined
    // when the sessionId has no usable hex — then we omit it and Mastra
    // auto-generates one. `metadata.sessionId` is also kept (stage-1 pattern)
    // for session-level filtering.
    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "llm_response",
      ...(traceId ? { traceId } : {}),
      metadata: buildLlmSpanMetadata({
        sessionId: state.sessionId,
        clientTraceId: state.clientTraceId ?? null,
        streamId,
        runId,
        eventKind: "llm_response",
        origin: state.origin ?? "manual",
        scope: "turn",
      }),
    });
    span.end({
      output: {
        text: fullText,
        textLength: fullText.length,
      },
    });
  } catch (err) {
    logger.warn("recordLlmResponseSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      streamId,
    });
  }
}

function getChunkPayloadMessageId(payload: unknown): string | null {
  const payloadRecord = asRecord(payload);
  const messageId = payloadRecord?.messageId ?? payloadRecord?.id;
  return typeof messageId === "string" ? messageId : null;
}

export function recordLlmRequestSpan(
  state: SessionState,
  streamId: string,
  runId: string,
  stepIndex: number,
  payload: unknown,
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;

    const payloadRecord = asRecord(payload);
    const request = asRecord(payloadRecord?.request);
    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "llm_request",
      ...(traceId ? { traceId } : {}),
      metadata: buildLlmSpanMetadata({
        sessionId: state.sessionId,
        clientTraceId: state.clientTraceId ?? null,
        streamId,
        runId,
        origin: state.origin ?? "manual",
        stepIndex,
        messageId: getChunkPayloadMessageId(payload),
        eventKind: "llm_request",
        scope: "step",
      }),
      input: buildLlmRequestSpanInput(request?.body),
    });
    span.end({ output: { ok: true } });
  } catch (err) {
    logger.warn("recordLlmRequestSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      streamId,
      stepIndex,
    });
  }
}

export function recordLlmStepResponseSpan(
  state: SessionState,
  streamId: string,
  runId: string,
  stepIndex: number,
  payload: unknown,
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;

    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "llm_response",
      ...(traceId ? { traceId } : {}),
      metadata: buildLlmSpanMetadata({
        sessionId: state.sessionId,
        clientTraceId: state.clientTraceId ?? null,
        streamId,
        runId,
        origin: state.origin ?? "manual",
        stepIndex,
        messageId: getChunkPayloadMessageId(payload),
        eventKind: "llm_response",
        scope: "step",
      }),
    });
    span.end(buildLlmStepResponseSpanEnd(payload));
  } catch (err) {
    logger.warn("recordLlmStepResponseSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      streamId,
      stepIndex,
    });
  }
}

/**
 * 挂起步补记 llm_response span(见 buildLlmSuspendedResponseSpanEnd 注释)。
 * 与 recordLlmStepResponseSpan 同构,只是 end 载荷换成挂起语义。
 */
export function recordLlmSuspendedResponseSpan(
  state: SessionState,
  streamId: string,
  runId: string,
  stepIndex: number,
  fields: { toolName: string; toolCallId: string; modelEndedAt: string | null },
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;

    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "llm_response",
      ...(traceId ? { traceId } : {}),
      metadata: buildLlmSpanMetadata({
        sessionId: state.sessionId,
        clientTraceId: state.clientTraceId ?? null,
        streamId,
        runId,
        origin: state.origin ?? "manual",
        stepIndex,
        eventKind: "llm_response",
        scope: "step",
      }),
    });
    span.end(buildLlmSuspendedResponseSpanEnd(fields));
  } catch (err) {
    logger.warn("recordLlmSuspendedResponseSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      streamId,
      stepIndex,
    });
  }
}

/**
 * 0603 — 会话状态机转换 span 的 input 构造(纯函数,便于单测)。
 * transition 如 `enter_review`;只放计数/版本等小字段,绝不放文档正文。
 */
export interface StateChangeSpanFields {
  transition: string;
  hunkCount?: number;
  docVersion?: number;
}
export function buildStateChangeSpanInput(
  f: StateChangeSpanFields,
): Record<string, unknown> {
  return {
    transition: f.transition,
    hunkCount: f.hunkCount ?? 0,
    docVersion: f.docVersion ?? 0,
  };
}

export function buildStateChangeSpanMetadata(
  state: Pick<SessionState, "sessionId" | "clientTraceId" | "origin">,
  fields: Pick<StateChangeSpanFields, "transition">,
  ids: { streamId?: string | null; runId?: string | null } = {},
): Record<string, unknown> {
  return {
    eventKind: "state_change",
    transition: fields.transition,
    sessionId: state.sessionId,
    clientTraceId: state.clientTraceId ?? null,
    streamId: ids.streamId ?? null,
    runId: ids.runId ?? null,
    origin: state.origin ?? "manual",
  };
}

export type SettleResultBranch = "candidateDiff" | "wholeDocument" | "noop";

export interface SettleResultSpanFields {
  branch: SettleResultBranch;
  hunkCount: number;
  docWritten: boolean;
  finalVersion: number;
  sourceStreamId: string;
  runId?: string | null;
}

export function buildSettleResultSpanMetadata(
  state: Pick<SessionState, "sessionId" | "clientTraceId" | "origin">,
  fields: SettleResultSpanFields,
): Record<string, unknown> {
  return {
    eventKind: "settle_result",
    sessionId: state.sessionId,
    clientTraceId: state.clientTraceId ?? null,
    streamId: fields.sourceStreamId,
    runId: fields.runId ?? null,
    origin: state.origin ?? "manual",
    branch: fields.branch,
    hunkCount: fields.hunkCount,
    docWritten: fields.docWritten,
    finalVersion: fields.finalVersion,
    sourceStreamId: fields.sourceStreamId,
  };
}

export function recordSettleResultSpan(
  state: SessionState,
  fields: SettleResultSpanFields,
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = sessionIdToTraceId(state.sessionId);
    const metadata = buildSettleResultSpanMetadata(state, fields);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "settle_result",
      ...(traceId ? { traceId } : {}),
      metadata,
      input: {
        branch: fields.branch,
        hunkCount: fields.hunkCount,
        docWritten: fields.docWritten,
        finalVersion: fields.finalVersion,
      },
    });
    span.end({ output: { ok: true } });
  } catch (err) {
    logger.warn("recordSettleResultSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      streamId: fields.sourceStreamId,
      branch: fields.branch,
    });
  }
}

/**
 * 0603 — 记一条 `SpanType.GENERIC`(eventKind=`state_change`)会话状态机转换 span,
 * 补上之前缺失的"进入审批态"等生命周期事件可观测性。metadata.origin 从 SessionState 取,
 * traceId 与同会话 command/llm_response/db_write 同源。整段 try/catch,绝不影响主链路。
 */
export function recordStateChangeSpan(
  state: SessionState,
  fields: StateChangeSpanFields,
  ids: { streamId?: string | null; runId?: string | null } = {},
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: fields.transition,
      ...(traceId ? { traceId } : {}),
      metadata: buildStateChangeSpanMetadata(state, fields, ids),
      input: buildStateChangeSpanInput(fields),
    });
    span.end({ output: { ok: true } });
  } catch (err) {
    logger.warn("recordStateChangeSpan failed (non-fatal)", {
      error: String(err),
      sessionId: state.sessionId,
      transition: fields.transition,
    });
  }
}

/**
/** tool-error chunk 里的 error 字段统一抽成可读字符串。 */
export function stringifyToolError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return error == null ? "" : String(error);
}
