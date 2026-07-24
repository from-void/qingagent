import type {
  BridgeFrame,
  MessagePart,
  ToolCallSpec,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import { pmToPlainText } from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import {
  currentDraftMutationStats,
  saveDraftCandidateCheckpoint,
} from "../doc-engine/draftScratch.js";
import {
  DRAFT_MUTATION_TOOL_NAMES,
  draftMutationFailureReason,
  hasUsableDraftMutationArgs,
} from "../doc-engine/draftToolArgs.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  toolCallUpdated,
} from "./frames.js";
import {
  redactedSerializedText,
  redactedToolResultPreview,
  toolResultCardSummary,
} from "./redaction.js";
import { missingGenericToolResultFields } from "../session/sessionTools.js";
import {
  appendPartToChatHistory,
  nextSeq,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import { schedulePersist } from "../session/threadPersistence.js";
import {
  commandCardFromResult,
  commandCardStatusFromCard,
  scriptCardFromResult,
  writeDraftCardFromResult,
} from "./toolCards.js";
import { hasToolCallPart } from "./agentStreamToolOutput.js";
import type { ToolResultContext } from "./agentStreamToolResultTypes.js";

const logger = mastra.getLogger();

function genericToolFailureReason(
  toolName: string,
  toolResult: Record<string, unknown>,
  rawToolResult: unknown,
): string {
  if (toolName === "parseFile" || toolName === "fetchArticle") {
    for (const field of ["error", "text"] as const) {
      const value = toolResult[field];
      if (typeof value === "string" && value.trim()) {
        return value.replace(/^\s*\[(?:Error|Unsupported)\]\s*/i, "").slice(0, 200);
      }
    }
  }
  return redactedToolResultPreview(rawToolResult);
}

export async function* handleDraftOrGenericToolResult(
  input: ToolResultContext,
): AsyncGenerator<BridgeFrame, void> {
  const {
    turn,
    toolName,
    toolCallId,
    args,
    rawToolResult,
    toolResult,
    toolResultOk,
  } = input;
  const { state, agentMessageId, streamId, requestContext, outcome } = turn;

  if (DRAFT_MUTATION_TOOL_NAMES.has(toolName)) {
    const ok = toolResult.ok === true;
    const hasUsableArgs = hasUsableDraftMutationArgs(toolName, args);
    const mutationStats = ok
      ? currentDraftMutationStats(state)
      : { changed: false, hunkCount: 0 };
    const resultHunkCount =
      typeof toolResult.hunkCount === "number" && Number.isFinite(toolResult.hunkCount)
        ? Math.max(0, Math.floor(toolResult.hunkCount))
        : null;
    const resultChanged =
      toolResult.changed === true || (resultHunkCount !== null && resultHunkCount > 0);
    const firstDraftHasContent =
      toolName === "writeDraft" &&
      !turn.docExistedBeforeStream &&
      !!state.docDraftCandidateDoc &&
      pmToPlainText(state.docDraftCandidateDoc).trim().length > 0;
    const draftMutationApplied =
      ok && (resultChanged || mutationStats.changed || firstDraftHasContent);
    const effectiveOk = ok && (toolName !== "editDraft" || draftMutationApplied);
    if (ok) {
      turn.sawValidDraftMutation = draftMutationApplied || turn.sawValidDraftMutation;
      if (draftMutationApplied) {
        state._directionChangeAskedSinceLastWrite = false;
        requestContext?.set("directionChangeAskedSinceLastWrite", false);
      }
      if (toolName === "writeDraft" && draftMutationApplied) {
        turn.docGeneratedThisTurn = true;
        turn.docJustGenerated = !turn.docExistedBeforeStream;
        if (
          turn.activeDocGenerationToolCallId === toolCallId &&
          turn.activeDocGenerationId
        ) {
          turn.settledDocGenerationId = turn.activeDocGenerationId;
          turn.settledDocGenerationLastSeq = turn.activeDocGenerationLastSeq;
        } else {
          turn.settledDocGenerationId = `gen-${streamId}-${toolCallId}`;
          turn.settledDocGenerationLastSeq = 0;
        }
      }
      if (state.docDraftCandidateDoc) {
        requestContext?.set("doc", state.docDraftCandidateDoc);
        requestContext?.set("legacySections", state.docDraftCandidateSections ?? []);
      }
    } else if (!hasUsableArgs) {
      turn.sawFailedDraftMutationInput = true;
      logger.warn("Draft mutation failed with empty or invalid arguments", {
        toolName,
        toolCallId,
        streamId,
        sessionId: state.sessionId,
      });
    }
    const reason = effectiveOk
      ? draftMutationFailureReason(toolName, args, toolResult)
      : ok && toolName === "editDraft"
        ? "editDraft 执行完成但没有产生任何文档差异，本轮文档尚未变化。"
        : draftMutationFailureReason(toolName, args, toolResult);
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
    if (!hasToolCallPart(turn, agentMessageId, toolCallId)) {
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
    } else {
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    }
    if (effectiveOk) {
      try {
        await saveDraftCandidateCheckpoint({ state, streamId, toolCallId });
      } catch (error) {
        logger.error("Failed to persist draft candidate checkpoint", {
          sessionId: state.sessionId,
          docId: state.docId,
          toolName,
          toolCallId,
          streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      schedulePersist(state, `tool_result:${toolName}`).catch((error) =>
        logger.error("Persist after draft mutation tool-result failed", {
          error: String(error),
        }),
      );
    }
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    return;
  }

  const missingFields = missingGenericToolResultFields(toolName, rawToolResult);
  if (missingFields.length > 0) {
    const reason = `工具 ${toolName} 结果缺少必填字段: ${missingFields.join(", ")}`;
    logger.error("Generic tool result validation failed", {
      toolName,
      toolCallId,
      missingFields,
      streamId,
    });
    const failedSpec: ToolCallSpec = {
      id: toolCallId,
      name: toolName,
      render: { kind: "chatInline" },
      status: { kind: "failed", data: { retriable: false, reason } },
      body: { kind: "generic", data: { argsJson: redactedSerializedText(args) } },
      result: { kind: "genericText", data: reason },
    };
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, failedSpec);
    if (toolName === "readDraft") {
      schedulePersist(state, "tool_result:readDraft").catch((error) =>
        logger.error("Persist after readDraft failed result failed", {
          error: String(error),
        }),
      );
    }
    yield toolCallUpdated(agentMessageId, toolCallId, failedSpec);
    return;
  }

  const commandCard =
    toolName === "mastra_workspace_execute_command"
      ? commandCardFromResult(args, rawToolResult, toolResultOk)
      : toolName === "run_js" || toolName === "run_python"
        ? scriptCardFromResult(toolName, args, rawToolResult, toolResultOk)
        : null;
  const doneBody: ToolCallSpec["body"] = commandCard
    ? { kind: "commandCard", data: commandCard }
    : { kind: "generic", data: { argsJson: redactedSerializedText(args) } };
  const doneStatus: ToolCallStatus = commandCard
    ? commandCardStatusFromCard(commandCard)
    : toolResultOk
      ? { kind: "done" }
      : {
          kind: "failed",
          data: {
            retriable: false,
            reason: genericToolFailureReason(toolName, toolResult, rawToolResult),
          },
        };
  const doneSpec: ToolCallSpec = {
    id: toolCallId,
    name: toolName,
    render: { kind: "chatInline" },
    status: doneStatus,
    body: doneBody,
    result: { kind: "genericText", data: toolResultCardSummary(rawToolResult) },
  };
  updateToolCallInChatHistory(state, agentMessageId, toolCallId, doneSpec);
  if (toolName === "readDraft") {
    schedulePersist(state, "tool_result:readDraft").catch((error) =>
      logger.error("Persist after readDraft result failed", { error: String(error) }),
    );
  }
  yield toolCallUpdated(agentMessageId, toolCallId, doneSpec);
}
