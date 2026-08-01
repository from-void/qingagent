import type { BridgeFrame } from "@qingagent/contract-ts";
import { getDerivativeMeta } from "@qingagent/db";
import { extractLoadedToolNamesFromToolSearchResult } from "../agents/toolSearch.js";
import { guardContext } from "../llm/prefixCacheGuard.js";
import { mastra } from "../mastra.js";
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
import { maskSensitiveReviewToolArgs } from "./sensitiveReviewMasking.js";

const CONNECTOR_AUTH_START_TOOL_NAMES = new Set([
  "github_auth_start",
  "feishu_auth_start",
  "wechat_auth_start",
]);
const logger = mastra.getLogger();

async function* emitDerivativeGenFinished(
  input: ToolResultContext,
): AsyncGenerator<BridgeFrame, void> {
  const { turn, toolName, args, toolResult } = input;
  if (toolName !== "generate_derivative" || toolResult.ok !== true) return;

  const docId = typeof args.derivativeDocId === "string" ? args.derivativeDocId : "";
  const docVersion =
    typeof toolResult.docVersion === "number" &&
    Number.isInteger(toolResult.docVersion) &&
    toolResult.docVersion > 0
      ? toolResult.docVersion
      : null;
  if (!docId || docVersion === null) {
    logger.warn("generate_derivative 成功结果缺少完成帧字段", {
      sessionId: turn.state.sessionId,
      docId: docId || null,
      docVersion,
    });
    return;
  }

  try {
    const meta = await getDerivativeMeta(docId);
    if (
      !meta ||
      meta.threadId !== turn.state.sessionId ||
      typeof meta.generatedAt !== "string" ||
      !meta.generatedAt
    ) {
      logger.warn("generate_derivative 成功后未取得有效衍生稿元数据", {
        sessionId: turn.state.sessionId,
        docId,
        metaSessionId: meta?.threadId ?? null,
        hasGeneratedAt: Boolean(meta?.generatedAt),
      });
      return;
    }
    yield {
      kind: "derivativeGenFinished",
      data: { docId, generatedAt: meta.generatedAt, docVersion },
    };
  } catch (error) {
    // 衍生稿已落库，补发 UI 刷新帧失败不能反过来破坏本轮工具成功语义。
    logger.error("generate_derivative 成功后读取衍生稿元数据失败", {
      sessionId: turn.state.sessionId,
      docId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  const args = maskSensitiveReviewToolArgs(turn, toolName, {
    ...(turn.toolCallArgsById.get(toolCallId) ?? {}),
    ...rawArgs,
  });
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
  yield* emitDerivativeGenFinished(input);
  return true;
}
