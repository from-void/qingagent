import type { AskUserSliderSpec, BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { MAX_CONSECUTIVE_ASKUSER_SUSPENDS } from "./agentLimits.js";
import { recordLlmSuspendedResponseSpan } from "./agentSpans.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { findAskUserToolCallSpecInChatHistory } from "./askUserAnswerMessage.js";
import { clearDraftConfirmationState } from "../doc-engine/draftScratch.js";
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
import {
  askUserRenderModeFromSpec,
  buildAskUserToolCallSpec,
  type AskUserPurposeKind,
} from "./toolCards.js";
import { markToolIoSpanSuspended } from "./toolIoSpans.js";

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
    context.wasSuspended = true;
    clearDraftConfirmationState(state);
    requestContext?.set("legacySections", state.legacySections);
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

  context.wasSuspended = true;
  clearDraftConfirmationState(state);
  requestContext?.set("legacySections", state.legacySections);
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

  if (context.accumulatedText) {
    state.messages.push({ role: "assistant", content: context.accumulatedText });
  }
  for (const frame of context.materialFrames) yield frame;
  await schedulePersist(state, "tool_call_suspended").catch((error) =>
    logger.error("Persist after tool-call-suspended failed", { error: String(error) }),
  );
  return "terminal";
}
