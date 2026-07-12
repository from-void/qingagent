import type { BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import { documentDraftRepo } from "../db/documentDraftRepo.js";
import { mastra } from "../mastra.js";
import { AGENT_MAX_STEPS } from "./agentLimits.js";
import { recordLlmResponseSpan } from "./agentSpans.js";
import type { AgentStreamTurnContext, ProcessOutcome } from "./agentStreamTurnContext.js";
import { clearDraftConfirmationState } from "./draftScratch.js";
import {
  restoreDocStateAfterGenerateSvg,
  syncContentAndProjectDocState,
  transitionAndProjectDocState,
} from "./docStateSync.js";
import { DRAFT_TOOL_JSON_RETRY_NOTICE } from "./draftToolArgs.js";
import { chatMessageAppended } from "./frames.js";
import { settleDraftCandidate } from "./settleDraftCandidate.js";
import {
  appendPartToChatHistory,
  clearSuspension,
  hasActiveSuspension,
  nextSeq,
} from "./sessionState.js";
import {
  appendVisibleStreamErrorText,
  draftingFailedFrame,
  isUserAbortSignal,
} from "./streamErrors.js";
import { schedulePersist } from "./threadPersistence.js";
import { endToolIoSpan } from "./toolIoSpans.js";

const logger = mastra.getLogger();

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
  context.docJustGenerated = false;
  for (const frame of context.materialFrames) yield frame;

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

  if (!context.wasSuspended && !abortController.signal.aborted) {
    const settled = yield* settleDraftCandidate({
      state,
      agentMessageId,
      streamId,
      runId,
      wholeDocument: context.docGeneratedThisTurn,
      requestContext,
      generationId: context.settledDocGenerationId,
      generationLastSeq: context.settledDocGenerationLastSeq,
      emitGenerationEvent: context.docGeneratedThisTurn,
    });
    context.validPatchCount = settled.hunkCount;
    context.finalDocumentSnapshotEmitted = settled.docWritten;
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

  for (const [toolCallId, span] of context.toolIoSpans) {
    endToolIoSpan(span, { status: "streamEndedWithoutResult" }, false, {
      status: "streamEndedWithoutResult",
      toolCallId,
    });
  }
  context.toolIoSpans.clear();
  logger.info("Agent stream completed", {
    streamId,
    sessionId: state.sessionId,
    durationMs: Date.now() - context.streamStartTime,
    validPatchCount: context.validPatchCount,
  });
  if (context.validPatchCount === 0 && state.suggestions.size === 0) {
    console.warn(`[stream ${streamId}] Stream ended with no accepted patch suggestions.`);
  } else {
    console.warn(
      `[stream ${streamId}] Stream ended with acceptedSuggestionCount=${context.validPatchCount}, pendingSuggestionCount=${state.suggestions.size}`,
    );
  }

  const streamWasUserAborted =
    isUserAbortSignal(abortController.signal) && !context.sawIdleTimeout;
  outcome.streamWasUserAborted = streamWasUserAborted;
  if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    context.sawFailedDraftMutationInput &&
    !context.sawValidDraftMutation &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    yield appendVisibleStreamErrorText(
      state,
      agentMessageId,
      DRAFT_TOOL_JSON_RETRY_NOTICE,
    );
    outcome.producedVisibleFrame = true;
    context.accumulatedText += DRAFT_TOOL_JSON_RETRY_NOTICE;
    logger.warn("Draft mutation input failure — emitted retry notice", {
      sessionId: state.sessionId,
      streamId,
      hadAccumulatedText:
        context.accumulatedText.length > DRAFT_TOOL_JSON_RETRY_NOTICE.length,
    });
    yield draftingFailedFrame(streamId, DRAFT_TOOL_JSON_RETRY_NOTICE);
  }

  const endedAfterToolCallsWithoutText =
    !context.wasSuspended &&
    !streamWasUserAborted &&
    context.sawAnyToolCall &&
    context.lastStepFinishReason === "tool-calls" &&
    !context.sawTextAfterLastTool;
  if (
    endedAfterToolCallsWithoutText &&
    (context.accumulatedText ||
      context.sawValidDraftMutation ||
      context.validPatchCount > 0 ||
      state.suggestions.size > 0)
  ) {
    const stepNotice = context.sawIdleTimeout
      ? context.docGeneratedThisTurn || context.finalDocumentSnapshotEmitted
        ? "草稿已生成，但最后一步被中断，还没收尾。回复“继续”我接着处理。"
        : "本轮有一步长时间无响应被中断，尚未完成最后收尾，回复“继续”我接着处理。"
      : context.docGeneratedThisTurn || context.finalDocumentSnapshotEmitted
        ? "草稿已生成，本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。"
        : "本轮在工具调用后达到步数上限，尚未完成最后收尾，回复“继续”我接着处理。";
    const visibleText = context.accumulatedText ? `\n\n${stepNotice}` : stepNotice;
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: visibleText } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    context.accumulatedText += visibleText;
    logger.warn("Tool-call-finished turn ended without final text — emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
      lastStepFinishReason: context.lastStepFinishReason,
      docGeneratedThisTurn: context.docGeneratedThisTurn,
      finalDocumentSnapshotEmitted: context.finalDocumentSnapshotEmitted,
      sawValidDraftMutation: context.sawValidDraftMutation,
    });
  } else if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    !context.accumulatedText &&
    !context.sawAnyToolCall &&
    !context.sawToolHeartbeat &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const emptyNotice =
      "模型这一轮没有返回任何内容，可能是临时异常。请重试，或换个说法再发一次。";
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: emptyNotice } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    context.accumulatedText += emptyNotice;
    logger.warn("Empty agent turn — emitted user-visible fallback notice", {
      sessionId: state.sessionId,
      streamId,
    });
    yield draftingFailedFrame(streamId, emptyNotice);
  } else if (
    !context.wasSuspended &&
    !streamWasUserAborted &&
    !context.accumulatedText &&
    context.sawAnyToolCall &&
    context.sawNonUiToolCall &&
    !outcome.producedVisibleFrame &&
    !context.sawValidDraftMutation &&
    context.validPatchCount === 0 &&
    state.suggestions.size === 0
  ) {
    const stepNotice = context.sawIdleTimeout
      ? "本轮有一步工具长时间无响应被中断,还没给出最终回复。回复“继续”我接着完成,或重试。"
      : "做了多步操作，但还没给出最终结果。回复“继续”我接着完成，或重试。";
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: stepNotice } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    context.accumulatedText += stepNotice;
    logger.warn("Tool-only turn with no final text — likely hit maxSteps, emitted fallback notice", {
      sessionId: state.sessionId,
      streamId,
      maxSteps: AGENT_MAX_STEPS,
    });
    yield draftingFailedFrame(streamId, stepNotice);
  }

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
