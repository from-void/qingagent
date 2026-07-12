import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import {
  appendAskUserAnswerMessageIfMissing,
  findAskUserToolCallSpecInChatHistory,
  normalizeAskUserAnswers,
} from "./askUserAnswerMessage.js";
import { idleDocState, normalizeTargetDocState } from "./docStateTransitions.js";
import { transitionAndProjectDocState } from "./docStateSync.js";
import { toolCallUpdated } from "./frames.js";
import {
  isDirectionReset,
  isPlanDraftTool,
  isQuestionnaireTool,
} from "./questionnaireTools.js";
import {
  clearSuspension,
  terminalizeAskUserToolCall,
  updateToolCallInChatHistory,
} from "./sessionState.js";
import { schedulePersist } from "./threadPersistence.js";
import type {
  ToolResultContext,
  ToolResultHandlerResult,
} from "./agentStreamToolResultTypes.js";

const logger = mastra.getLogger();

export async function* handleQuestionnaireToolResult(
  input: ToolResultContext,
): AsyncGenerator<BridgeFrame, ToolResultHandlerResult> {
  const { turn, toolName, toolCallId, toolResult } = input;
  if (!isQuestionnaireTool(toolName)) return "unhandled";
  const { state, requestContext, outcome } = turn;
  if (toolResult.rejected === true) {
    const reason =
      typeof toolResult.reason === "string"
        ? toolResult.reason
        : "没有可展示的有效问题";
    const terminalized = terminalizeAskUserToolCall(state, toolCallId, reason);
    if (terminalized) {
      yield toolCallUpdated(
        terminalized.messageId,
        terminalized.toolCallId,
        terminalized.spec,
      );
    }
    clearSuspension(state);
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
    outcome.producedVisibleFrame = true;
    return "short-circuit";
  }

  const answers = normalizeAskUserAnswers(toolResult);
  const hasAnswers = Object.keys(answers).length > 0;
  const directionResetFromContext = requestContext?.get("isDirectionReset");
  const wasDirectionReset =
    typeof directionResetFromContext === "boolean"
      ? directionResetFromContext
      : isDirectionReset(state);
  if (hasAnswers && isPlanDraftTool(toolName)) state._askUserCompleted = true;
  void findAskUserToolCallSpecInChatHistory(
    state.chatHistory,
    toolCallId,
  );
  if (hasAnswers && isPlanDraftTool(toolName) && wasDirectionReset) {
    state._directionChangeAskedSinceLastWrite = true;
    requestContext?.set("directionChangeAskedSinceLastWrite", true);
  }

  const originalMessage = state.chatHistory.find((message) =>
    message.parts.some(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    ),
  );
  if (originalMessage) {
    const originalPart = originalMessage.parts.find(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    );
    if (originalPart?.kind === "toolCall") {
      const doneSpec: ToolCallSpec = {
        ...originalPart.data,
        status: { kind: "done" },
        result: hasAnswers
          ? { kind: "askUserAnswers", data: answers }
          : { kind: "genericText", data: "已提交" },
      };
      yield toolCallUpdated(originalMessage.id, toolCallId, doneSpec);
      updateToolCallInChatHistory(state, originalMessage.id, toolCallId, doneSpec);
      if (
        hasAnswers &&
        appendAskUserAnswerMessageIfMissing(state, toolCallId, answers, doneSpec)
      ) {
        schedulePersist(state, "tool_result:askUser_answer_message").catch((error) =>
          logger.error("Persist after askUser answer message failed", {
            error: String(error),
          }),
        );
      }
    }
  } else if (
    hasAnswers &&
    appendAskUserAnswerMessageIfMissing(state, toolCallId, answers, null)
  ) {
    schedulePersist(state, "tool_result:askUser_answer_message").catch((error) =>
      logger.error("Persist after askUser answer message failed", { error: String(error) }),
    );
  }
  return "handled";
}
