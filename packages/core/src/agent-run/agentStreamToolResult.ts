import type { BridgeFrame } from "@qingagent/contract-ts";
import { extractLoadedToolNamesFromToolSearchResult } from "../agents/toolSearch.js";
import { guardContext } from "../llm/prefixCacheGuard.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { handleDraftOrGenericToolResult } from "./agentStreamDraftResult.js";
import { appendToolTranscriptMessage } from "./frames.js";
import { handleMaterialToolResultSideEffects } from "./agentStreamMaterialResult.js";
import { handleQuestionnaireToolResult } from "./agentStreamQuestionnaireResult.js";
import { isQuestionnaireTool } from "./questionnaireTools.js";
import { handleSpecialToolResult } from "./agentStreamSpecialToolResult.js";
import { PURE_UI_TOOL_NAMES } from "./toolCards.js";
import { buildToolIoEndMetadata, endToolIoSpan } from "./toolIoSpans.js";
import { SESSION_STATE_TOOL_NAMES } from "./agentStreamToolCall.js";
import type { ToolResultContext } from "./agentStreamToolResultTypes.js";
import { isRecord } from "./redaction.js";
import { settleBackgroundCommand } from "./backgroundCommandSettlement.js";
import { normalizeKillProcessResult } from "./backgroundCommandLifecycle.js";
import {
  DUPLICATE_AUTH_CARD_NOOP,
  showQrDuplicatesTrustedAuthCard,
} from "./authCardDedup.js";
import { toolResultSucceededByContract } from "./toolResultStatus.js";

const CONNECTOR_AUTH_START_TOOL_NAMES = new Set([
  "github_auth_start",
  "feishu_auth_start",
  "wechat_auth_start",
]);

export async function* handleToolResultEvent(
  turn: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, boolean> {
  if (chunk.type !== "tool-result") return false;
  const { state, outcome } = turn;
  const { toolName, toolCallId } = chunk.payload;
  if (toolName === "create_annotation_groups") {
    yield* turn.annotationPreview.clear();
  }
  const rawArgs = (chunk.payload.args ?? {}) as Record<string, unknown>;
  const args = { ...(turn.toolCallArgsById.get(toolCallId) ?? {}), ...rawArgs };
  turn.toolCallNameById.set(toolCallId, toolName);
  turn.toolCallArgsById.set(toolCallId, args);
  if (
    toolName === "show_qr" &&
    !args.completedCardId &&
    showQrDuplicatesTrustedAuthCard(args, turn.trustedAuthCards)
  ) {
    turn.suppressedShowQrCallIds.add(toolCallId);
  }
  const payload = chunk.payload as Record<string, unknown>;
  const rawToolResult =
    Object.prototype.hasOwnProperty.call(payload, "result")
      ? payload.result
      : payload.output;
  // Mastra 的宽泛出口允许 result/output 缺失或为标量。分支 handler 统一消费对象，
  // transcript、span 与通用结果摘要仍保留原值，保持旧链路的可观测与展示语义。
  const toolResult = isRecord(rawToolResult) ? rawToolResult : {};
  const toolResultOk = toolResultSucceededByContract(toolName, rawToolResult);

  if (toolName === "search_tools" || toolName === "load_tool") {
    const loadedToolNames = extractLoadedToolNamesFromToolSearchResult(rawToolResult);
    if (loadedToolNames.length > 0) {
      const next = new Set(state._toolSearchLoadedToolNames ?? []);
      for (const loadedToolName of loadedToolNames) next.add(loadedToolName);
      state._toolSearchLoadedToolNames = Array.from(next);
      const prefixGuardContext = guardContext.getStore();
      if (prefixGuardContext?.sessionId === state.sessionId) {
        prefixGuardContext.allowedToolAdditions = Array.from(
          new Set([
            ...(prefixGuardContext.allowedToolAdditions ?? []),
            ...loadedToolNames,
          ]),
        );
      }
    }
  }

  if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
    outcome.sawToolCall = true;
    turn.sawAnyToolCall = true;
    turn.sawTextAfterLastTool = false;
    appendToolTranscriptMessage(state, { toolName, toolCallId, args, result: rawToolResult });
    endToolIoSpan(
      turn.toolIoSpans.get(toolCallId),
      rawToolResult,
      toolResultOk,
      buildToolIoEndMetadata(toolResultOk, rawToolResult),
      toolName,
    );
    turn.toolIoSpans.delete(toolCallId);
    turn.streamingPlaceholders.delete(toolCallId);
    return true;
  }

  outcome.sawToolCall = true;
  turn.sawAnyToolCall = true;
  turn.sawTextAfterLastTool = false;
  if (!PURE_UI_TOOL_NAMES.has(toolName)) turn.sawNonUiToolCall = true;
  if (!isQuestionnaireTool(toolName) && !PURE_UI_TOOL_NAMES.has(toolName)) {
    outcome.sawSideEffectToolCall = true;
  }
  const transcriptResult = turn.suppressedShowQrCallIds.has(toolCallId)
    ? { ok: true, ignored: true, message: DUPLICATE_AUTH_CARD_NOOP }
    : CONNECTOR_AUTH_START_TOOL_NAMES.has(toolName) && isRecord(rawToolResult)
      ? {
          ok: toolResult.ok ?? true,
          note: "授权卡已展示给用户；不要再调用 show_qr，也不要复述授权链接或配对码。连接器会自动完成后续状态复核。",
        }
      : rawToolResult;
  appendToolTranscriptMessage(state, {
    toolName,
    toolCallId,
    args,
    result: transcriptResult,
  });
  endToolIoSpan(
    turn.toolIoSpans.get(toolCallId),
    rawToolResult,
    toolResultOk,
    buildToolIoEndMetadata(toolResultOk, rawToolResult),
    toolName,
  );
  turn.toolIoSpans.delete(toolCallId);

  const input: ToolResultContext = {
    turn,
    toolName,
    toolCallId,
    args,
    rawArgs,
    rawToolResult,
    toolResult,
    toolResultOk,
  };
  const killLifecycle = normalizeKillProcessResult({
    turn,
    toolCallId,
    toolName,
    args,
    rawToolResult,
  });
  if (killLifecycle) {
    const settled = settleBackgroundCommand(
      state,
      killLifecycle.pid,
      killLifecycle.terminal,
      {
        eventToolCallId: killLifecycle.sourceToolCallId,
        sourceToolName: killLifecycle.sourceToolName,
        eventPid: killLifecycle.eventPid,
        argumentPid: killLifecycle.argumentPid,
      },
    );
    if (settled) {
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: settled.messageId,
          toolCallId: settled.toolCallId,
          spec: settled.spec,
        },
      };
      outcome.producedVisibleFrame = true;
    }
  }
  const questionnaireResult = yield* handleQuestionnaireToolResult(input);
  if (questionnaireResult === "short-circuit") return true;
  if (questionnaireResult === "unhandled") {
    const specialResult = yield* handleSpecialToolResult(input);
    if (specialResult === "unhandled") {
      yield* handleDraftOrGenericToolResult(input);
    }
  }
  yield* handleMaterialToolResultSideEffects(input);
  return true;
}
