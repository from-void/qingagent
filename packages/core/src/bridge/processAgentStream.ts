import type {
  AskUserSliderSpec,
  BridgeFrame,
  DocState,
  MessagePart,
  ResearchCardBody,
  ToolCallSpec,
  ToolCallStatus,
  WriteDraftCardBody,
} from "@qingagent/contract-ts";
import { todosSchema } from "@qingagent/contract-ts/schemas";
import { RequestContext } from "@mastra/core/request-context";
import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pmToPlainText } from "@qingagent/pm-schema";
import { isSubstantiveContent } from "../browser/contentQuality.js";
import { downloadRemoteImage, thumbnailSrcForImageInput } from "../tools/imageInput.js";
import { resolveDeepseekAuth, DEEPSEEK_MODEL_IDS } from "../llm/modelConfig.js";
import { recordUsageEvent } from "../db/usageRepo.js";
import { documentDraftRepo } from "../db/documentDraftRepo.js";
import { mastra } from "../mastra.js";
import type { Material } from "../types/material.js";
import { extractLoadedToolNamesFromToolSearchResult } from "../agents/toolSearch.js";
import { guardContext } from "../llm/prefixCacheGuard.js";
import type { SessionState } from "./sessionState.js";
import {
  appendPartToChatHistory,
  clearSuspension,
  hasActiveSuspension,
  nextSeq,
  recordSuspension,
  terminalizeAskUserToolCall,
  updateToolCallInChatHistory,
} from "./sessionState.js";
import {
  UPLOADS_BASE,
  resolveFileIds,
  type ResolvedUploadedFile,
} from "./uploadFileResolver.js";
import {
  parseFileFailureFromResult,
  upsertMaterialByFileId,
  type MaterialParseFailure,
} from "./materialResource.js";
import { schedulePersist } from "./threadPersistence.js";
import {
  appendAskUserAnswerMessageIfMissing,
  findAskUserToolCallSpecInChatHistory,
  normalizeAskUserAnswers,
} from "./askUserAnswerMessage.js";
import {
  idleDocState,
  normalizeTargetDocState,
} from "./docStateTransitions.js";
import {
  AGENT_IDLE_TIMEOUT_MS,
  AGENT_MAX_STEPS,
  MAX_CONSECUTIVE_ASKUSER_SUSPENDS,
} from "./agentLimits.js";
import {
  appendToolTranscriptMessage,
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  newId,
  resourceUpdated,
  resourceUpserted,
  toolCallUpdated,
} from "./frames.js";
import {
  isRecord,
  redactedSerializedText,
  redactedToolResultPreview,
  toolResultCardSummary,
} from "./redaction.js";
import {
  normalizeLlmUsage,
  recordLlmRequestSpan,
  recordLlmResponseSpan,
  recordLlmStepResponseSpan,
  recordLlmSuspendedResponseSpan,
  stringifyToolError,
  toNumber,
} from "./agentSpans.js";
import {
  buildToolIoEndMetadata,
  endToolIoSpan,
  markToolIoSpanSuspended,
  startToolIoSpan,
} from "./toolIoSpans.js";
import { asDocGenerationEvent } from "./docGenerationEvents.js";
import {
  DRAFT_MUTATION_TOOL_NAMES,
  DRAFT_TOOL_JSON_RETRY_NOTICE,
  draftMutationFailureReason,
  hasUsableDraftMutationArgs,
  normalizeToolCallArgs,
} from "./draftToolArgs.js";
import {
  type AskUserPurposeKind,
  PURE_UI_TOOL_NAMES,
  askUserPurposeFromSpec,
  askUserRenderModeFromSpec,
  buildAskUserToolCallSpec,
  commandCardFromResult,
  commandCardStatusFromCard,
  decideAskUserRenderMode,
  generateSvgProgressFromResult,
  generateSvgToolCallSpec,
  latestGenerateSvgProgress,
  normalizeGenerateSvgProgress,
  qrCardToolCallSpec,
  readImageToolCallSpec,
  researchCardToolCallSpec,
  scriptCardFromResult,
  writeDraftCardFromResult,
} from "./toolCards.js";
import {
  clearDraftConfirmationState,
  currentDraftMutationStats,
  saveDraftCandidateCheckpoint,
} from "./draftScratch.js";
import {
  restoreDocStateAfterGenerateSvg,
  syncContentAndProjectDocState,
  transitionAndProjectDocState,
} from "./docStateSync.js";
import {
  isExtractionFailureText,
  missingGenericToolResultFields,
  toSuspensionToolName,
} from "./sessionTools.js";
import { settleDraftCandidate } from "./settleDraftCandidate.js";
import {
  appendVisibleStreamErrorText,
  draftingFailedFrame,
  IDLE_TIMEOUT_ABORT_REASON,
  guardrailTripwireMessage,
  isIdleTimeoutChunk,
  isLikelyInternalTextDelta,
  isTransientStreamErrorChunk,
  isUserAbortSignal,
  streamErrorDetails,
  withIdleTimeout,
} from "./streamErrors.js";

const logger = mastra.getLogger();
const SESSION_STATE_TOOL_NAMES = new Set(["updateTodos"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// processAgentStream — shared stream processor for initial and resumed streams
// ---------------------------------------------------------------------------

export interface ProcessAgentStreamOptions {
  state: SessionState;
  agentMessageId: string;
  streamId: string;
  runId: string;
  userText?: string;
  /** Upload fileIds from the current turn, used to link materials to their source files. */
  fileIds?: string[];
  requestContext?: RequestContext;
  idleTimeoutMs?: number;
  abortController?: AbortController;
}

export interface ProcessOutcome {
  producedVisibleFrame: boolean;
  sawToolCall: boolean;
  streamWasUserAborted: boolean;
  /**
   * 诊断 p04:重试守卫只看 sawToolCall 会把"问卷恢复流"误判为已产生副作用——
   * resume 时 Mastra 会重放 askUser 的 tool-call/result chunk,瞬断后本可安全
   * 重试却被挡下,用户在问卷确认后看到"生成失败,请重试"。本字段只在出现
   * askUser 之外的(真副作用)工具活动时置真,作为重试守卫的判定依据。
   */
  sawSideEffectToolCall: boolean;
  transientErrorChunk?: unknown;
}

/**
 * Process a Mastra agent fullStream, emitting BridgeFrame frames for each chunk.
 * Used by both `runAgentTurn` (initial stream) and bridgeHandler (resumed stream).
 *
 * Returns an object indicating whether the stream was suspended.
 */
export async function* processAgentStream(
  fullStream: AsyncIterable<any>,
  opts: ProcessAgentStreamOptions,
): AsyncGenerator<BridgeFrame, ProcessOutcome> {
  const { state, agentMessageId, streamId, runId, userText = "", fileIds: turnFileIds, requestContext } = opts;
  const abortController = opts.abortController ?? new AbortController();
  const outcome: ProcessOutcome = {
    producedVisibleFrame: false,
    sawToolCall: false,
    sawSideEffectToolCall: false,
    streamWasUserAborted: false,
  };
  const previousStreamId = state.streamId;
  const restoreStreamIdOnExit = previousStreamId === null;
  if (restoreStreamIdOnExit) {
    state.streamId = streamId;
  }
  try {
  const streamStartTime = Date.now();

  let accumulatedText = "";
  let reasoningId: string | null = null;
  const materialFrames: BridgeFrame[] = [];
  // 素材正文引用缓存(会话级,跨轮存活):parseFile 按 filename 建键,抓取类按 url+title 建键,
  // 供 storeMaterial 落库时按键精确绑定——绕过"agent 把几万字全文复制进参数"的不可靠瓶颈。
  // 旧实现是单槽"最近一次提取",多源场景被层层覆盖→几份素材正文全是最后一份(p08 串台);
  // 现在只有本轮恰好一次提取时才允许"最近一次"兜底,多次提取时宁可空正文也绝不绑错。
  const extractedTexts = (state._extractedTexts ??= new Map<
    string,
    { text: string; sourceUrl: string | null; fileId: string | null }
  >());
  const extractionEventsThisTurn: Array<{ text: string; sourceUrl: string | null; fileId: string | null }> = [];
  // 已被某次 storeMaterial 消费的提取:每条提取只绑一次,避免多条素材绑到同一份正文(p08 串台),
  // 同时让多条抓取结果按顺序各自落库可见,而非多次提取时一律 fail-closed 拒绝。
  const consumedExtractions = new Set<{ text: string; sourceUrl: string | null; fileId: string | null }>();
  let validPatchCount = 0;
  // Flags: docGeneratedThisTurn gates natural-settle generation playback after
  // writeDraft. docJustGenerated/docExistedBeforeStream are retained for
  // the older first-generation marker and diagnostics.
  let docJustGenerated = false;
  let docGeneratedThisTurn = false;
  // 兜底信号:某些 v3 stream(如 GLM via anthropic)可能不发 tool-result chunk,
  // 导致 docGeneratedThisTurn 没置 → settle 不落盘。用"writeDraft 流式产出过"补位。
  let sawWriteDraftProgress = false;
  let sawValidDraftMutation = false;
  let sawFailedDraftMutationInput = false;
  let finalDocumentSnapshotEmitted = false;
  let activeDocGenerationToolCallId: string | null = null;
  let activeDocGenerationId: string | null = null;
  let activeDocGenerationLastSeq = 0;
  let activeDocGenerationFailedEventSeen = false;
  let settledDocGenerationId: string | null = null;
  let settledDocGenerationLastSeq = 0;

  // Snapshot: did the document exist before this stream started?
  // Used to guard docJustGenerated — auto-commit only on first generation.
  const docExistedBeforeStream = state.legacySections.length > 0;

  // Track whether this stream was suspended via tool-call-suspended.
  // Used as a safety net: if the stream somehow completes normally after
  // a suspension (e.g. ReadableStream iterator cleanup race), we must NOT
  // clear state.runId because the session is waiting for a resume.
  let wasSuspended = false;

  // Guard against duplicate askUser tool calls in the same stream.
  // Mastra's multi-step loop (maxSteps: 10) can fire a second askUser
  // before the first suspend chunk is processed.
  let seenAskUser = false;
  let askUserProgressEmitted = false;
  let askUserProgressToolCallId: string | null = null;
  // readImage 流式进度:记住每个 readImage 调用的 args/缩略图,进度刷新时重建卡片(保留缩略图)。
  const readImageMeta = new Map<string, { args: Record<string, unknown>; thumbnailSrc: string | null }>();
  // generateSvg 流式进度:tool-output 只带阶段/耗时/KB,这里保留入参用于重建同一张工具卡。
  const generateSvgMeta = new Map<string, { args: Record<string, unknown> }>();
  // tool-result 事件有时只回传部分 args；副作用绑定必须能回看原始 tool-call 参数。
  const toolCallArgsById = new Map<string, Record<string, unknown>>();
  // askUser 渲染形态由代码在 tool-call 时（_askUserCompleted 置真之前）决定，
  // 供占位/进度/最终三处 spec 复用，避免大表单→浮层的闪烁。
  let askUserRenderMode: "fullpage" | "overlay" = "fullpage";
  let askUserPurpose: AskUserPurposeKind | null = null;
  let generateSvgPreviousDocState: DocState | null = null;
  const toolIoSpans = new Map<string, Span<SpanType.TOOL_CALL> | null>();
  const streamingPlaceholders = new Set<string>();

  function hasToolCallPart(messageId: string, toolCallId: string): boolean {
    const message = state.chatHistory.find((m) => m.id === messageId);
    return message?.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId) === true;
  }

  function* emitOrUpdateToolCall(
    spec: ToolCallSpec,
    _alreadyPlaced: boolean,
  ): Generator<BridgeFrame> {
    // UI 渲染工具卡依赖 chatMessageAppended(toolCall part),toolCallUpdated 只负责刷新。
    // 因此这里以 chatHistory 是否已有 part 为准去重:OpenAI 正常路径不重复 append,
    // GLM/anthropic 缺 streaming-start 或 progress 先到时也能补建可见卡。
    if (!hasToolCallPart(agentMessageId, spec.id)) {
      const seq = nextSeq(state, agentMessageId);
      const tcPart: MessagePart = { kind: "toolCall", data: spec };
      yield chatMessageAppended(agentMessageId, seq, tcPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, tcPart);
    }
    yield toolCallUpdated(agentMessageId, spec.id, spec);
    updateToolCallInChatHistory(state, agentMessageId, spec.id, spec);
  }

  // 空响应兜底：跟踪本轮是否出现过任何工具调用。若流自然跑完却既无正文、
  // 无工具调用、无 patch（且非 askUser/编辑意图轮），说明模型静默
  // 返回了空结果，需给用户一个可见的可重试提示，避免"零产出且无任何反馈"。
  let sawAnyToolCall = false;
  let sawNonUiToolCall = false;
  let sawToolHeartbeat = false;
  // 本轮是否发生过空闲看门狗(idle timeout)中断:用于让兜底文案如实归因为
  // "长时间无响应被中断"而非误报"达到步数上限"(两者都以 finishReason=tool-calls 收尾)。
  let sawIdleTimeout = false;
  let lastStepFinishReason: string | null = null;
  let sawTextAfterLastTool = true;
  let stepIndex = -1;
  let activeStepIndex: number | null = null;
  // 当前步最后一个"模型输出"chunk(text/reasoning/tool-call)的时刻。挂起步
  // 补记 llm_response 时用它作 modelEndedAt——模型吐完工具参数即响应完成,
  // 不该把后续工具执行(askUser 出题数秒)算进模型耗时。
  let lastModelChunkAt: string | null = null;
  // 挂起返回前补记本步的 llm_response(详见 buildLlmSuspendedResponseSpanEnd)。
  // 置空 activeStepIndex 防止罕见的后续 step-finish 双记。
  const recordSuspendedStepResponse = (toolName: string, toolCallId: string): void => {
    if (activeStepIndex === null) return;
    recordLlmSuspendedResponseSpan(state, streamId, runId, activeStepIndex, {
      toolName,
      toolCallId,
      modelEndedAt: lastModelChunkAt,
    });
    activeStepIndex = null;
  };

  // Resolve fileId↔filename mapping so parseFile/storeMaterial can bind materials to upload IDs.
  const fileIdMap = new Map<string, string>(); // filename → fileId
  const resolvedFilesByFilename = new Map<string, ResolvedUploadedFile>();
  const resolvedFilesByFileId = new Map<string, ResolvedUploadedFile>();
  if (turnFileIds && turnFileIds.length > 0) {
    try {
      const resolved = await resolveFileIds(turnFileIds);
      for (const f of resolved) {
        fileIdMap.set(f.filename, f.fileId);
        resolvedFilesByFilename.set(f.filename, f);
        resolvedFilesByFileId.set(f.fileId, f);
      }
    } catch {
      // Non-fatal: preview just won't have fileId
    }
  }

  const basenameArg = (value: unknown): string | null => {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return basename(value);
  };

  const resolveParseFileBinding = (args: Record<string, unknown>): {
    fileId: string | null;
    filename: string | null;
    mimeType: string | null;
  } => {
    const argFileId = typeof args.fileId === "string" && args.fileId ? args.fileId : null;
    const argFilename = typeof args.filename === "string" && args.filename ? args.filename : null;
    const byFileId = argFileId ? resolvedFilesByFileId.get(argFileId) : undefined;
    const byFilename = argFilename ? resolvedFilesByFilename.get(argFilename) : undefined;
    const filePathBase = basenameArg(args.filePath);
    const fileId = argFileId ?? (argFilename ? fileIdMap.get(argFilename) ?? null : null) ?? filePathBase;
    return {
      fileId,
      filename: argFilename ?? byFileId?.filename ?? byFilename?.filename ?? filePathBase ?? fileId,
      mimeType:
        (typeof args.mimeType === "string" && args.mimeType ? args.mimeType : null) ??
        byFileId?.mimeType ??
        byFilename?.mimeType ??
        null,
    };
  };

  const upsertParseFileErrorMaterial = (
    args: Record<string, unknown>,
    failure: MaterialParseFailure,
  ): void => {
    const binding = resolveParseFileBinding(args);
    if (!binding.fileId) {
      logger.warn("parseFile 失败但无法绑定 fileId，跳过失败素材落库", {
        sessionId: state.sessionId,
        filename: args.filename,
        filePath: args.filePath,
      });
      return;
    }
    const { frame } = upsertMaterialByFileId(
      state,
      {
        fileId: binding.fileId,
        filename: binding.filename,
        mimeType: binding.mimeType,
      },
      failure,
    );
    materialFrames.push(frame);
    schedulePersist(state, "tool_result:parseFile_error_material").catch((err) =>
      logger.error("Persist after parseFile error material failed", { error: String(err) }),
    );
  };

  const timeoutMs = opts.idleTimeoutMs ?? AGENT_IDLE_TIMEOUT_MS;
  const monitoredStream = withIdleTimeout(fullStream, timeoutMs, () => {
    abortController.abort(IDLE_TIMEOUT_ABORT_REASON);
  });
  for await (const chunk of monitoredStream) {
    // 上游 LLM 调用失败(网络/超时/服务异常,且重试已耗尽):Mastra 把错误作为
    // type:"error" 的 chunk(deferredErrorChunk)推上来。此前主循环没有这个分支 →
    // 错误被静默丢弃,表现为"文档出来了却没收尾、也不报错"(other side closed 实测)。
    // 这里如实报错给用户(可重试),不静默、也不假装成功。
    if ((chunk.type as string) === "error") {
      const apiErr = (chunk as { payload?: { error?: unknown } }).payload?.error;
      const isIdleTimeout = isIdleTimeoutChunk(chunk);
      if (isUserAbortSignal(abortController.signal)) {
        outcome.streamWasUserAborted = true;
        logger.info("Ignoring stream error chunk from user-aborted turn", {
          sessionId: state.sessionId,
          streamId,
          idleTimeout: isIdleTimeout,
          error: apiErr instanceof Error ? apiErr.message : String(apiErr),
        });
        continue;
      }
      if (isIdleTimeout) sawIdleTimeout = true;
      const errorDetails = streamErrorDetails(chunk);
      const isTransient = isTransientStreamErrorChunk(chunk);
      logger.error("LLM stream error chunk", {
        sessionId: state.sessionId,
        streamId,
        idleTimeout: isIdleTimeout,
        statusCode: errorDetails.statusCode ?? null,
        category: errorDetails.category,
        retriable: errorDetails.retriable,
        transient: isTransient,
        producedVisibleFrame: outcome.producedVisibleFrame,
        sawToolCall: outcome.sawToolCall,
        error: apiErr instanceof Error ? apiErr.message : String(apiErr),
      });
      if (isTransient && !outcome.producedVisibleFrame && !outcome.sawSideEffectToolCall) {
        outcome.transientErrorChunk = chunk;
        return outcome;
      }
      if (!accumulatedText) {
        yield appendVisibleStreamErrorText(state, agentMessageId, errorDetails.userMessage);
        accumulatedText += errorDetails.userMessage;
        outcome.producedVisibleFrame = true;
      }
      yield draftingFailedFrame(streamId, errorDetails);
      outcome.producedVisibleFrame = true;
      continue;
    }

    if (chunk.type === "tripwire") {
      const notice = guardrailTripwireMessage(chunk);
      yield appendVisibleStreamErrorText(state, agentMessageId, notice);
      accumulatedText += notice;
      outcome.producedVisibleFrame = true;
      logger.warn("Guardrail tripwire emitted visible failure frame", {
        sessionId: state.sessionId,
        streamId,
        reason: notice,
      });
      yield draftingFailedFrame(streamId, notice, false);
      continue;
    }

    if (chunk.type === "step-start") {
      stepIndex += 1;
      activeStepIndex = stepIndex;
      lastModelChunkAt = null;
      recordLlmRequestSpan(state, streamId, runId, stepIndex, chunk.payload);
      continue;
    }

    if (chunk.type === "step-finish") {
      if (activeStepIndex === null) {
        stepIndex += 1;
        activeStepIndex = stepIndex;
      }
      const payload = asRecord(chunk.payload);
      const stepResult = asRecord(payload?.stepResult);
      const reason = stepResult?.reason ?? payload?.finishReason ?? payload?.reason;
      lastStepFinishReason = typeof reason === "string" ? reason : null;
      recordLlmStepResponseSpan(state, streamId, runId, activeStepIndex, chunk.payload);
      // F1 计费账本:每个 agent step 的 usage 同步入账(fire-and-forget,主链优先)。
      // R2-B:providerMetadata 与 usage 是同级字段,必须合并传入才能拿到 DeepSeek 缓存命中。
      {
        const stepOutput = asRecord(payload?.output);
        const usageRecord = asRecord(stepOutput?.usage);
        const siblingMeta =
          stepOutput?.providerMetadata ?? payload?.providerMetadata ??
          asRecord(payload?.stepResult)?.providerMetadata;
        const usage = normalizeLlmUsage(
          usageRecord
            ? { ...usageRecord, ...(siblingMeta ? { providerMetadata: siblingMeta } : {}) }
            : stepOutput?.usage,
        );
        if (usage) {
          const { origin } = resolveDeepseekAuth(requestContext);
          void recordUsageEvent({
            sessionId: state.sessionId,
            runId,
            callSite: "agent",
            modelId: DEEPSEEK_MODEL_IDS.flash,
            keyOrigin: origin,
            inputTokens: toNumber(usage.inputTokens),
            outputTokens: toNumber(usage.outputTokens),
            cacheHitTokens: toNumber(usage.promptCacheHitTokens),
            cacheMissTokens: toNumber(usage.promptCacheMissTokens),
          });
        }
      }
      activeStepIndex = null;
      continue;
    }

    // -----------------------------------------------------------------
    // tool-output: progressive generation and askUser events
    // -----------------------------------------------------------------
    if (chunk.type === "tool-output") {
      const payload = chunk.payload as { toolCallId?: unknown; output?: Record<string, unknown> };
      const output = payload.output;
      if (output?.type === "tool-heartbeat") {
        sawToolHeartbeat = true;
        continue;
      }
      outcome.sawToolCall = true;
      // askUser 的流式出题进度不算副作用;doc-generation 等其余输出按副作用计。
      if (output?.type === "doc-generation-event") outcome.sawSideEffectToolCall = true;
      const toolOutputCallId =
        typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      if (output?.type === "doc-generation-event") {
        const event = asDocGenerationEvent(output.event);
        if (!event) {
          logger.warn("invalid doc-generation-event tool output ignored", {
            streamId,
            toolCallId: toolOutputCallId,
          });
          continue;
        }
        if (docGeneratedThisTurn) {
          continue;
        }
        activeDocGenerationToolCallId = toolOutputCallId;
        activeDocGenerationId = event.data.generationId;
        activeDocGenerationLastSeq = event.data.seq;
        if (event.kind === "generation_failed") {
          activeDocGenerationFailedEventSeen = true;
        }
        yield { kind: "docGenerationEvent", data: event };
        outcome.producedVisibleFrame = true;
        continue;
      }
      // writeDraft 写稿小卡片:流式进度刷新工具卡(writing/finalizing/failed 实时字数+摘录)。
      // 若协议没先给 tool-call/streaming-start,emitOrUpdateToolCall 会先补建可渲染 part。
      if (
        output &&
        output.type === "writedraft-progress" &&
        output.progress &&
        typeof output.progress === "object" &&
        toolOutputCallId
      ) {
        outcome.sawSideEffectToolCall = true;
        sawWriteDraftProgress = true;
        const progress = output.progress as WriteDraftCardBody;
        const spec: ToolCallSpec = {
          id: toolOutputCallId,
          name: "writeDraft",
          render: { kind: "chatInline" },
          status:
            progress.phase === "failed"
              ? { kind: "failed", data: { retriable: true, reason: "writeDraft 生成失败" } }
              : { kind: "running", data: { progressPct: null, etaSec: null } },
          body: {
            kind: "writeDraftCard",
            data: progress,
          },
          result: null,
        };
        yield* emitOrUpdateToolCall(spec, false);
        outcome.producedVisibleFrame = true;
        continue;
      }
      // generateSvg 配图卡片:只刷新阶段/耗时/KB/最终缩略图,不渲染未消毒的半截 SVG。
      if (
        output &&
        output.type === "generatesvg-progress" &&
        output.progress &&
        typeof output.progress === "object" &&
        toolOutputCallId
      ) {
        outcome.sawSideEffectToolCall = true;
        const progress = normalizeGenerateSvgProgress(output.progress);
        if (!progress) continue;
        const meta = generateSvgMeta.get(toolOutputCallId);
        const spec = generateSvgToolCallSpec(
          toolOutputCallId,
          meta?.args ?? {},
          { kind: "running", data: { progressPct: null, etaSec: null } },
          null,
          progress,
        );
        yield toolCallUpdated(agentMessageId, toolOutputCallId, spec);
        updateToolCallInChatHistory(state, agentMessageId, toolOutputCallId, spec);
        outcome.producedVisibleFrame = true;
        continue;
      }
      // research(webSearch 搜索即抓取):逐行抓取进度刷新 ResearchCard
      if (
        output &&
        output.type === "research-progress" &&
        output.progress &&
        typeof output.progress === "object" &&
        toolOutputCallId
      ) {
        outcome.sawSideEffectToolCall = true;
        const spec = researchCardToolCallSpec(
          toolOutputCallId,
          output.progress as ResearchCardBody,
          { kind: "running", data: { progressPct: null, etaSec: null } },
        );
        yield toolCallUpdated(agentMessageId, toolOutputCallId, spec);
        updateToolCallInChatHistory(state, agentMessageId, toolOutputCallId, spec);
        outcome.producedVisibleFrame = true;
        continue;
      }
      // askUser streaming progress — push partial questions to frontend
      if (
        output &&
        output.type === "askuser-progress" &&
        Array.isArray(output.questions)
      ) {
        const progressToolCallId =
          typeof chunk.payload.toolCallId === "string"
            ? chunk.payload.toolCallId
            : null;
        const tcId = progressToolCallId ?? "askuser-progress";
        if (progressToolCallId !== null) {
          askUserProgressToolCallId = progressToolCallId;
        }
        const partialSpec = buildAskUserToolCallSpec(
          tcId,
          {
            id: "streaming",
            renderMode: askUserRenderMode,
            purpose: askUserPurpose,
            source: null,
            rationale: null,
            questions: output.questions,
          },
          { kind: "running", data: { progressPct: null, etaSec: null } },
        );

        // First progress → create the toolCall entry via chatMessageAppended
        // so the frontend has something for toolCallUpdated to target
        if (!askUserProgressEmitted) {
          askUserProgressEmitted = true;
          const seq = nextSeq(state, agentMessageId);
          const tcPart: MessagePart = { kind: "toolCall", data: partialSpec };
          yield chatMessageAppended(agentMessageId, seq, tcPart);
          outcome.producedVisibleFrame = true;
          ensureAgentChatHistoryMessage(state, agentMessageId);
          appendPartToChatHistory(state, agentMessageId, tcPart);
          // 同步进入问卷态，让 BigPlanPanel 能立即渲染。
          yield* syncContentAndProjectDocState(state, "ask_user_started");
        }

        yield toolCallUpdated(agentMessageId, tcId, partialSpec);
        updateToolCallInChatHistory(state, agentMessageId, tcId, partialSpec);
      }
      // readImage 流式识别进度:把副基模吐出的文字刷进识别卡的文案区(前端滚动展示)。
      if (
        output &&
        output.type === "readimage-progress" &&
        output.progress &&
        typeof output.progress === "object" &&
        toolOutputCallId
      ) {
        const excerpt = (output.progress as { excerpt?: unknown }).excerpt;
        const meta = readImageMeta.get(toolOutputCallId);
        const spec = readImageToolCallSpec(
          toolOutputCallId,
          meta?.args ?? {},
          { kind: "running", data: { progressPct: null, etaSec: null } },
          null,
          meta?.thumbnailSrc ?? null,
          typeof excerpt === "string" && excerpt ? excerpt : null,
        );
        yield* emitOrUpdateToolCall(spec, false);
        outcome.producedVisibleFrame = true;
      }
      continue;
    }

    // -----------------------------------------------------------------
    // text-delta
    // -----------------------------------------------------------------
    if (chunk.type === "text-delta") {
      const text = typeof chunk.payload.text === "string" ? chunk.payload.text : "";
      if (isLikelyInternalTextDelta(text)) {
        lastModelChunkAt = new Date().toISOString();
        continue;
      }
      accumulatedText += text;
      sawTextAfterLastTool = true;
      lastModelChunkAt = new Date().toISOString();
      const seq = nextSeq(state, agentMessageId);
      const textPart: MessagePart = { kind: "text", data: { body: text } };
      yield chatMessageAppended(agentMessageId, seq, textPart);
      outcome.producedVisibleFrame = true;
      appendPartToChatHistory(state, agentMessageId, textPart);
      continue;
    }

    // -----------------------------------------------------------------
    // reasoning
    // -----------------------------------------------------------------
    if (chunk.type === "reasoning-start") {
      reasoningId = (chunk.payload as { id?: string }).id ?? newId();
      continue;
    }
    if (chunk.type === "reasoning-delta") {
      const delta = (chunk.payload as { text?: string }).text ?? "";
      if (delta.length > 0) {
        const seq = nextSeq(state, agentMessageId);
        const thinkingPart: MessagePart = {
          kind: "thinking",
          data: {
            id: reasoningId ?? newId(),
            steps: [delta],
          },
        };
        yield chatMessageAppended(agentMessageId, seq, thinkingPart);
        appendPartToChatHistory(state, agentMessageId, thinkingPart);
      }
      continue;
    }
    if (chunk.type === "reasoning-end") {
      reasoningId = null;
      lastModelChunkAt = new Date().toISOString();
      continue;
    }

    // -----------------------------------------------------------------
    // tool-call-suspended: Mastra suspend() was called
    // -----------------------------------------------------------------
    if (chunk.type === "tool-call-suspended") {
      outcome.sawToolCall = true;
      if ((chunk.payload as { toolName?: unknown }).toolName !== "askUser") {
        outcome.sawSideEffectToolCall = true;
      }
      const payload = chunk.payload as {
        toolCallId: string;
        toolName: string;
        suspendPayload: any;
        args: Record<string, any>;
      };
      const suspensionToolName = toSuspensionToolName(payload.toolName);
      if (!suspensionToolName) {
        logger.error("Unsupported suspended tool ignored", {
          toolName: payload.toolName,
          toolCallId: payload.toolCallId,
          streamId,
        });
        continue;
      }

      if (state.runId !== null && state.toolCallId === payload.toolCallId) {
        logger.info("Duplicate suspension replay detected — preserving pending run", {
          toolName: payload.toolName,
          runId: state.runId,
          toolCallId: payload.toolCallId,
        });
        wasSuspended = true;
        clearDraftConfirmationState(state);
        requestContext?.set("legacySections", state.legacySections);
        recordSuspension(state, {
          streamId,
          runId: state.runId,
          toolCallId: payload.toolCallId,
          toolName: suspensionToolName,
        });
        recordSuspendedStepResponse(payload.toolName, payload.toolCallId);
        markToolIoSpanSuspended(toolIoSpans.get(payload.toolCallId));
        toolIoSpans.delete(payload.toolCallId);
        return outcome;
      }

      // 用户在该 askUser 仍 running(未挂起)时点了「放弃本轮」:此刻挂起才落地。命中即
      // 丢弃挂起、回 idle,不投影成新问卷(根因:abort 与挂起抢跑,挂起在 abort 后落地)。
      // tool-call 已由 cancelAskUser 终结;这里只需把 Mastra 步骤标记已响应 + 清挂起。
      const abandonedAskUser = state._abandonedAskUserToolCallIds;
      if (abandonedAskUser?.has(payload.toolCallId)) {
        abandonedAskUser.delete(payload.toolCallId);
        clearSuspension(state);
        state._askUserSuspendCount = 0;
        recordSuspendedStepResponse(payload.toolName, payload.toolCallId);
        markToolIoSpanSuspended(toolIoSpans.get(payload.toolCallId));
        toolIoSpans.delete(payload.toolCallId);
        yield* transitionAndProjectDocState(
          state,
          normalizeTargetDocState(
            state,
            state.previousDocState ?? idleDocState(state),
            "ask_user_abandoned",
          ),
          "ask_user_abandoned",
          { mode: "normalize" },
        );
        await schedulePersist(state, "askUser:abandoned_running_suspend").catch((err) =>
          logger.error("Persist after abandoned running askUser suspend failed", {
            error: String(err),
          }),
        );
        return outcome;
      }

      if (payload.toolName === "askUser") {
        state._askUserSuspendCount = (state._askUserSuspendCount ?? 0) + 1;
        if (state._askUserSuspendCount > MAX_CONSECUTIVE_ASKUSER_SUSPENDS) {
          const terminalized = terminalizeAskUserToolCall(
            state,
            payload.toolCallId,
            "Agent 反复请求澄清而未继续生成，请重试或换个说法",
          );
          if (terminalized) {
            yield toolCallUpdated(
              terminalized.messageId,
              terminalized.toolCallId,
              terminalized.spec,
            );
          }
          clearSuspension(state);
          state._askUserSuspendCount = 0;
          yield* transitionAndProjectDocState(
            state,
            normalizeTargetDocState(
              state,
              state.previousDocState ?? idleDocState(state),
              "ask_user_abandoned",
            ),
            "ask_user_abandoned",
            { mode: "normalize" },
          );
          yield {
            kind: "stream",
            data: {
              kind: "draftingFailed",
              data: {
                streamId,
                reason: "Agent 反复请求澄清而未继续生成，请重试或换个说法",
                retriable: true,
              },
            },
          };
          await schedulePersist(state, "askUser:abandoned_suspend").catch((err) =>
            logger.error("Persist after abandoned askUser suspend failed", { error: String(err) }),
          );
          recordSuspendedStepResponse(payload.toolName, payload.toolCallId);
          return outcome;
        }
      } else {
        state._askUserSuspendCount = 0;
      }

      wasSuspended = true;
      clearDraftConfirmationState(state);
      requestContext?.set("legacySections", state.legacySections);

      recordSuspension(state, {
        streamId,
        runId,
        toolCallId: payload.toolCallId,
        toolName: suspensionToolName,
      });
      recordSuspendedStepResponse(payload.toolName, payload.toolCallId);
      markToolIoSpanSuspended(toolIoSpans.get(payload.toolCallId));
      toolIoSpans.delete(payload.toolCallId);
      state.previousDocState = state.docState;

      if (payload.toolName === "askUser") {
        // No seenAskUser guard here — the guard lives in the tool-call
        // handler to block a *second* askUser call.  The suspend event
        // always corresponds to the call that was already accepted, so
        // it must be processed unconditionally.

        // 先取"本轮之前是否弹过问卷"，再置真——否则"首轮 → 大表单"判断会失效。
        const askedBefore = state._askUserAsked === true;
        // 弹出问卷即标记 asked(仅渲染形态用);completed 留到用户**真正提交答案**
        // (tool-result with answers)时才置 → 中途放弃不会永久抑制后续 askUser。
        state._askUserAsked = true;
        const suspendData = payload.suspendPayload as {
          id: string;
          purpose: AskUserPurposeKind;
          source: string | null;
          rationale: string | null;
          questions: Array<{
            id: string;
            label: string;
            kind: "single" | "multi" | "text" | "slider";
            options: Array<{
              value: string;
              label: string;
              description: string | null;
              preview: string | null;
            }>;
            placeholder: string | null;
            slider?: AskUserSliderSpec | null;
          }>;
        };

        // 同一个 askUser toolCall 的展示形态一旦在 early/progress spec 中确定,
        // suspend/final 阶段必须沿用;只有冷恢复找不到 spec 时才按当前上下文兜底重算。
        const existingRenderMode = askUserRenderModeFromSpec(
          findAskUserToolCallSpecInChatHistory(state.chatHistory, payload.toolCallId),
        );
        const renderMode =
          existingRenderMode ??
          decideAskUserRenderMode(
            suspendData.purpose,
            state.docState.kind,
            askedBefore,
          );
        logger.info("askUser render decision", {
          sessionId: state.sessionId,
          purpose: suspendData.purpose,
          renderMode,
          reusedExistingMode: existingRenderMode !== null,
          askedBefore,
          docState: state.docState.kind,
          questionCount: suspendData.questions.length,
        });

        const spec = buildAskUserToolCallSpec(payload.toolCallId, {
          ...suspendData,
          renderMode,
          purpose: suspendData.purpose,
        });

        if (!askUserProgressEmitted || askUserProgressToolCallId !== payload.toolCallId) {
          // No streaming progress was emitted — create the toolCall entry now
          const seq = nextSeq(state, agentMessageId);
          const tcPart: MessagePart = { kind: "toolCall", data: spec };
          yield chatMessageAppended(agentMessageId, seq, tcPart);
          ensureAgentChatHistoryMessage(state, agentMessageId);
          appendPartToChatHistory(state, agentMessageId, tcPart);
        }
        // Always update with the final complete spec. Mutate chatHistory
        // before yielding the frame: if the browser refreshes right after
        // receiving this frame, restore must see the same actionable card
        // instead of the earlier empty placeholder.
        updateToolCallInChatHistory(state, agentMessageId, payload.toolCallId, spec);
        yield toolCallUpdated(agentMessageId, payload.toolCallId, spec);

        yield* syncContentAndProjectDocState(state, "ask_user_suspended");
      }

      // Store accumulated text into conversation history before returning
      if (accumulatedText) {
        state.messages.push({
          role: "assistant",
          content: accumulatedText,
        });
      }

      // Emit deferred material frames
      for (const frame of materialFrames) {
        yield frame;
      }

      // Persist state across restarts when suspended
      await schedulePersist(state, "tool_call_suspended").catch((err) =>
        logger.error("Persist after tool-call-suspended failed", { error: String(err) }),
      );

      return outcome;
    }

    // -----------------------------------------------------------------
    // tool-call 参数流式占位
    // -----------------------------------------------------------------
    if (chunk.type === "tool-call-input-streaming-start") {
      const payload = chunk.payload as { toolCallId?: unknown; toolName?: unknown };
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
      // 覆盖所有工具:模型一确定 toolName(参数 JSON 还没开始生成)就提前建占位卡。
      // 整块 tool-call 各分支统一走 emitOrUpdateToolCall 去重,故全覆盖天然安全。
      if (!toolCallId || !toolName) {
        continue;
      }
      if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
        continue;
      }
      if (streamingPlaceholders.has(toolCallId)) {
        continue;
      }
      const spec: ToolCallSpec = {
        id: toolCallId,
        name: toolName,
        render: { kind: "chatInline" },
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
        body: { kind: "generic", data: { argsJson: "" } },
        result: null,
      };
      const seq = nextSeq(state, agentMessageId);
      const tcPart: MessagePart = { kind: "toolCall", data: spec };
      yield chatMessageAppended(agentMessageId, seq, tcPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, tcPart);
      streamingPlaceholders.add(toolCallId);
      outcome.producedVisibleFrame = true;
      continue;
    }

    if (chunk.type === "tool-call-delta") {
      continue;
    }

    if (chunk.type === "tool-call-input-streaming-end") {
      continue;
    }

    // -----------------------------------------------------------------
    // tool-call
    // -----------------------------------------------------------------
    if (chunk.type === "tool-call") {
      const toolName = chunk.payload.toolName as string;
      const toolCallId = chunk.payload.toolCallId as string;
      const toolArgs = normalizeToolCallArgs(toolName, chunk.payload as Record<string, unknown>);
      toolCallArgsById.set(toolCallId, toolArgs);
      const alreadyPlaced = streamingPlaceholders.has(toolCallId);
      if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
        // updateTodos:会话状态帧,不进 chatHistory / 不建工具卡。
        sawAnyToolCall = true;
        sawTextAfterLastTool = false;
        lastModelChunkAt = new Date().toISOString();
        outcome.sawToolCall = true;
        const parsed = todosSchema.safeParse(toolArgs.todos);
        if (parsed.success) {
          state.todos = parsed.data;
          yield { kind: "todosChanged", data: { todos: state.todos } };
          outcome.producedVisibleFrame = true;
        } else {
          logger.warn("Session state tool updateTodos ignored invalid todos", {
            toolName,
            toolCallId,
            streamId,
            sessionId: state.sessionId,
            error: parsed.error.message,
          });
        }
        streamingPlaceholders.delete(toolCallId);
        continue;
      }
      sawAnyToolCall = true;
      if (!PURE_UI_TOOL_NAMES.has(toolName)) sawNonUiToolCall = true;
      sawTextAfterLastTool = false;
      lastModelChunkAt = new Date().toISOString();
      outcome.sawToolCall = true;
      if (toolName !== "askUser" && !PURE_UI_TOOL_NAMES.has(toolName)) {
        outcome.sawSideEffectToolCall = true;
      }

      logger.info("Tool call received", {
        toolName,
        toolCallId,
        streamId,
        sessionId: state.sessionId,
      });
      toolIoSpans.set(
        toolCallId,
        startToolIoSpan(
          state,
          streamId,
          runId,
          toolName,
          toolCallId,
          toolArgs,
        ),
      );

      if (
        DRAFT_MUTATION_TOOL_NAMES.has(toolName) &&
        !hasUsableDraftMutationArgs(toolName, toolArgs)
      ) {
        sawFailedDraftMutationInput = true;
        const failSpec: ToolCallSpec = {
          id: toolCallId,
          name: toolName,
          render: { kind: "chatInline" },
          status: { kind: "failed", data: { retriable: true, reason: DRAFT_TOOL_JSON_RETRY_NOTICE } },
          body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
          result: { kind: "genericText", data: DRAFT_TOOL_JSON_RETRY_NOTICE },
        };
        yield* emitOrUpdateToolCall(failSpec, alreadyPlaced);
        outcome.producedVisibleFrame = true;
        logger.warn("Draft mutation tool-call has invalid or empty arguments", {
          toolName,
          toolCallId,
          streamId,
          sessionId: state.sessionId,
        });
        continue;
      }

      if (toolName === "writeDraft") {
        // Emit a running tool call for writeDraft and transition to drafting.
        const spec: ToolCallSpec = {
          id: toolCallId,
          name: toolName,
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
          result: null,
        };
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);

        // 切到生成态，让前端显示生成动效。
        yield* syncContentAndProjectDocState(state, "generate_doc_started");
      } else if (toolName === "askUser") {
        // 只压**重复的初稿方向问卷**(initialBrief):首稿前确认过方向就别再问同一份。
        // directionChange(用户确实要推翻/大改已有稿方向,如"整篇改公文风")是合法二次方向确认,
        // 但同一份 directionChange 已完成且期间没有任何有效写入时,不再豁免 completed 抑制;
        // quickClarification(写作中途局部小澄清)也放行可多次。两者滥用靠
        // MAX_CONSECUTIVE_ASKUSER_SUSPENDS 看门狗(写作产出跑完一轮在 processAgentStream
        // 末尾重置 _askUserSuspendCount)兜住连续无产出的澄清。
        const directionChangeBypassCompleted =
          toolArgs.purpose === "directionChange" &&
          state._directionChangeAskedSinceLastWrite !== true;
        const askUserAlreadyCompleted =
          ((requestContext?.get("askUserAlreadyCompleted") as boolean | undefined) === true ||
            state._askUserCompleted === true) &&
          toolArgs.purpose !== "quickClarification" &&
          !directionChangeBypassCompleted;
        if (askUserAlreadyCompleted) {
          logger.warn("askUser tool-call suppressed (already completed) - no UI frame", {
            toolCallId,
            streamId,
          });
          continue;
        }
        // Skip duplicate askUser tool calls in the same stream
        if (seenAskUser) {
          logger.warn("Duplicate askUser tool-call ignored", { toolCallId, streamId });
          continue;
        }
        seenAskUser = true;

        // 由代码决定渲染形态：用 _askUserAsked(本轮之前是否弹过问卷)判断
        // "首轮 ask → 大表单 / 已弹过 → 左侧浮层"；存入流内变量供进度/最终 spec 复用。
        {
          const rawPurpose = toolArgs.purpose;
          askUserPurpose =
            rawPurpose === "initialBrief" ||
            rawPurpose === "quickClarification" ||
            rawPurpose === "directionChange"
              ? rawPurpose
              : null;
          askUserRenderMode = decideAskUserRenderMode(
            askUserPurpose,
            state.docState.kind,
            state._askUserAsked === true,
          );
        }

        // 先写 running 占位，再投影，保证状态不变量能看到 askUser。
        const earlySpec = buildAskUserToolCallSpec(
          toolCallId,
          {
            id: "streaming",
            renderMode: askUserRenderMode,
            purpose: askUserPurpose,
            source: null,
            rationale: null,
            questions: [],
          },
          { kind: "running", data: { progressPct: null, etaSec: null } },
        );
        yield* emitOrUpdateToolCall(earlySpec, alreadyPlaced);
        yield* syncContentAndProjectDocState(state, "ask_user_started");
        askUserProgressEmitted = true;
        // Record the toolCallId of the emitted placeholder so the suspend
        // handler's re-emit guard (!askUserProgressEmitted ||
        // askUserProgressToolCallId !== payload.toolCallId) recognizes this
        // toolCall as already emitted and only UPDATES it instead of
        // appending a duplicate form. Without this, the normal single-askUser
        // flow (tool-call askUser → tool-call-suspended same id, no
        // askuser-progress chunk) would double-emit the questionnaire.
        askUserProgressToolCallId = toolCallId;
      } else if (toolName === "webSearch") {
        const spec = researchCardToolCallSpec(
          toolCallId,
          {
            query: String(toolArgs.query ?? ""),
            phase: "searching",
            items: [],
            total: null,
            fetchedCount: 0,
            okCount: 0,
            skippedCount: 0,
          },
          { kind: "running", data: { progressPct: null, etaSec: null } },
        );
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);
      } else if (toolName === "generateSvg") {
        if (!generateSvgPreviousDocState) {
          generateSvgPreviousDocState = state.docState;
        }
        generateSvgMeta.set(toolCallId, { args: toolArgs });
        const spec = generateSvgToolCallSpec(
          toolCallId,
          toolArgs,
          { kind: "running", data: { progressPct: null, etaSec: null } },
        );
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);
        yield* syncContentAndProjectDocState(state, "generate_svg_started");
      } else if (toolName === "readImage") {
        const args = (chunk.payload.args ?? {}) as Record<string, unknown>;
        const thumbnailSrc = typeof args.image === "string"
          ? await thumbnailSrcForImageInput(args.image)
          : null;
        readImageMeta.set(toolCallId, { args, thumbnailSrc });
        const spec = readImageToolCallSpec(
          toolCallId,
          args,
          { kind: "running", data: { progressPct: null, etaSec: null } },
          null,
          thumbnailSrc,
        );
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);
        outcome.producedVisibleFrame = true;
      } else if (toolName === "show_qr") {
        // 二维码卡:工具调用即渲染 qrCard body(渲染瞬间客户端起算过期)。
        const spec = qrCardToolCallSpec(toolCallId, toolArgs, {
          kind: "running",
          data: { progressPct: null, etaSec: null },
        });
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);
        outcome.producedVisibleFrame = true;
      } else {
        const spec: ToolCallSpec = {
          id: toolCallId,
          name: toolName,
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
          result: null,
        };
        yield* emitOrUpdateToolCall(spec, alreadyPlaced);
      }
      streamingPlaceholders.delete(toolCallId);
      continue;
    }

    // -----------------------------------------------------------------
    // tool-error —— 工具 execute() 抛错时 AI SDK v5 / Mastra v3 发的 chunk
    // -----------------------------------------------------------------
    // 此前主循环没有这个分支 → tool-error 不匹配任何 if → 被静默丢弃 → 该工具 spec 永远停在
    // running → 前端 spinner 不收口,且卡住的 spec 还被持久化进 chatHistory(重开会话也卡)。
    // 与 tool-result 对称:找到对应 spec 切成 done(前端对 failed 也渲染成完成),yield +
    // 写回 chatHistory,清掉 streaming 占位与 tool IO span。通用 error chunk 处理的是 LLM 流级
    // 失败,覆盖不到工具级 tool-error,故必须单列。
    if (chunk.type === "tool-error") {
      const payload = (chunk.payload ?? chunk) as Record<string, unknown>;
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
      const errText = stringifyToolError(payload.error);
      if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
        outcome.sawToolCall = true;
        sawAnyToolCall = true;
        sawTextAfterLastTool = false;
        endToolIoSpan(
          toolIoSpans.get(toolCallId),
          { ok: false, error: errText },
          false,
          buildToolIoEndMetadata(false, { ok: false, error: errText }),
        );
        toolIoSpans.delete(toolCallId);
        streamingPlaceholders.delete(toolCallId);
        logger.warn("Session state tool error ignored", {
          toolName,
          toolCallId,
          streamId,
          sessionId: state.sessionId,
          error: errText,
        });
        continue;
      }
      outcome.sawToolCall = true;
      sawAnyToolCall = true;
      sawTextAfterLastTool = false;
      if (toolName && !PURE_UI_TOOL_NAMES.has(toolName)) sawNonUiToolCall = true;

      // 结束 tool IO span(失败收口)
      endToolIoSpan(
        toolIoSpans.get(toolCallId),
        { ok: false, error: errText },
        false,
        buildToolIoEndMetadata(false, { ok: false, error: errText }),
      );
      toolIoSpans.delete(toolCallId);

      const origMsg = toolCallId
        ? state.chatHistory.find((m) =>
            m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
          )
        : undefined;
      const origPart = origMsg?.parts.find(
        (p) => p.kind === "toolCall" && p.data.id === toolCallId,
      );
      if (origMsg && origPart && origPart.kind === "toolCall") {
        // 保住已建的卡片 body,只把状态收口成 done(前端不暴露失败,渲染成完成灰勾)
        const doneSpec: ToolCallSpec = {
          ...origPart.data,
          status: { kind: "done" },
          result:
            origPart.data.result ?? {
              kind: "genericText",
              data: errText || `工具 ${toolName || origPart.data.name} 执行失败`,
            },
        };
        yield toolCallUpdated(origMsg.id, toolCallId, doneSpec);
        updateToolCallInChatHistory(state, origMsg.id, toolCallId, doneSpec);
        outcome.producedVisibleFrame = true;
      } else if (toolCallId) {
        // 兜底:没找到原 part(占位卡还没建就抛错),用 toolName 建一张 done 卡收口
        const spec: ToolCallSpec = {
          id: toolCallId,
          name: toolName || "tool",
          render: { kind: "chatInline" },
          status: { kind: "done" },
          body: { kind: "generic", data: { argsJson: "" } },
          result: { kind: "genericText", data: errText || "工具执行失败" },
        };
        const seq = nextSeq(state, agentMessageId);
        const tcPart: MessagePart = { kind: "toolCall", data: spec };
        yield chatMessageAppended(agentMessageId, seq, tcPart);
        ensureAgentChatHistoryMessage(state, agentMessageId);
        appendPartToChatHistory(state, agentMessageId, tcPart);
        yield toolCallUpdated(agentMessageId, toolCallId, spec);
        updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
        outcome.producedVisibleFrame = true;
      }
      streamingPlaceholders.delete(toolCallId);
      schedulePersist(state, "tool_error").catch((err) =>
        logger.error("Persist after tool-error failed", { error: String(err) }),
      );
      continue;
    }

    // -----------------------------------------------------------------
    // tool-result
    // -----------------------------------------------------------------
    if (chunk.type === "tool-result") {
      const toolName = chunk.payload.toolName as string;
      const toolCallId = chunk.payload.toolCallId as string;
      const resultArgs = (chunk.payload.args ?? {}) as Record<string, unknown>;
      const args = { ...(toolCallArgsById.get(toolCallId) ?? {}), ...resultArgs };
      const payload = chunk.payload as Record<string, unknown>;
      const toolResult = (
        Object.prototype.hasOwnProperty.call(payload, "result")
          ? payload.result
          : payload.output
      ) as Record<string, unknown>;
      const toolResultOk =
        !toolResult ||
        typeof toolResult !== "object" ||
        (toolResult.ok !== false &&
          toolResult.success !== false);
      if (toolName === "search_tools" || toolName === "load_tool") {
        const loadedToolNames = extractLoadedToolNamesFromToolSearchResult(toolResult);
        if (loadedToolNames.length > 0) {
          const next = new Set(state._toolSearchLoadedToolNames ?? []);
          for (const loadedToolName of loadedToolNames) next.add(loadedToolName);
          state._toolSearchLoadedToolNames = Array.from(next);
          const prefixGuardContext = guardContext.getStore();
          if (prefixGuardContext?.sessionId === state.sessionId) {
            prefixGuardContext.allowedToolAdditions = Array.from(new Set([
              ...(prefixGuardContext.allowedToolAdditions ?? []),
              ...loadedToolNames,
            ]));
          }
        }
      }
      if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
        outcome.sawToolCall = true;
        sawAnyToolCall = true;
        sawTextAfterLastTool = false;
        appendToolTranscriptMessage(state, { toolName, toolCallId, args, result: toolResult });
        endToolIoSpan(
          toolIoSpans.get(toolCallId),
          toolResult,
          toolResultOk,
          buildToolIoEndMetadata(toolResultOk, toolResult),
          toolName,
        );
        toolIoSpans.delete(toolCallId);
        // 会话状态工具只给模型 transcript 确认,不写可见工具卡。
        streamingPlaceholders.delete(toolCallId);
        continue;
      }
      outcome.sawToolCall = true;
      sawAnyToolCall = true;
      sawTextAfterLastTool = false;
      if (!PURE_UI_TOOL_NAMES.has(toolName)) sawNonUiToolCall = true;
      if (toolName !== "askUser" && !PURE_UI_TOOL_NAMES.has(toolName)) {
        outcome.sawSideEffectToolCall = true;
      }
      appendToolTranscriptMessage(state, { toolName, toolCallId, args, result: toolResult });
      endToolIoSpan(
        toolIoSpans.get(toolCallId),
        toolResult,
        toolResultOk,
        buildToolIoEndMetadata(toolResultOk, toolResult),
        toolName,
      );
      toolIoSpans.delete(toolCallId);

      if (toolName === "askUser") {
        // askUser tool-result arrives in the RESUME stream after user submits
        // the questionnaire.  The original toolCall part lives in a PREVIOUS
        // agent message (from the stream that suspended).  We must find that
        // original message and update its toolCall status to "done" so that
        // session restore renders "✓已提交问卷" instead of "●等待您的确认".
        const answersRecord = normalizeAskUserAnswers(toolResult ?? {});
        const hasAnswers = Object.keys(answersRecord).length > 0;
        // 用户**真正提交**了答案 → 此刻才置 completed,守卫据此抑制后续重复 askUser
        // (中途放弃没有 tool-result/answers,不会走到这里,故不会被永久抑制)。
        if (hasAnswers) state._askUserCompleted = true;
        const completedAskUserSpec = findAskUserToolCallSpecInChatHistory(state.chatHistory, toolCallId);
        if (hasAnswers && askUserPurposeFromSpec(completedAskUserSpec) === "directionChange") {
          state._directionChangeAskedSinceLastWrite = true;
          requestContext?.set("directionChangeAskedSinceLastWrite", true);
        }

        // Find the original message that owns this toolCall
        const origMsg = state.chatHistory.find((m) =>
          m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
        );
        if (origMsg) {
          const origPart = origMsg.parts.find(
            (p) => p.kind === "toolCall" && p.data.id === toolCallId,
          );
          if (origPart && origPart.kind === "toolCall") {
            // Clone the existing spec and update status + result
            const doneSpec: ToolCallSpec = {
              ...origPart.data,
              status: { kind: "done" },
              result: hasAnswers
                ? { kind: "askUserAnswers", data: answersRecord }
                : { kind: "genericText", data: "已提交" },
            };
            yield toolCallUpdated(origMsg.id, toolCallId, doneSpec);
            updateToolCallInChatHistory(state, origMsg.id, toolCallId, doneSpec);
            if (
              hasAnswers &&
              appendAskUserAnswerMessageIfMissing(state, toolCallId, answersRecord, doneSpec)
            ) {
              schedulePersist(state, "tool_result:askUser_answer_message").catch((err) =>
                logger.error("Persist after askUser answer message failed", { error: String(err) }),
              );
            }
          }
        } else if (
          hasAnswers &&
          appendAskUserAnswerMessageIfMissing(state, toolCallId, answersRecord, null)
        ) {
          schedulePersist(state, "tool_result:askUser_answer_message").catch((err) =>
            logger.error("Persist after askUser answer message failed", { error: String(err) }),
          );
        }
      } else if (toolName === "show_qr") {
        // 二维码卡:结果回来时复用 running 阶段已生成的 body(保住那一刻算好的 expiresAt,
        // 不以结果时刻重算,避免过期时间往后漂移),仅把状态置完成;绝不被通用 done 卡覆盖。
        const origMsg = state.chatHistory.find((m) =>
          m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
        );
        const origPart = origMsg?.parts.find(
          (p) => p.kind === "toolCall" && p.data.id === toolCallId,
        );
        if (origMsg && origPart && origPart.kind === "toolCall") {
          const doneSpec: ToolCallSpec = {
            ...origPart.data,
            status: { kind: "done" },
            result: origPart.data.body.kind === "generic" && origPart.data.result == null
              ? { kind: "genericText", data: "show_qr 缺少 content,无法渲染二维码" }
              : origPart.data.result,
          };
          updateToolCallInChatHistory(state, origMsg.id, toolCallId, doneSpec);
          yield toolCallUpdated(origMsg.id, toolCallId, doneSpec);
          outcome.producedVisibleFrame = true;
        } else {
          // 兜底:没找到原 part(异常路径),用 args 重建一份 done(expiresAt 以此刻为基准)。
          const args = (chunk.payload.args ?? {}) as Record<string, unknown>;
          const spec = qrCardToolCallSpec(toolCallId, args, { kind: "done" });
          const seq = nextSeq(state, agentMessageId);
          const tcPart: MessagePart = { kind: "toolCall", data: spec };
          yield chatMessageAppended(agentMessageId, seq, tcPart);
          ensureAgentChatHistoryMessage(state, agentMessageId);
          appendPartToChatHistory(state, agentMessageId, tcPart);
          yield toolCallUpdated(agentMessageId, toolCallId, spec);
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
          outcome.producedVisibleFrame = true;
        }
      } else if (
        toolName === "generateSvg"
      ) {
        const result = toolResult as Record<string, unknown> | null;
        if (
          result &&
          typeof result === "object" &&
          result.ok === true &&
          typeof result.src === "string" &&
          result.src
        ) {
          const imageId = typeof result.imageId === "string" && result.imageId
            ? result.imageId
            : crypto.randomUUID();
          const resourceRef = { id: imageId, domain: { kind: "image" as const } };
          const previousProgress = latestGenerateSvgProgress(state, toolCallId);
          const resultProgress = generateSvgProgressFromResult(result);
          const doneProgress = resultProgress
            ? {
                ...resultProgress,
                elapsedMs: previousProgress?.elapsedMs ?? resultProgress.elapsedMs,
                rawKb: previousProgress?.rawKb ?? resultProgress.rawKb,
              }
            : resultProgress;
          const doneSpec = generateSvgToolCallSpec(
            toolCallId,
            args,
            { kind: "done" },
            { kind: "producedResource", data: { resourceRef } },
            doneProgress,
          );
          yield resourceUpserted({
            resourceRef,
            displayName: typeof result.alt === "string" ? result.alt : "文档插图",
            summary: typeof result.alt === "string" ? result.alt : "",
            mime: "image/svg+xml",
            byteLen: typeof result.svg === "string" ? result.svg.length : null,
            createdAt: new Date().toISOString(),
            metadata: {
              src: result.src,
              width: typeof result.width === "number" ? result.width : null,
              height: typeof result.height === "number" ? result.height : null,
            },
          });
          yield toolCallUpdated(agentMessageId, toolCallId, doneSpec);
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, doneSpec);
          outcome.producedVisibleFrame = true;
          // 生成与放置解耦:本工具只产出图片资产(已 resourceUpserted 注册 + 返回 src),
          // 不再自动 splice 进文档。把图插入文档由模型在后续【显式调 editDraft 的 insertBlock】
          // 完成——走统一编辑通路(blockId 寻址、可审阅 diff、历史可见),而不是这里偷偷改文档。
        } else {
          const reason =
            (result && typeof result.error === "string" && result.error) ||
            "SVG 生成失败";
          const previousProgress = latestGenerateSvgProgress(state, toolCallId);
          const failSpec = generateSvgToolCallSpec(
            toolCallId,
            args,
            { kind: "failed", data: { retriable: false, reason } },
            null,
            {
              stage: "failed",
              elapsedMs: previousProgress?.elapsedMs ?? 0,
              rawKb: previousProgress?.rawKb ?? 0,
              message: reason,
              error: reason,
              src: previousProgress?.src ?? null,
              width: previousProgress?.width ?? null,
              height: previousProgress?.height ?? null,
              partialSvg: null,
            },
          );
          yield toolCallUpdated(agentMessageId, toolCallId, failSpec);
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, failSpec);
          outcome.producedVisibleFrame = true;
        }

        yield* transitionAndProjectDocState(
          state,
          restoreDocStateAfterGenerateSvg(generateSvgPreviousDocState, state),
          "generate_svg_finished",
          { mode: "normalize" },
        );
        generateSvgPreviousDocState = null;
      } else if (toolName === "readImage") {
        const result = toolResult as Record<string, unknown> | null;
        const ok = result && typeof result === "object" && result.ok === true;
        const text = result && typeof result.text === "string" ? result.text : "";
        const error = result && typeof result.error === "string" ? result.error : "";
        const reason = error || "图片识别失败";
        const origMsg = state.chatHistory.find((m) =>
          m.parts.some((p) => p.kind === "toolCall" && p.data.id === toolCallId),
        );
        const origPart = origMsg?.parts.find(
          (p) => p.kind === "toolCall" && p.data.id === toolCallId,
        );
        const resultPreview = ok ? text : reason;
        if (origMsg && origPart && origPart.kind === "toolCall") {
          const doneSpec: ToolCallSpec = {
            ...origPart.data,
            status: ok
              ? { kind: "done" }
              : { kind: "failed", data: { retriable: true, reason } },
            result: { kind: "genericText", data: resultPreview },
          };
          updateToolCallInChatHistory(state, origMsg.id, toolCallId, doneSpec);
          yield toolCallUpdated(origMsg.id, toolCallId, doneSpec);
        } else {
          const thumbnailSrc = typeof args.image === "string"
            ? await thumbnailSrcForImageInput(args.image)
            : null;
          const spec = readImageToolCallSpec(
            toolCallId,
            args,
            ok
              ? { kind: "done" }
              : { kind: "failed", data: { retriable: true, reason } },
            { kind: "genericText", data: resultPreview },
            thumbnailSrc,
          );
          const seq = nextSeq(state, agentMessageId);
          const tcPart: MessagePart = { kind: "toolCall", data: spec };
          yield chatMessageAppended(agentMessageId, seq, tcPart);
          ensureAgentChatHistoryMessage(state, agentMessageId);
          appendPartToChatHistory(state, agentMessageId, tcPart);
          yield toolCallUpdated(agentMessageId, toolCallId, spec);
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
        }
        outcome.producedVisibleFrame = true;
      } else if (toolName === "webSearch") {
        const result = isRecord(toolResult) ? toolResult : {};
        const rawItems = Array.isArray(result.items) ? result.items : [];
        const cardItems: ResearchCardBody["items"] = rawItems.map((raw) => {
          const item = isRecord(raw) ? raw : {};
          const status = item.status === "skipped" ? "skipped" : "done";
          return {
            url: typeof item.url === "string" ? item.url : "",
            title: typeof item.title === "string" ? item.title : "",
            status,
            wordCount: status === "done" && typeof item.wordCount === "number"
              ? item.wordCount
              : null,
          };
        });
        const okCount = cardItems.filter((item) => item.status === "done").length;
        const skippedCount = cardItems.filter((item) => item.status === "skipped").length;
        const body: ResearchCardBody = {
          query: typeof result.query === "string" ? result.query : String(args.query ?? ""),
          phase: "done",
          items: cardItems,
          total: cardItems.length,
          fetchedCount: okCount + skippedCount,
          okCount,
          skippedCount,
        };
        const spec = researchCardToolCallSpec(
          toolCallId,
          body,
          { kind: "done" },
          {
            kind: "genericText",
            data: `检索完成:${cardItems.length} 个来源,${okCount} 已抓取,${skippedCount} 略过`,
          },
        );
        yield toolCallUpdated(agentMessageId, toolCallId, spec);
        updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
        outcome.producedVisibleFrame = true;

        for (const raw of rawItems) {
          if (!isRecord(raw)) continue;
          const text = typeof raw.text === "string" ? raw.text : "";
          if (!text || isExtractionFailureText(text) || !isSubstantiveContent(text)) continue;
          const url = typeof raw.url === "string" && raw.url ? raw.url : null;
          const entry = { text, sourceUrl: url, fileId: null };
          if (url) extractedTexts.set(url, entry);
          const title = typeof raw.title === "string" ? raw.title.trim() : "";
          if (title) extractedTexts.set(title, entry);
          extractionEventsThisTurn.push(entry);
        }
      } else if (DRAFT_MUTATION_TOOL_NAMES.has(toolName)) {
        const result = toolResult as Record<string, unknown> | null;
        const ok = result && typeof result === "object" && result.ok === true;
        const hasUsableArgs = hasUsableDraftMutationArgs(toolName, args);
        const mutationStats = ok ? currentDraftMutationStats(state) : { changed: false, hunkCount: 0 };
        const resultHunkCount = result && typeof result.hunkCount === "number" && Number.isFinite(result.hunkCount)
          ? Math.max(0, Math.floor(result.hunkCount))
          : null;
        const resultChanged = result?.changed === true || (resultHunkCount !== null && resultHunkCount > 0);
        const firstDraftHasContent =
          toolName === "writeDraft" &&
          !docExistedBeforeStream &&
          !!state.docDraftCandidateDoc &&
          pmToPlainText(state.docDraftCandidateDoc).trim().length > 0;
        const draftMutationApplied =
          ok &&
          (resultChanged || mutationStats.changed || firstDraftHasContent);
        const effectiveOk = ok && (toolName !== "editDraft" || draftMutationApplied);
        if (ok) {
          sawValidDraftMutation = draftMutationApplied || sawValidDraftMutation;
          if (draftMutationApplied) {
            state._directionChangeAskedSinceLastWrite = false;
            requestContext?.set("directionChangeAskedSinceLastWrite", false);
          }
          if (toolName === "writeDraft" && draftMutationApplied) {
            docGeneratedThisTurn = true;
            docJustGenerated = !docExistedBeforeStream;
            // 首稿"写完回显光标书写"触发补回:writeDraft 赋一个
            // generation id,使回合末 settleDraftCandidate 走 generation_finished(而非
            // 裸 documentSnapshotWritten)。generation_finished 经前端
            // pmDocToViewDocumentSnapshot 必带 pmDoc,stagePresentationRunForViewDoc
            // 才能据 finalDoc 播整篇 native presentation 打字机。仅生成路径(writeDraft)
            // 设置,editDraft 不置 docGeneratedThisTurn,编辑审查动效不受影响。
            if (activeDocGenerationToolCallId === toolCallId && activeDocGenerationId) {
              settledDocGenerationId = activeDocGenerationId;
              settledDocGenerationLastSeq = activeDocGenerationLastSeq;
            } else {
              settledDocGenerationId = `gen-${streamId}-${toolCallId}`;
              settledDocGenerationLastSeq = 0;
            }
          }
          if (state.docDraftCandidateDoc) {
            requestContext?.set("doc", state.docDraftCandidateDoc);
            requestContext?.set("legacySections", state.docDraftCandidateSections ?? []);
          }
        } else if (!hasUsableArgs) {
          sawFailedDraftMutationInput = true;
          logger.warn("Draft mutation failed with empty or invalid arguments", {
            toolName,
            toolCallId,
            streamId,
            sessionId: state.sessionId,
          });
        }
        const reason = effectiveOk
          ? draftMutationFailureReason(toolName, args, result)
          : ok && toolName === "editDraft"
            ? "editDraft 执行完成但没有产生任何文档差异，本轮文档尚未变化。"
            : draftMutationFailureReason(toolName, args, result);
        // writeDraft 用迷你草稿卡定格(最终字数+验收状态),其余草稿工具维持通用药丸
        const doneBody: ToolCallSpec["body"] =
          toolName === "writeDraft"
            ? {
                kind: "writeDraftCard",
                data: writeDraftCardFromResult(args, toolResult, effectiveOk === true),
              }
            : { kind: "generic", data: { argsJson: redactedSerializedText(args) } };
        const spec: ToolCallSpec = {
          id: toolCallId,
          name: toolName,
          render: { kind: "chatInline" },
          status: effectiveOk
            ? { kind: "done" }
            : { kind: "failed", data: { retriable: true, reason } },
          body: doneBody,
          result: effectiveOk
            ? { kind: "genericText", data: toolResultCardSummary(toolResult) }
            : null,
        };
        // 顺序铁律(回归 candidate-diff-flow"settle 前中断也已写入"):先同步把工具卡状态
        // 落进 chatHistory(done/failed),再 await 写 draft_candidate row,最后才 yield done 帧
        // ——消费方一看到 done 帧就停,此刻 row 必须已写、chatHistory 状态必须已 done。
        // GLM/anthropic 若没有前置帧建过卡,这里补建可见 part(openai 正常路径已有 part 走 else)。
        if (!hasToolCallPart(agentMessageId, toolCallId)) {
          const tcSeq = nextSeq(state, agentMessageId);
          const tcPart: MessagePart = { kind: "toolCall", data: spec };
          ensureAgentChatHistoryMessage(state, agentMessageId);
          appendPartToChatHistory(state, agentMessageId, tcPart);
          yield chatMessageAppended(agentMessageId, tcSeq, tcPart);
        } else {
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
        }
        if (effectiveOk) {
          try {
            await saveDraftCandidateCheckpoint({ state, streamId, toolCallId });
          } catch (err) {
            logger.error("Failed to persist draft candidate checkpoint", {
              sessionId: state.sessionId,
              docId: state.docId,
              toolName,
              toolCallId,
              streamId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          schedulePersist(state, `tool_result:${toolName}`).catch((err) =>
            logger.error("Persist after draft mutation tool-result failed", { error: String(err) }),
          );
        }
        yield toolCallUpdated(agentMessageId, toolCallId, spec);
        outcome.producedVisibleFrame = true;
      } else {
        // 通用工具:校验只决定"药丸"渲染成功/失败,绝不能短路掉后面的副作用
        // (parseFile 缓存全文 / storeMaterial 落库 / 抓取类截图持久化)。这些副作用
        // 是核心业务,必须随工具结果落地——之前合并把校验的 continue 排到副作用块之前,
        // 导致 parseFile 校验未过(测试用例 thin result 无 metadata)就跳过了缓存,
        // 引用接力断链、storeMaterial 正文为空。改成 if/else:校验失败只标失败药丸,
        // 不 continue,继续往下跑副作用块。
        const missingFields = missingGenericToolResultFields(toolName, toolResult);
        if (missingFields.length > 0) {
          const reason = `工具 ${toolName} 结果缺少必填字段: ${missingFields.join(", ")}`;
          logger.error("Generic tool result validation failed", {
            toolName,
            toolCallId,
            missingFields,
            streamId,
          });
          const failSpec: ToolCallSpec = {
            id: toolCallId,
            name: toolName,
            render: { kind: "chatInline" },
            status: { kind: "failed", data: { retriable: false, reason } },
            body: { kind: "generic", data: { argsJson: redactedSerializedText(args) } },
            result: { kind: "genericText", data: reason },
          };
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, failSpec);
          if (toolName === "readDraft") {
            schedulePersist(state, "tool_result:readDraft").catch((err) =>
              logger.error("Persist after readDraft failed result failed", { error: String(err) }),
            );
          }
          yield toolCallUpdated(agentMessageId, toolCallId, failSpec);
        } else {
          // execute_command 定格成友好终端卡(命令+结果+退出码,详情折叠);
          // run_js/run_python 复用同款卡(脚本+输出可展开),与沙箱命令卡样式统一;其余走通用药丸。
          const commandCard =
            toolName === "mastra_workspace_execute_command"
              ? commandCardFromResult(args, toolResult, toolResultOk)
              : toolName === "run_js" || toolName === "run_python"
                ? scriptCardFromResult(toolName, args, toolResult, toolResultOk)
                : null;
          const doneBody: ToolCallSpec["body"] = commandCard
            ? { kind: "commandCard", data: commandCard }
            : { kind: "generic", data: { argsJson: redactedSerializedText(args) } };
          // 非命令通用工具(run_js/run_python 等)若返回 ok:false / success:false,
          // 卡片必须渲成失败态,不能硬编码 done(R10 codex-3:失败结果被误渲完成)。
          const doneStatus: ToolCallStatus = commandCard
            ? commandCardStatusFromCard(commandCard)
            : toolResultOk
              ? { kind: "done" }
              : { kind: "failed", data: { retriable: false, reason: redactedToolResultPreview(toolResult) } };
          const doneSpec: ToolCallSpec = {
            id: toolCallId,
            name: toolName,
            render: { kind: "chatInline" },
            status: doneStatus,
            body: doneBody,
            result: { kind: "genericText", data: toolResultCardSummary(toolResult) },
          };
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, doneSpec);
          if (toolName === "readDraft") {
            schedulePersist(state, "tool_result:readDraft").catch((err) =>
              logger.error("Persist after readDraft result failed", { error: String(err) }),
            );
          }
          yield toolCallUpdated(agentMessageId, toolCallId, doneSpec);
        }
      }

      const isArticleScrapeTool =
        toolName === "fetchArticle" || toolName === "scrapeWithBrowser";
      // 抓取成功必出一张卡:有截图/og图走图片卡;无图或图片下载失败降级为
      // 文字卡(src=null,前端渲染简化样式)——卡片是用户对账"N 个链接都抓回来没有"
      // 的唯一可见凭据,不能因为站点没配 og:image 就静默消失。
      if (isArticleScrapeTool) {
        const scrapeText = typeof toolResult.text === "string" ? (toolResult.text as string) : "";
        const scrapeOk = scrapeText !== "" && !isExtractionFailureText(scrapeText);
        if (scrapeOk) {
          let imageSrc: string | null = null;
          let imageLabel = "";
          try {
            const hasShot =
              typeof toolResult.screenshotSrc === "string" && toolResult.screenshotSrc;
            const hasOg = typeof toolResult.ogImageUrl === "string" && toolResult.ogImageUrl;
            if (hasShot) {
              imageSrc = toolResult.screenshotSrc as string;
              imageLabel = "网页截图";
            } else if (hasOg) {
              const imageId = crypto.randomUUID();
              const imageDir = join(UPLOADS_BASE, imageId);
              await mkdir(imageDir, { recursive: true });
              const image = {
                ...(await downloadRemoteImage(toolResult.ogImageUrl as string)),
                label: "网页缩略图",
              };
              await writeFile(join(imageDir, image.filename), image.buffer);
              imageSrc = "/api/v1/files/" + imageId + "/" + image.filename;
              imageLabel = image.label;
            }
          } catch (error) {
            // 图片失败不再吞掉整张卡:降级文字卡,保证抓取可见
            logger.error("Failed to persist article scrape image, falling back to text card", {
              toolName,
              error: String(error),
            });
            imageSrc = null;
          }

          const imagePart: MessagePart = {
            kind: "image",
            data: {
              label: (toolResult.title as string) || imageLabel || "网页内容",
              src: imageSrc,
              srcKind: "url",
              sourceUrl: (toolResult.sourceUrl as string) || null,
              width: null,
              height: null,
            },
          };
          const seq = nextSeq(state, agentMessageId);
          yield chatMessageAppended(agentMessageId, seq, imagePart);
          appendPartToChatHistory(state, agentMessageId, imagePart);
        }
      }

      if (toolName === "parseFile") {
        // 解析失败不进正文缓存，直接确定性落一条 error material，避免依赖模型再调 storeMaterial。
        const failure = parseFileFailureFromResult(toolResult);
        if (failure) {
          upsertParseFileErrorMaterial(args, failure);
        } else if (typeof toolResult.text === "string") {
          // 缓存 parseFile 的真全文(按 filename),供后续 storeMaterial 引用。
          const binding = resolveParseFileBinding(args);
          const fn = args.filename as string | undefined;
          const t = toolResult.text as string;
          const entry = { text: t, sourceUrl: null, fileId: binding.fileId };
          if (fn) extractedTexts.set(fn, entry);
          extractionEventsThisTurn.push(entry);
        }
      }
      // 抓取类(fetchArticle/scrapeWithBrowser)的正文也缓存,供 storeMaterial 引用。
      // 抓取结果没有天然 filename,按 url 和返回的 title 建键(模型存素材时常用标题当 filename)。
      // 抓取失败文本、以及"空洞壳"(只有标题+导航/分享控件、无实质正文,如动态渲染未出正文的页面)
      // 都按解析失败处理:不缓存、不绑定、不落库——避免污染绑定池,也兜住直接落库
      //(用户要求:落库的链接正文必须是干净、有实质的,空洞内容视为解析失败)。
      if (isArticleScrapeTool && typeof toolResult.text === "string") {
        const t = toolResult.text as string;
        if (!isExtractionFailureText(t) && isSubstantiveContent(t)) {
          const url = typeof args.url === "string" ? (args.url as string) : null;
          const entry = { text: t, sourceUrl: url, fileId: null };
          if (url) extractedTexts.set(url, entry);
          const scrapedTitle =
            typeof toolResult.title === "string" ? (toolResult.title as string).trim() : "";
          if (scrapedTitle) extractedTexts.set(scrapedTitle, entry);
          extractionEventsThisTurn.push(entry);
        }
      }

      // 落库自带字段守卫(materialId 必须是字符串):副作用只看自己真正需要的字段,
      // 与上面的通用药丸校验解耦——结果残缺(缺 materialId)就不落库,避免 undefined 键素材。
      if (
        toolName === "storeMaterial" &&
        toolResult.stored &&
        typeof toolResult.materialId === "string"
      ) {
        const matId = toolResult.materialId as string;
        const now = new Date().toISOString();
        const existing = state.materials.get(matId);
        // 正文走引用,不再从参数取(模型不再传 text)。绑定顺序:
        // ① filename/title 精确命中 → ② 去扩展名宽容匹配(模型常丢/改扩展名)
        // → ③ 本轮恰好一次提取时才允许"最近一次"兜底——多次提取时绝不兜底,
        //   宁可空正文也不把别的素材正文绑过来(p08 串台根治,fail-closed)。
        const fnArg = typeof args.filename === "string" ? (args.filename as string) : undefined;
        const titleArg = typeof args.title === "string" ? (args.title as string) : undefined;
        const stripExt = (s: string) => s.replace(/\.[A-Za-z0-9]+$/, "").trim();
        let bound =
          (fnArg ? extractedTexts.get(fnArg) : undefined) ??
          (titleArg ? extractedTexts.get(titleArg) : undefined);
        if (!bound && fnArg) {
          const want = stripExt(fnArg);
          for (const [key, entry] of extractedTexts) {
            if (stripExt(key) === want) {
              bound = entry;
              break;
            }
          }
        }
        if (!bound) {
          // 多条搜索/抓取结果:键没精确对上时,按抓取顺序绑"下一条尚未被消费的提取"。
          // 每条提取只用一次(consumedExtractions),多条素材各得各的正文、不串台,也不会因
          // fail-closed 而全部空正文被拒——根治"agent 搜索存的素材,素材区看不到"。
          bound = extractionEventsThisTurn.find((e) => !consumedExtractions.has(e));
        }
        if (bound) consumedExtractions.add(bound);
        const matchedFileId =
          (typeof args.fileId === "string" && args.fileId ? args.fileId : null) ??
          fileIdMap.get(args.filename as string) ??
          bound?.fileId ??
          existing?.fileId ??
          null;
        const fullText = bound?.text ?? "";
        // 落库硬门:正文为空 → 拒绝;网页抓取类(有 sourceUrl)再加"实质内容"门——
        // 只有导航/分享控件拼出的空洞壳按解析失败处理,不落库(空洞壳通常已在缓存阶段
        // 被 isSubstantiveContent 拦掉、bound 为空,这里是兜底的二道防线)。
        // [Error]/[Unsupported] 占位前缀绝不能当正文存入素材库。
        const hollowWebContent = !!bound?.sourceUrl && !isSubstantiveContent(fullText);
        const placeholderContent = isExtractionFailureText(fullText);
        if (fullText.trim().length === 0 || hollowWebContent || placeholderContent) {
          logger.warn(
            "storeMaterial: 正文为空/空洞或解析失败,拒绝落库",
            {
              sessionId: state.sessionId,
              filename: args.filename,
              hollowWebContent,
              placeholderContent,
              extractionsThisTurn: extractionEventsThisTurn.length,
              cachedKeys: Array.from(extractedTexts.keys()).slice(0, 10),
            },
          );
          const reason = hollowWebContent
            ? "网页正文未能有效提取（疑似动态渲染，或仅有标题+导航/分享控件的空洞页），按解析失败处理，未写入素材库。"
            : "素材正文为空或未能有效提取（空内容或不支持的格式），按解析失败处理，未写入素材库。请确认文件内容或换成支持格式后重新上传。";
          const failSpec: ToolCallSpec = {
            id: toolCallId,
            name: toolName,
            render: { kind: "chatInline" },
            status: { kind: "failed", data: { retriable: false, reason } },
            body: { kind: "generic", data: { argsJson: redactedSerializedText(args) } },
            result: { kind: "genericText", data: reason },
          };
          updateToolCallInChatHistory(state, agentMessageId, toolCallId, failSpec);
          yield toolCallUpdated(agentMessageId, toolCallId, failSpec);
          continue;
        }

        const material: Material = {
          id: matId,
          filename: args.filename as string,
          mimeType: args.mimeType as string,
          text: fullText,
          summary: (args.summary as string | undefined) ?? null,
          fileId: matchedFileId,
          metadata: {
            pages: (args.pages as number | null) ?? null,
            wordCount: fullText.length,
            title: (args.title as string | null) ?? null,
            // 抓取类素材记来源 URL,供溯源(上传类为 null)
            sourceUrl: bound?.sourceUrl ?? null,
            parseState: "ready",
            parseError: null,
          },
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        };
        state.materials.set(matId, material);

        const metadataWithFileId = {
          ...material.metadata,
          fileId: matchedFileId,
          updatedAt: material.updatedAt,
        };

        if (existing) {
          materialFrames.push(
            resourceUpdated(matId, material.summary, metadataWithFileId),
          );
        } else {
          materialFrames.push(
            resourceUpserted({
              resourceRef: { id: matId, domain: { kind: "file" } },
              displayName: material.filename,
              summary: material.summary ?? "",
              mime: material.mimeType,
              byteLen: material.text.length,
              createdAt: material.createdAt,
              metadata: metadataWithFileId,
            }),
          );
        }

        // Persist after material stored
        schedulePersist(state, "tool_result:storeMaterial").catch((err) =>
          logger.error("Persist after storeMaterial failed", { error: String(err) }),
        );
      } else if (toolName === "summarizeMaterial") {
        const matId = args.materialId as string;
        const mat = state.materials.get(matId);
        if (mat) {
          mat.summary = args.summary as string;
          mat.updatedAt = new Date().toISOString();
          const metadataWithFileId = {
            ...mat.metadata,
            fileId: mat.fileId,
            updatedAt: mat.updatedAt,
          };
          materialFrames.push(
            resourceUpdated(matId, mat.summary, metadataWithFileId),
          );
        }
      }

      continue;
    }
  }

  // Stream ended — clear same-turn flag
  docJustGenerated = false;
  void docJustGenerated;
  // Stream ended naturally — emit deferred material frames
  for (const frame of materialFrames) {
    yield frame;
  }

  if (!wasSuspended && generateSvgPreviousDocState) {
    yield* transitionAndProjectDocState(
      state,
      restoreDocStateAfterGenerateSvg(generateSvgPreviousDocState, state),
      "generate_svg_finished",
      { mode: "normalize" },
    );
    generateSvgPreviousDocState = null;
  }

  // 兜底(GLM 等 v3 stream 可能漏 tool-result → docGeneratedThisTurn 没置):
  // writeDraft 流式产出过 + execute 已设好 candidate,就视为已生成,确保整篇落盘。
  if (!docGeneratedThisTurn && sawWriteDraftProgress && state.docDraftCandidateDoc) {
    docGeneratedThisTurn = true;
    if (!settledDocGenerationId) settledDocGenerationId = `gen-${streamId}-fallback`;
    logger.info("[settle] writeDraft 兜底落盘(tool-result 未置 docGeneratedThisTurn)", {
      streamId,
      candidateBlocks: state.docDraftCandidateDoc.content.length,
    });
  }

  if (!wasSuspended && !abortController.signal.aborted) {
    const settled = yield* settleDraftCandidate({
      state,
      agentMessageId,
      streamId,
      runId,
      wholeDocument: docGeneratedThisTurn,
      requestContext,
      generationId: settledDocGenerationId,
      generationLastSeq: settledDocGenerationLastSeq,
      emitGenerationEvent: docGeneratedThisTurn,
    });
    validPatchCount = settled.hunkCount;
    finalDocumentSnapshotEmitted = settled.docWritten;
    if (settled.hunkCount > 0 || settled.docWritten) {
      outcome.producedVisibleFrame = true;
      outcome.sawToolCall = true;
      outcome.sawSideEffectToolCall = true;
    }
  } else if (!wasSuspended && abortController.signal.aborted) {
    clearDraftConfirmationState(state);
    await documentDraftRepo.clear(state.docId).catch((err) => {
      logger.warn("Failed to clear aborted draft candidate", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    yield* syncContentAndProjectDocState(state, "agent_turn_finally_idle");
  }

  for (const [toolCallId, span] of toolIoSpans) {
    endToolIoSpan(span, { status: "streamEndedWithoutResult" }, false, {
      status: "streamEndedWithoutResult",
      toolCallId,
    });
  }
  toolIoSpans.clear();

  const durationMs = Date.now() - streamStartTime;
  logger.info("Agent stream completed", {
    streamId,
    sessionId: state.sessionId,
    durationMs,
    validPatchCount,
  });

  if (validPatchCount === 0 && state.suggestions.size === 0) {
    console.warn(`[stream ${streamId}] Stream ended with no accepted patch suggestions.`);
  } else {
    console.warn(`[stream ${streamId}] Stream ended with acceptedSuggestionCount=${validPatchCount}, pendingSuggestionCount=${state.suggestions.size}`);
  }
  const streamWasUserAborted = isUserAbortSignal(abortController.signal) && !sawIdleTimeout;
  outcome.streamWasUserAborted = streamWasUserAborted;

  // EE②/SS:本轮出现过破损 editDraft 入参(深 children 括号记账错→坍缩成 {}→解析失败),
  // 且没有任何一次有效改动 / patch,即使模型已写了"已为你加上小标题"之类正文(accumulatedText
  // 非空),也强制追加失败提示 + draftingFailed 帧。去掉旧的 `!accumulatedText` 前提——它会让
  // "模型既吐破损 editDraft、又谎称已改"的轮次跳过兜底,用户看不到任何错误(SS 谎称已改的放大点)。
  // 这里以 sawFailedDraftMutationInput 为门:纯对话轮(本轮无 editDraft 工具调用)绝不进入此分支,
  // 不会被误伤。
  if (
    !wasSuspended &&
    !streamWasUserAborted &&
    sawFailedDraftMutationInput &&
    !sawValidDraftMutation &&
    validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    yield appendVisibleStreamErrorText(state, agentMessageId, DRAFT_TOOL_JSON_RETRY_NOTICE);
    outcome.producedVisibleFrame = true;
    accumulatedText += DRAFT_TOOL_JSON_RETRY_NOTICE;
    logger.warn("Draft mutation input failure — emitted retry notice", {
      sessionId: state.sessionId,
      streamId,
      hadAccumulatedText: accumulatedText.length > DRAFT_TOOL_JSON_RETRY_NOTICE.length,
    });
    yield draftingFailedFrame(streamId, DRAFT_TOOL_JSON_RETRY_NOTICE);
  }

  // 空响应兜底（WE-002 精神）：流自然跑完（非 suspend）却零产出——无正文、
  // 本轮无任何工具调用、无 patch（含历史待审 patch）——说明模型静默返回了空结果
  // （如偶发 0-token / finishReason=stop 无内容）。此前这种轮次完全静默：不写
  // 任何 chatMessageAppended、不发 draftingFailed、accumulatedText 为空连
  // llm_response span 都跳过，前端只看到 stream end、零反馈。这里补一条可见的
  // 可重试提示，对齐草稿工具失败反馈精神。
  // 与 finally 的交互（非冲突）：若空轮发生时仍保留 askUser overlay（如 askUser
  // resume 后模型零产出且未调用任何工具），本分支发 draftingFailed，随后
  // runAgentTurn/handleResume 的 finally 再经投影层解锁回
  // init/draft。二者帧种不同、互补（用户既看到错误、输入框又解锁），不是双重失败。
  // 用户主动中止时由 abortAndCleanupTurn / 前端 toast 收口；这里不能再把
  // 中止轮归类为模型空响应或步数耗尽。内部 idle timeout 仍保留下面的超时文案。
  const endedAfterToolCallsWithoutText =
    !wasSuspended &&
    !streamWasUserAborted &&
    sawAnyToolCall &&
    lastStepFinishReason === "tool-calls" &&
    !sawTextAfterLastTool;

  if (
    endedAfterToolCallsWithoutText &&
    (accumulatedText || sawValidDraftMutation || validPatchCount > 0 || state.suggestions.size > 0)
  ) {
    const stepNotice = sawIdleTimeout
      ? docGeneratedThisTurn || finalDocumentSnapshotEmitted
        ? "草稿已生成，但最后一步被中断，还没收尾。回复“继续”我接着处理。"
        : "本轮有一步长时间无响应被中断，尚未完成最后收尾，回复“继续”我接着处理。"
      : docGeneratedThisTurn || finalDocumentSnapshotEmitted
        ? "草稿已生成，本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。"
        : "本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。";
    const visibleText = accumulatedText ? `\n\n${stepNotice}` : stepNotice;
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: visibleText } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    accumulatedText += visibleText;
    logger.warn("Tool-call-finished turn ended without final text — emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
      lastStepFinishReason,
      docGeneratedThisTurn,
      finalDocumentSnapshotEmitted,
      sawValidDraftMutation,
    });
  } else if (
    !wasSuspended &&
    !streamWasUserAborted &&
    !accumulatedText &&
    !sawAnyToolCall &&
    !sawToolHeartbeat &&
    validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const emptyNotice =
      "模型这一轮没有返回任何内容，可能是临时异常。请重试，或换个说法再发一次。";
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: emptyNotice } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    accumulatedText += emptyNotice;
    logger.warn("Empty agent turn — emitted user-visible fallback notice", {
      sessionId: state.sessionId,
      streamId,
    });
    yield draftingFailedFrame(streamId, emptyNotice);
  } else if (
    !wasSuspended &&
    !streamWasUserAborted &&
    !accumulatedText &&
    sawAnyToolCall &&
    sawNonUiToolCall &&
    !outcome.producedVisibleFrame &&
    !sawValidDraftMutation &&
    validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    // 步数耗尽兜底:本轮调了工具但没产出最终回复、没生成文档、没 patch、未挂起 ——
    // 通常是达到单轮步数上限(maxSteps)被截断(浏览器交互最常见)。此前完全静默 →
    // 前端卡在最后一个工具调用。补一条可见可重试提示,与空轮兜底同精神。
    const stepNotice = sawIdleTimeout
      ? "本轮有一步工具长时间无响应被中断,还没给出最终回复。回复“继续”我接着完成,或重试。"
      : "做了多步操作，但还没给出最终结果。回复“继续”我接着完成，或重试。";
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: stepNotice } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    accumulatedText += stepNotice;
    logger.warn("Tool-only turn with no final text — likely hit maxSteps, emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
    });
    yield draftingFailedFrame(streamId, stepNotice);
  }

  // Store accumulated text
  if (accumulatedText) {
    state.messages.push({
      role: "assistant",
      content: accumulatedText,
    });
  }

  // Clear suspend state only if the stream was NOT suspended.
  // When suspended, the return; inside the tool-call-suspended handler
  // should prevent reaching this point. This guard is a safety net for
  // edge cases where the ReadableStream iterator cleanup allows the
  // for-await loop to exit normally despite the return.
  if (!wasSuspended) {
    if (!hasActiveSuspension(state)) {
      clearSuspension(state);
      state._askUserSuspendCount = 0;
    }

    // Layer ③（阶段2）— 模型 response 正文落库。只在流正常跑完（非 suspend）且
    // 已聚合出完整回复时记一条 llm_response span，补齐框架 model_generation span
    // 永不记录回复正文的缺口。一次性记录，不逐 text-delta；纯工具调用回合
    // accumulatedText 为空，helper 内已防御跳过。runId 来自本次 stream 处理参数。
    recordLlmResponseSpan(state, streamId, runId, accumulatedText);
  } else {
    logger.warn("processAgentStream post-loop reached despite wasSuspended=true — runId preserved", {
      streamId,
      sessionId: state.sessionId,
      runId: state.runId,
    });
  }
  // Persist at stream end
  await schedulePersist(state, "stream_end").catch((err) =>
    logger.error("Persist after stream end failed", { error: String(err) }),
  );
  return outcome;
  } finally {
    if (restoreStreamIdOnExit) {
      state.streamId = previousStreamId;
    }
  }
}
