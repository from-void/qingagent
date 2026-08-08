import type { AskUserSliderSpec, BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { MAX_CONSECUTIVE_ASKUSER_SUSPENDS } from "./agentLimits.js";
import { recordLlmSuspendedResponseSpan } from "./agentSpans.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { findAskUserToolCallSpecInChatHistory } from "./askUserAnswerMessage.js";
import { clearDraftConfirmationState } from "../doc-engine/draftScratch.js";
import { settleDraftCandidate } from "../doc-engine/settleDraftCandidate.js";
import { idleDocState, normalizeTargetDocState } from "../doc-engine/docStateTransitions.js";
import {
  syncContentAndProjectDocState,
  transitionAndProjectDocState,
} from "../doc-engine/docStateSync.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  toolCallUpdated,
} from "./frames.js";
import {
  isPlanDraftTool,
  isQuestionnaireTool,
  questionnaireRenderMode,
} from "./questionnaireTools.js";
import {
  appendPartToChatHistory,
  clearSuspension,
  nextSeq,
  recordSuspension,
  terminalizeAskUserToolCall,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import { toSuspensionToolName } from "../session/sessionTools.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { flushSensitiveReviewText } from "./sensitiveReviewMasking.js";
import {
  askUserRenderModeFromSpec,
  buildAskUserToolCallSpec,
  type AskUserPurposeKind,
} from "./toolCards.js";
import { markToolIoSpanSuspended } from "./toolIoSpans.js";
import { draftingFailedFrame } from "./streamErrors.js";

const logger = mastra.getLogger();

function recordSuspendedStepResponse(
  context: AgentStreamTurnContext,
  toolName: string,
  toolCallId: string,
): void {
  if (context.activeStepIndex === null) return;
  recordLlmSuspendedResponseSpan(
    context.state,
    context.streamId,
    context.runId,
    context.activeStepIndex,
    {
      toolName,
      toolCallId,
      modelEndedAt: context.lastModelChunkAt,
    },
  );
  context.activeStepIndex = null;
}

export type SuspensionEventResult = "unhandled" | "handled" | "terminal";

/** writeDraft 后同轮挂起时先沿正式 settle 链收口，避免候选被挂起清理吞掉。 */
async function* settleWriteDraftBeforeSuspension(
  context: AgentStreamTurnContext,
): AsyncGenerator<BridgeFrame, boolean> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    requestContext,
    abortController,
    outcome,
  } = context;
  if (
    !context.docGeneratedThisTurn ||
    !context.sawValidDraftMutation ||
    !state.docDraftCandidateDoc ||
    abortController.signal.aborted
  ) {
    return false;
  }

  const candidateDoc = state.docDraftCandidateDoc;
  const baseDoc = state.docDraftBaseDoc;
  const baseVersion = state.docDraftBaseVersion;
  const restoreCandidate = (): void => {
    if (state.docDraftCandidateDoc) return;
    state.docDraftCandidateDoc = candidateDoc;
    state.docDraftBaseDoc = baseDoc;
    state.docDraftBaseVersion = baseVersion;
    requestContext?.set("doc", candidateDoc);
  };

  try {
    const settled = yield* settleDraftCandidate({
      state,
      agentMessageId,
      streamId,
      runId,
      wholeDocument: true,
      requestContext,
      generationId: context.settledDocGenerationId,
      generationLastSeq: context.settledDocGenerationLastSeq,
      emitGenerationEvent: true,
    });
    context.validPatchCount = settled.hunkCount;
    context.finalDocumentSnapshotEmitted = settled.docWritten;
    if (settled.hunkCount > 0 || settled.docWritten) {
      outcome.producedVisibleFrame = true;
      outcome.sawToolCall = true;
      outcome.sawSideEffectToolCall = true;
      logger.info("[settle] writeDraft 候选已在挂起前收口", {
        streamId,
        hunkCount: settled.hunkCount,
        docWritten: settled.docWritten,
        docVersion: state.docVersion,
      });
      return true;
    }
    restoreCandidate();
    return true;
  } catch (error) {
    restoreCandidate();
    logger.error("[settle] writeDraft 挂起前收口异常，已保留候选", {
      sessionId: state.sessionId,
      streamId,
      error: error instanceof Error ? error.message : String(error),
    });
    yield draftingFailedFrame(
      streamId,
      "草稿已生成，但挂起前落定失败；候选已保留，请提交问卷后重试。",
    );
    outcome.producedVisibleFrame = true;
    return true;
  }
}

export async function* handleSuspensionEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, SuspensionEventResult> {
  if (chunk.type !== "tool-call-suspended") return "unhandled";
  const {
    state,
    streamId,
    runId,
    requestContext,
    agentMessageId,
    outcome,
  } = context;
  const payload = chunk.payload;
  outcome.sawToolCall = true;
  if (!isQuestionnaireTool(payload.toolName)) {
    outcome.sawSideEffectToolCall = true;
    state._askUserSuspendCount = 0;
  }
  const suspensionToolName = toSuspensionToolName(payload.toolName);
  if (!suspensionToolName) {
    logger.error("Unsupported suspended tool ignored", {
      toolName: payload.toolName,
      toolCallId: payload.toolCallId,
      streamId,
    });
    return "handled";
  }

  if (state.runId !== null && state.toolCallId === payload.toolCallId) {
    logger.info("Duplicate suspension replay detected — preserving pending run", {
      toolName: payload.toolName,
      runId: state.runId,
      toolCallId: payload.toolCallId,
    });
    yield* settleWriteDraftBeforeSuspension(context);
    context.wasSuspended = true;
    recordSuspension(state, {
      streamId,
      runId: state.runId,
      toolCallId: payload.toolCallId,
      toolName: suspensionToolName,
    });
    recordSuspendedStepResponse(context, payload.toolName, payload.toolCallId);
    markToolIoSpanSuspended(context.toolIoSpans.get(payload.toolCallId));
    context.toolIoSpans.delete(payload.toolCallId);
    return "terminal";
  }

  const abandonedAskUser = state._abandonedAskUserToolCallIds;
  if (abandonedAskUser?.has(payload.toolCallId)) {
    abandonedAskUser.delete(payload.toolCallId);
    clearSuspension(state);
    state._askUserSuspendCount = 0;
    recordSuspendedStepResponse(context, payload.toolName, payload.toolCallId);
    markToolIoSpanSuspended(context.toolIoSpans.get(payload.toolCallId));
    context.toolIoSpans.delete(payload.toolCallId);
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
    await schedulePersist(state, "askUser:abandoned_running_suspend").catch((error) =>
      logger.error("Persist after abandoned running askUser suspend failed", {
        error: String(error),
      }),
    );
    return "terminal";
  }

  if (isQuestionnaireTool(payload.toolName)) {
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
      await schedulePersist(state, "askUser:abandoned_suspend").catch((error) =>
        logger.error("Persist after abandoned askUser suspend failed", {
          error: String(error),
        }),
      );
      recordSuspendedStepResponse(context, payload.toolName, payload.toolCallId);
      return "terminal";
    }
  } else {
    state._askUserSuspendCount = 0;
  }

  const draftSettledBeforeSuspension = yield* settleWriteDraftBeforeSuspension(context);
  context.wasSuspended = true;
  if (!draftSettledBeforeSuspension) clearDraftConfirmationState(state);
  recordSuspension(state, {
    streamId,
    runId,
    toolCallId: payload.toolCallId,
    toolName: suspensionToolName,
  });
  recordSuspendedStepResponse(context, payload.toolName, payload.toolCallId);
  markToolIoSpanSuspended(context.toolIoSpans.get(payload.toolCallId));
  context.toolIoSpans.delete(payload.toolCallId);
  state.previousDocState = state.docState;

  if (isQuestionnaireTool(payload.toolName)) {
    if (isPlanDraftTool(payload.toolName)) state._askUserAsked = true;
    const suspendData = payload.suspendPayload as {
      id: string;
      purpose?: AskUserPurposeKind;
      source: string | null;
      rationale: string | null;
      questions: Array<{
        id: string;
        header?: string | null;
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
    const existingRenderMode = askUserRenderModeFromSpec(
      findAskUserToolCallSpecInChatHistory(state.chatHistory, payload.toolCallId),
    );
    const renderMode = existingRenderMode ?? questionnaireRenderMode(payload.toolName);
    logger.info("askUser render decision", {
      sessionId: state.sessionId,
      purpose: suspendData.purpose,
      renderMode,
      reusedExistingMode: existingRenderMode !== null,
      docState: state.docState.kind,
      questionCount: suspendData.questions.length,
    });
    const spec = buildAskUserToolCallSpec({
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      ...suspendData,
      renderMode,
      purpose: suspendData.purpose,
    });
    if (
      !context.askUserProgressEmitted ||
      context.askUserProgressToolCallId !== payload.toolCallId
    ) {
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
    }
    updateToolCallInChatHistory(state, agentMessageId, payload.toolCallId, spec);
    yield toolCallUpdated(agentMessageId, payload.toolCallId, spec);
    yield* syncContentAndProjectDocState(state, "ask_user_suspended");
  }

  const sensitiveReviewTextFrame = flushSensitiveReviewText(context);
  if (sensitiveReviewTextFrame) yield sensitiveReviewTextFrame;
  if (context.accumulatedText) {
    state.messages.push({ role: "assistant", content: context.accumulatedText });
  }
  for (const frame of context.materialFrames) yield frame;
  await schedulePersist(state, "tool_call_suspended").catch((error) =>
    logger.error("Persist after tool-call-suspended failed", { error: String(error) }),
  );
  return "terminal";
}
