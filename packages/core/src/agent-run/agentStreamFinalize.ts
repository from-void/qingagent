import {
  sanitizeVisibleText,
  type BridgeFrame,
  type ChatMessage,
  type MessagePart,
  type ToolCallSpec,
} from "@qingagent/contract-ts";
import { documentDraftRepo } from "@qingagent/db";
import { getPmContentHash, pmToPlainText } from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import { AGENT_MAX_STEPS } from "./agentLimits.js";
import { recordLlmResponseSpan } from "./agentSpans.js";
import type { AgentStreamTurnContext, ProcessOutcome } from "./agentStreamTurnContext.js";
import {
  clearDraftConfirmationState,
  currentPmDoc,
  hasNonEmptyCanonicalBase,
} from "../doc-engine/draftScratch.js";
import {
  restoreDocStateAfterGenerateSvg,
  syncContentAndProjectDocState,
  transitionAndProjectDocState,
} from "../doc-engine/docStateSync.js";
import { DRAFT_TOOL_JSON_RETRY_NOTICE } from "../doc-engine/draftToolArgs.js";
import {
  chatMessageAdded,
  chatMessageAppended,
  newId,
  nowIso,
  toolCallUpdated,
} from "./frames.js";
import { settleDraftCandidate } from "../doc-engine/settleDraftCandidate.js";
import {
  appendPartToChatHistory,
  clearSuspension,
  hasActiveSuspension,
  nextSeq,
} from "../session/sessionState.js";
import {
  draftingFailedFrame,
  isUserAbortSignal,
  USER_ABORT_REASON,
} from "./streamErrors.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { endToolIoSpan } from "./toolIoSpans.js";
import { recomputeUserVisibleOutput } from "./agentStreamVisibility.js";
import {
  flushSensitiveReviewReasoning,
  flushSensitiveReviewText,
} from "./sensitiveReviewMasking.js";
import { createAnnotationGroupsReadyFrame } from "../session/annotationGroups.js";

const logger = mastra.getLogger();
const ANNOTATION_MUTATION_NO_PATCH_NOTICE = "未能生成修改，可再试或手动编辑。";

function isAnnotationMutationRequest(userText: string): boolean {
  return /(?:^|\n)\s*按批注修改[：:]/u.test(userText);
}

function markTerminalFailure(
  outcome: ProcessOutcome,
  reason: string,
  retriable = true,
): void {
  if (outcome.terminalOutcome.kind === "cancelled") return;
  outcome.terminalOutcome = {
    kind: "error",
    details: {
      reason,
      retriable,
      category: "unknown",
      userMessage: reason,
      action: retriable ? "retry" : "none",
    },
  };
}

function failPendingToolCallsAfterTimeout(
  context: AgentStreamTurnContext,
): Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> {
  const pendingIds = new Set(context.toolIoSpans.keys());
  const updates: Array<{ messageId: string; toolCallId: string; spec: ToolCallSpec }> = [];
  if (pendingIds.size === 0) return updates;

  for (const message of context.state.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index]!;
      if (
        part.kind !== "toolCall" ||
        !pendingIds.has(part.data.id) ||
        (part.data.status.kind !== "pending" && part.data.status.kind !== "running")
      ) {
        continue;
      }
      const reason = "工具长时间未返回结果，本轮已中止";
      const spec: ToolCallSpec = {
        ...part.data,
        status: { kind: "failed", data: { retriable: true, reason } },
        result: part.data.result ?? { kind: "genericText", data: reason },
      };
      message.parts[index] = { kind: "toolCall", data: spec };
      updates.push({ messageId: message.id, toolCallId: spec.id, spec });
    }
  }
  return updates;
}

export async function* finalizeAgentStream(
  context: AgentStreamTurnContext,
): AsyncGenerator<BridgeFrame, ProcessOutcome> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    requestContext,
    abortController,
    outcome,
  } = context;
  let finalTextMessageId = agentMessageId;
  const appendFinalVisibleText = (body: string): BridgeFrame => {
    const accumulatedTextIsInternal =
      /\S/u.test(context.accumulatedText) &&
      sanitizeVisibleText(context.accumulatedText) === null;

    if (
      finalTextMessageId === agentMessageId &&
      accumulatedTextIsInternal
    ) {
      // 前端与持久化恢复都会合并相邻 text part；若把兜底继续追加到纯内部文本
      // 后面，整块仍会被过滤。另起一条 agent 消息，保证内部块隐藏而兜底可见。
      const detachedBody = body.trimStart();
      const message: ChatMessage = {
        id: newId(),
        role: { kind: "agent" },
        ts: nowIso(),
        parts: [{ kind: "text", data: { body: detachedBody } }],
        chips: null,
      };
      state.chatHistory.push(message);
      finalTextMessageId = message.id;
      context.accumulatedText = detachedBody;
      recomputeUserVisibleOutput(context);
      return chatMessageAdded(message);
    }

    const seq = nextSeq(state, finalTextMessageId);
    const textPart: MessagePart = { kind: "text", data: { body } };
    appendPartToChatHistory(state, finalTextMessageId, textPart);
    context.accumulatedText += body;
    recomputeUserVisibleOutput(context);
    return chatMessageAppended(finalTextMessageId, seq, textPart);
  };
  for (const frame of flushSensitiveReviewReasoning(context)) yield frame;
  const sensitiveReviewTextFrame = flushSensitiveReviewText(context);
  if (sensitiveReviewTextFrame) yield sensitiveReviewTextFrame;
  yield* context.annotationPreview.clear();
  context.docJustGenerated = false;
  for (const frame of context.materialFrames) yield frame;
  const replacedAnnotationOrigins = [
    ...(state._annotationOriginsReplacedThisTurn ?? []),
  ];
  const replacedAnnotationOriginSet = new Set(replacedAnnotationOrigins);
  const annotationGroupIdsBeforeSettle = new Set(
    state.annotationGroups.map((group) => group.id),
  );
  const replacedAnnotationGroupIdsBeforeSettle = new Set(
    state.annotationGroups
      .filter((group) => replacedAnnotationOriginSet.has(group.origin))
      .map((group) => group.id),
  );

  if (!context.wasSuspended && context.generateSvgPreviousDocState) {
    yield* transitionAndProjectDocState(
      state,
      restoreDocStateAfterGenerateSvg(context.generateSvgPreviousDocState, state),
      "generate_svg_finished",
      { mode: "normalize" },
    );
    context.generateSvgPreviousDocState = null;
  }

  if (
    !context.docGeneratedThisTurn &&
    context.sawWriteDraftProgress &&
    state.docDraftCandidateDoc
  ) {
    context.docGeneratedThisTurn = true;
    context.settledDocGenerationId ??= `gen-${streamId}-fallback`;
    logger.info("[settle] writeDraft 兜底落盘(tool-result 未置 docGeneratedThisTurn)", {
      streamId,
      candidateBlocks: state.docDraftCandidateDoc.content.length,
    });
  }

  const hasUsableDraftCandidateFromThisTurn =
    !!state.docDraftCandidateDoc &&
    pmToPlainText(state.docDraftCandidateDoc).trim().length > 0 &&
    (context.sawValidDraftMutation || context.docGeneratedThisTurn);
  const shouldCommitEmptyBaseAsFirstDraft =
    hasUsableDraftCandidateFromThisTurn &&
    context.sawValidDraftMutation &&
    !hasNonEmptyCanonicalBase(
      state,
      state.docDraftBaseDoc ?? currentPmDoc(state),
    );

  const explicitlyStopped =
    abortController.signal.reason === USER_ABORT_REASON ||
    abortController.signal.reason === "globalStop";

  // idle timeout 和显式停止都要保住已完整交付给用户的可用资产；新消息抢占仍丢弃
  // 旧轮候选，避免旧结果越权覆盖新意图。
  if (
    !context.wasSuspended &&
    (
      !abortController.signal.aborted ||
      (
        hasUsableDraftCandidateFromThisTurn &&
        (context.sawIdleTimeout || explicitlyStopped)
      )
    )
  ) {
    const settled = yield* settleDraftCandidate({
      state,
      agentMessageId,
      streamId,
      runId,
      wholeDocument:
        context.docGeneratedThisTurn || shouldCommitEmptyBaseAsFirstDraft,
      requestContext,
      generationId: context.settledDocGenerationId,
      generationLastSeq: context.settledDocGenerationLastSeq,
      emitGenerationEvent: context.docGeneratedThisTurn,
    });
    context.validPatchCount = settled.hunkCount;
    context.finalDocumentSnapshotEmitted = settled.docWritten;
    if (settled.docWritten && state.doc) {
      outcome.finalDocument = {
        version: state.docVersion,
        contentHash: getPmContentHash(state.doc),
        doc: state.doc,
      };
    }
    if (settled.hunkCount > 0 || settled.docWritten) {
      outcome.producedVisibleFrame = true;
      outcome.sawToolCall = true;
      outcome.sawSideEffectToolCall = true;
    }
  } else if (!context.wasSuspended && abortController.signal.aborted) {
    clearDraftConfirmationState(state);
    await documentDraftRepo.clear(state.docId).catch((error) => {
      logger.warn("Failed to clear aborted draft candidate", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    yield* syncContentAndProjectDocState(state, "agent_turn_finally_idle");
  }

  if (
    !context.wasSuspended &&
    !abortController.signal.aborted &&
    replacedAnnotationOrigins.length > 0
  ) {
    yield { kind: "annotationPreviewCleared", data: {} };
    yield createAnnotationGroupsReadyFrame(state, replacedAnnotationOrigins);
    outcome.producedVisibleFrame = true;
  }

  if (context.sawIdleTimeout) {
    for (const update of failPendingToolCallsAfterTimeout(context)) {
      yield toolCallUpdated(update.messageId, update.toolCallId, update.spec);
      outcome.producedVisibleFrame = true;
    }
  }
  for (const [toolCallId, span] of context.toolIoSpans) {
    endToolIoSpan(span, { status: "streamEndedWithoutResult" }, false, {
      status: "streamEndedWithoutResult",
      toolCallId,
    });
  }
  context.toolIoSpans.clear();
  logger.info("Agent stream patch summary", {
    sessionId: state.sessionId,
    streamId,
    validPatchCount: context.validPatchCount,
    pendingReviewSuggestionCount: state.suggestions.size,
  });

  const streamWasUserAborted =
    isUserAbortSignal(abortController.signal) && !context.sawIdleTimeout;
  outcome.streamWasUserAborted = streamWasUserAborted;
  if (streamWasUserAborted) {
    outcome.terminalOutcome = { kind: "cancelled" };
  }
  recomputeUserVisibleOutput(context);
  const hadUserVisibleOutputBeforeFallbacks = context.hasUserVisibleOutput;
  const accumulatedTextHadNonWhitespaceBeforeFallbacks =
    /\S/u.test(context.accumulatedText);
  let visibilityInvariantFallbackEmitted = false;
  if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    outcome.terminalOutcome.kind === "ok" &&
    isAnnotationMutationRequest(context.userText) &&
    context.validPatchCount === 0
  ) {
    const visibleText = context.accumulatedText
      ? `\n\n${ANNOTATION_MUTATION_NO_PATCH_NOTICE}`
      : ANNOTATION_MUTATION_NO_PATCH_NOTICE;
    yield appendFinalVisibleText(visibleText);
    outcome.producedVisibleFrame = true;
    logger.warn("Annotation mutation ended without a validated patch", {
      sessionId: state.sessionId,
      streamId,
      sawAnyToolCall: context.sawAnyToolCall,
      sawValidDraftMutation: context.sawValidDraftMutation,
      pendingReviewSuggestionCount: state.suggestions.size,
    });
    yield draftingFailedFrame(streamId, ANNOTATION_MUTATION_NO_PATCH_NOTICE);
    markTerminalFailure(outcome, ANNOTATION_MUTATION_NO_PATCH_NOTICE);
  }
  // 破损 draft 参数必须显式报错；失败工具卡或模型谎称已修改的正文虽已可见，
  // 都不能替代可重试提示与 draftingFailed 终态。
  if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    outcome.terminalOutcome.kind === "ok" &&
    context.sawFailedDraftMutationInput &&
    !context.sawValidDraftMutation &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const hadAccumulatedText = context.accumulatedText.length > 0;
    yield appendFinalVisibleText(DRAFT_TOOL_JSON_RETRY_NOTICE);
    outcome.producedVisibleFrame = true;
    logger.warn("Draft mutation input failure — emitted retry notice", {
      sessionId: state.sessionId,
      streamId,
      hadAccumulatedText,
    });
    yield draftingFailedFrame(streamId, DRAFT_TOOL_JSON_RETRY_NOTICE);
    markTerminalFailure(outcome, DRAFT_TOOL_JSON_RETRY_NOTICE);
  }

  const endedAfterToolCallsWithoutText =
    !context.wasSuspended &&
    !streamWasUserAborted &&
    context.sawAnyToolCall &&
    context.lastStepFinishReason === "tool-calls" &&
    !context.sawTextAfterLastTool;
  const completedStepCount = Math.max(0, context.stepIndex + 1);
  const reachedStepLimit =
    context.lastStepFinishReason === "tool-calls" &&
    completedStepCount >= AGENT_MAX_STEPS;
  const draftPreservedThisTurn =
    context.finalDocumentSnapshotEmitted ||
    state.docVersion > context.docVersionBeforeStream ||
    context.validPatchCount > 0;
  const timedOutWithSettledSuggestions =
    context.sawIdleTimeout &&
    context.sawValidDraftMutation &&
    context.validPatchCount > 0;
  if (timedOutWithSettledSuggestions) {
    const settleNotice = `已生成${context.validPatchCount}处修改，请查看。`;
    const visibleText = context.accumulatedText
      ? `\n\n${settleNotice}`
      : settleNotice;
    yield appendFinalVisibleText(visibleText);
    outcome.producedVisibleFrame = true;
    logger.info("Idle-timeout turn settled with draft suggestions", {
      sessionId: state.sessionId,
      streamId,
      validPatchCount: context.validPatchCount,
      pendingSuggestionCount: state.suggestions.size,
    });
  } else if (
    endedAfterToolCallsWithoutText &&
    (context.accumulatedText ||
      context.sawValidDraftMutation ||
      context.validPatchCount > 0 ||
      state.suggestions.size > 0)
  ) {
    const stepNotice = context.sawAutomaticLengthRevisionTimeout
      ? draftPreservedThisTurn
        ? "自动精简已超时，已保留精简前的完整草稿；需要的话可以稍后再精简。"
        : "自动精简已超时，且未产出可用草稿，请重试或稍后再试。"
      : context.sawIdleTimeout
      ? draftPreservedThisTurn
        ? "已保留本轮生成的部分草稿，但最后一步被中断，还没收尾。回复“继续”我接着处理。"
        : "草稿生成长时间无响应并已超时，未产出可用草稿，请重试或稍后再试。"
      : reachedStepLimit && (context.docGeneratedThisTurn || context.finalDocumentSnapshotEmitted)
        ? "草稿已生成，本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。"
        : reachedStepLimit
          ? "本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。"
          : "本轮在工具调用后中断，尚未完成最后收尾，回复“继续”我接着处理。";
    const visibleText = context.accumulatedText ? `\n\n${stepNotice}` : stepNotice;
    yield appendFinalVisibleText(visibleText);
    outcome.producedVisibleFrame = true;
    logger.warn("Tool-call-finished turn ended without final text — emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
      completedStepCount,
      reachedStepLimit,
      lastStepFinishReason: context.lastStepFinishReason,
      docGeneratedThisTurn: context.docGeneratedThisTurn,
      finalDocumentSnapshotEmitted: context.finalDocumentSnapshotEmitted,
      docVersionBeforeStream: context.docVersionBeforeStream,
      docVersionAfterStream: state.docVersion,
      sawValidDraftMutation: context.sawValidDraftMutation,
    });
  } else if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    !context.sawAnyToolCall &&
    !context.sawToolHeartbeat &&
    !context.hasUserVisibleOutput &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const emptyNotice =
      "模型这一轮没有返回任何内容，可能是临时异常。请重试，或换个说法再发一次。";
    yield appendFinalVisibleText(emptyNotice);
    outcome.producedVisibleFrame = true;
    logger.warn("Empty agent turn — emitted user-visible fallback notice", {
      sessionId: state.sessionId,
      streamId,
    });
    yield draftingFailedFrame(streamId, emptyNotice);
    markTerminalFailure(outcome, emptyNotice);
  } else if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    context.sawAnyToolCall &&
    context.sawNonUiToolCall &&
    !context.hasUserVisibleOutput &&
    !context.sawValidDraftMutation &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const stepNotice = context.sawIdleTimeout
      ? "本轮长时间没有新的进展，已中断，尚未给出最终回复。回复“继续”我接着完成，或重试。"
      : "做了多步操作，但还没给出最终结果。回复“继续”我接着完成，或重试。";
    yield appendFinalVisibleText(stepNotice);
    outcome.producedVisibleFrame = true;
    logger.warn("Tool-only turn with no final text — likely hit maxSteps, emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
    });
    yield draftingFailedFrame(streamId, stepNotice);
    markTerminalFailure(outcome, stepNotice);
  }

  const annotationGroupIdsAfterSettle = new Set(
    state.annotationGroups.map((group) => group.id),
  );
  const allUnlocatedGroupCount = [...annotationGroupIdsBeforeSettle]
    .filter((groupId) => !annotationGroupIdsAfterSettle.has(groupId))
    .length;
  const createdUnlocatedGroupCount = [...replacedAnnotationGroupIdsBeforeSettle]
    .filter((groupId) => !annotationGroupIdsAfterSettle.has(groupId))
    .length;
  if (
    !context.wasSuspended
    && !streamWasUserAborted
    && (replacedAnnotationOrigins.length > 0 || allUnlocatedGroupCount > 0)
  ) {
    const survivingGroupCount = replacedAnnotationOrigins.length > 0
      ? state.annotationGroups.filter((group) => replacedAnnotationOriginSet.has(group.origin)).length
      : state.annotationGroups.length;
    const unlocatedGroupCount = replacedAnnotationOrigins.length > 0
      ? createdUnlocatedGroupCount
      : allUnlocatedGroupCount;
    if (unlocatedGroupCount > 0) {
      logger.warn("Annotation groups became unlocated while settling agent stream", {
        sessionId: state.sessionId,
        streamId,
        survivingGroupCount,
        unlocatedGroupCount,
      });
    }
  }

  if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    !context.hasUserVisibleOutput
  ) {
    visibilityInvariantFallbackEmitted = true;
    const invariantNotice =
      "本轮没有得到可展示的结果。请重试，或换个说法再发一次。";
    yield appendFinalVisibleText(invariantNotice);
    outcome.producedVisibleFrame = true;
    logger.warn("Agent turn visibility invariant emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
    });
  }

  logger.info("Agent stream completed", {
    streamId,
    sessionId: state.sessionId,
    durationMs: Date.now() - context.streamStartTime,
    validPatchCount: context.validPatchCount,
    wasSuspended: context.wasSuspended,
    streamWasUserAborted,
    hasUserVisibleOutput: context.hasUserVisibleOutput,
    hadUserVisibleOutputBeforeFallbacks,
    visibilityInvariantFallbackEmitted,
    producedVisibleFrame: outcome.producedVisibleFrame,
    accumulatedTextHasNonWhitespace: /\S/u.test(context.accumulatedText),
    accumulatedTextHadNonWhitespaceBeforeFallbacks,
    sawAnyToolCall: context.sawAnyToolCall,
    sawNonUiToolCall: context.sawNonUiToolCall,
    sawToolHeartbeat: context.sawToolHeartbeat,
    sawIdleTimeout: context.sawIdleTimeout,
    chunkTypeCounts: Object.fromEntries(
      [...context.chunkTypeCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  });

  outcome.finishReason = context.lastStepFinishReason;
  outcome.finalText = context.accumulatedText;
  if (context.accumulatedText) {
    state.messages.push({ role: "assistant", content: context.accumulatedText });
  }
  if (!context.wasSuspended) {
    if (!hasActiveSuspension(state)) {
      clearSuspension(state);
      state._askUserSuspendCount = 0;
    }
    recordLlmResponseSpan(state, streamId, runId, context.accumulatedText);
  } else {
    logger.warn("processAgentStream post-loop reached despite wasSuspended=true — runId preserved", {
      streamId,
      sessionId: state.sessionId,
      runId: state.runId,
    });
  }
  await schedulePersist(state, "stream_end").catch((error) =>
    logger.error("Persist after stream end failed", { error: String(error) }),
  );
  return outcome;
}
