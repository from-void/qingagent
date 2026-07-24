import type { BridgeFrame, MessagePart, ToolCallSpec } from "@qingagent/contract-ts";
import { todosSchema } from "@qingagent/contract-ts/schemas";
import { mastra } from "../mastra.js";
import { thumbnailSrcForImageInput } from "../tools/imageInput.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { stringifyToolError } from "./agentSpans.js";
import { syncContentAndProjectDocState } from "../doc-engine/docStateSync.js";
import {
  DRAFT_MUTATION_TOOL_NAMES,
  DRAFT_TOOL_JSON_RETRY_NOTICE,
  hasUsableDraftMutationArgs,
  normalizeToolCallArgs,
} from "../doc-engine/draftToolArgs.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  toolCallUpdated,
} from "./frames.js";
import {
  isDirectionReset,
  isPlanDraftTool,
  isQuestionnaireTool,
  questionnaireRenderMode,
} from "./questionnaireTools.js";
import { redactedSerializedText } from "./redaction.js";
import { resolveQrContent } from "./qrContentResolver.js";
import {
  appendPartToChatHistory,
  nextSeq,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import { schedulePersist } from "../session/threadPersistence.js";
import {
  PURE_UI_TOOL_NAMES,
  buildAskUserToolCallSpec,
  generateSvgToolCallSpec,
  qrCardToolCallSpec,
  readImageToolCallSpec,
  researchCardToolCallSpec,
  wechatAuthQrToolCallSpec,
} from "./toolCards.js";
import {
  buildToolIoEndMetadata,
  endToolIoSpan,
  startToolIoSpan,
} from "./toolIoSpans.js";
import { emitOrUpdateToolCall } from "./agentStreamToolOutput.js";
import { buildAnnotationPreviewData } from "./annotationPreview.js";

const logger = mastra.getLogger();
export const SESSION_STATE_TOOL_NAMES = new Set(["updateTodos"]);

export async function* handleToolCallEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, boolean> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    requestContext,
    outcome,
  } = context;

  if (chunk.type === "tool-call-input-streaming-start") {
    const toolCallId =
      typeof chunk.payload.toolCallId === "string" ? chunk.payload.toolCallId : null;
    const toolName =
      typeof chunk.payload.toolName === "string" ? chunk.payload.toolName : null;
    if (!toolCallId || !toolName) return true;
    if (toolName === "create_annotation_groups") {
      context.annotationPreview.start(toolCallId);
    }
    if (SESSION_STATE_TOOL_NAMES.has(toolName)) return true;
    if (context.streamingPlaceholders.has(toolCallId)) return true;
    const spec: ToolCallSpec = isQuestionnaireTool(toolName)
      ? buildAskUserToolCallSpec({
          toolCallId,
          toolName,
          id: "streaming",
          renderMode: questionnaireRenderMode(toolName),
          questions: [],
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
        })
      : {
          id: toolCallId,
          name: toolName,
          render: { kind: "chatInline" },
          status: { kind: "running", data: { progressPct: null, etaSec: null } },
          body: { kind: "generic", data: { argsJson: "" } },
          result: null,
        };
    const seq = nextSeq(state, agentMessageId);
    const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
    ensureAgentChatHistoryMessage(state, agentMessageId);
    appendPartToChatHistory(state, agentMessageId, toolCallPart);
    yield chatMessageAppended(agentMessageId, seq, toolCallPart);
    context.streamingPlaceholders.add(toolCallId);
    outcome.producedVisibleFrame = true;
    return true;
  }

  if (chunk.type === "tool-call-delta") {
    const toolCallId =
      typeof chunk.payload.toolCallId === "string" ? chunk.payload.toolCallId : null;
    const argsTextDelta =
      typeof chunk.payload.argsTextDelta === "string" ? chunk.payload.argsTextDelta : null;
    if (toolCallId && argsTextDelta && state.doc) {
      for (const scanned of context.annotationPreview.feed(toolCallId, argsTextDelta)) {
        const data = buildAnnotationPreviewData(state.doc, scanned.previewId, scanned.source);
        if (!data) continue;
        yield { kind: "annotationPreview", data };
        outcome.producedVisibleFrame = true;
      }
    }
    return true;
  }

  if (chunk.type === "tool-call-input-streaming-end") {
    return true;
  }

  if (chunk.type === "tool-call") {
    const { toolName, toolCallId } = chunk.payload;
    if (toolName === "create_annotation_groups") {
      yield* context.annotationPreview.clear();
    }
    const toolArgs = normalizeToolCallArgs(
      toolName,
      chunk.payload as Record<string, unknown>,
    );
    context.toolCallArgsById.set(toolCallId, toolArgs);
    if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
      context.sawAnyToolCall = true;
      context.sawTextAfterLastTool = false;
      context.lastModelChunkAt = new Date().toISOString();
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
      context.streamingPlaceholders.delete(toolCallId);
      return true;
    }

    context.sawAnyToolCall = true;
    if (!PURE_UI_TOOL_NAMES.has(toolName)) context.sawNonUiToolCall = true;
    context.sawTextAfterLastTool = false;
    context.lastModelChunkAt = new Date().toISOString();
    outcome.sawToolCall = true;
    if (!isQuestionnaireTool(toolName) && !PURE_UI_TOOL_NAMES.has(toolName)) {
      outcome.sawSideEffectToolCall = true;
    }
    logger.info("Tool call received", {
      toolName,
      toolCallId,
      streamId,
      sessionId: state.sessionId,
    });
    context.toolIoSpans.set(
      toolCallId,
      startToolIoSpan(state, streamId, runId, toolName, toolCallId, toolArgs),
    );

    if (
      DRAFT_MUTATION_TOOL_NAMES.has(toolName) &&
      !hasUsableDraftMutationArgs(toolName, toolArgs)
    ) {
      context.sawFailedDraftMutationInput = true;
      const failedSpec: ToolCallSpec = {
        id: toolCallId,
        name: toolName,
        render: { kind: "chatInline" },
        status: {
          kind: "failed",
          data: { retriable: true, reason: DRAFT_TOOL_JSON_RETRY_NOTICE },
        },
        body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
        result: { kind: "genericText", data: DRAFT_TOOL_JSON_RETRY_NOTICE },
      };
      yield* emitOrUpdateToolCall(context, failedSpec);
      outcome.producedVisibleFrame = true;
      logger.warn("Draft mutation tool-call has invalid or empty arguments", {
        toolName,
        toolCallId,
        streamId,
        sessionId: state.sessionId,
      });
      return true;
    }

    if (toolName === "writeDraft") {
      const spec: ToolCallSpec = {
        id: toolCallId,
        name: toolName,
        render: { kind: "chatInline" },
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
        body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
        result: null,
      };
      yield* emitOrUpdateToolCall(context, spec);
      yield* syncContentAndProjectDocState(state, "generate_doc_started");
    } else if (isQuestionnaireTool(toolName)) {
      const resetFromContext = requestContext?.get("isDirectionReset");
      const directionReset =
        typeof resetFromContext === "boolean" ? resetFromContext : isDirectionReset(state);
      const bypassCompleted =
        isPlanDraftTool(toolName) &&
        directionReset &&
        state._directionChangeAskedSinceLastWrite !== true;
      const alreadyCompleted =
        isPlanDraftTool(toolName) &&
        ((requestContext?.get("askUserAlreadyCompleted") as boolean | undefined) === true ||
          state._askUserCompleted === true) &&
        !bypassCompleted;
      if (alreadyCompleted) {
        logger.warn("askUser tool-call suppressed (already completed) - no UI frame", {
          toolCallId,
          streamId,
        });
        return true;
      }
      if (context.seenAskUser) {
        logger.warn("Duplicate askUser tool-call ignored", { toolCallId, streamId });
        return true;
      }
      context.seenAskUser = true;
      context.questionnaireToolName = toolName;
      const purpose = toolArgs.purpose;
      context.askUserPurpose =
        purpose === "initialBrief" ||
        purpose === "quickClarification" ||
        purpose === "directionChange"
          ? purpose
          : null;
      context.askUserRenderMode = questionnaireRenderMode(toolName);
      const earlySpec = buildAskUserToolCallSpec({
        toolCallId,
        toolName,
        id: "streaming",
        renderMode: context.askUserRenderMode,
        purpose: context.askUserPurpose,
        source: null,
        rationale: null,
        questions: [],
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
      });
      yield* emitOrUpdateToolCall(context, earlySpec);
      yield* syncContentAndProjectDocState(state, "ask_user_started");
      context.askUserProgressEmitted = true;
      context.askUserProgressToolCallId = toolCallId;
    } else if (toolName === "webSearch") {
      yield* emitOrUpdateToolCall(
        context,
        researchCardToolCallSpec(
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
        ),
      );
    } else if (toolName === "generateSvg") {
      context.generateSvgPreviousDocState ??= state.docState;
      context.generateSvgMeta.set(toolCallId, { args: toolArgs });
      yield* emitOrUpdateToolCall(
        context,
        generateSvgToolCallSpec(
          toolCallId,
          toolArgs,
          { kind: "running", data: { progressPct: null, etaSec: null } },
        ),
      );
      yield* syncContentAndProjectDocState(state, "generate_svg_started");
    } else if (toolName === "readImage") {
      const args = (chunk.payload.args ?? {}) as Record<string, unknown>;
      const thumbnailSrc =
        typeof args.image === "string" ? await thumbnailSrcForImageInput(args.image) : null;
      context.readImageMeta.set(toolCallId, { args, thumbnailSrc });
      yield* emitOrUpdateToolCall(
        context,
        readImageToolCallSpec(
          toolCallId,
          args,
          { kind: "running", data: { progressPct: null, etaSec: null } },
          null,
          thumbnailSrc,
        ),
      );
      outcome.producedVisibleFrame = true;
    } else if (toolName === "show_qr") {
      // 出码前确定性验真:content 若是"出码展示页"链接,替换为页面内嵌的真实授权 URL
      // (模型侧教学已实证不可靠,见 qrContentResolver 注释)。imageDataUri 模式不涉及。
      const qrArgs = toolArgs as Record<string, unknown>;
      let resolvedArgs = toolArgs;
      if (!qrArgs.imageDataUri) {
        const resolved = await resolveQrContent(qrArgs.content);
        if (resolved) {
          resolvedArgs = { ...qrArgs, content: resolved };
          logger.info("show_qr content 验真替换为页面内嵌授权 URL", {
            from: String(qrArgs.content).slice(0, 200),
            to: resolved.slice(0, 200),
          });
        }
      }
      yield* emitOrUpdateToolCall(
        context,
        qrCardToolCallSpec(toolCallId, resolvedArgs, {
          kind: "running",
          data: { progressPct: null, etaSec: null },
        }),
      );
      outcome.producedVisibleFrame = true;
    } else if (toolName === "wechat_auth_start") {
      yield* emitOrUpdateToolCall(
        context,
        wechatAuthQrToolCallSpec(toolCallId, null, {
          kind: "running",
          data: { progressPct: null, etaSec: null },
        }),
      );
      outcome.producedVisibleFrame = true;
    } else {
      yield* emitOrUpdateToolCall(context, {
        id: toolCallId,
        name: toolName,
        render: { kind: "chatInline" },
        status: { kind: "running", data: { progressPct: null, etaSec: null } },
        body: { kind: "generic", data: { argsJson: redactedSerializedText(toolArgs) } },
        result: null,
      });
    }
    context.streamingPlaceholders.delete(toolCallId);
    return true;
  }

  if (chunk.type !== "tool-error") return false;
  const payload = chunk.payload;
  const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
  if (toolName === "create_annotation_groups") {
    yield* context.annotationPreview.clear();
  }
  const errorText = stringifyToolError(payload.error);
  outcome.sawToolCall = true;
  context.sawAnyToolCall = true;
  context.sawTextAfterLastTool = false;
  endToolIoSpan(
    context.toolIoSpans.get(toolCallId),
    { ok: false, error: errorText },
    false,
    buildToolIoEndMetadata(false, { ok: false, error: errorText }),
  );
  context.toolIoSpans.delete(toolCallId);
  if (SESSION_STATE_TOOL_NAMES.has(toolName)) {
    context.streamingPlaceholders.delete(toolCallId);
    logger.warn("Session state tool error ignored", {
      toolName,
      toolCallId,
      streamId,
      sessionId: state.sessionId,
      error: errorText,
    });
    return true;
  }
  if (toolName && !PURE_UI_TOOL_NAMES.has(toolName)) context.sawNonUiToolCall = true;
  const originalMessage = toolCallId
    ? state.chatHistory.find((message) =>
        message.parts.some(
          (part) => part.kind === "toolCall" && part.data.id === toolCallId,
        ),
      )
    : undefined;
  const originalPart = originalMessage?.parts.find(
    (part) => part.kind === "toolCall" && part.data.id === toolCallId,
  );
  if (originalMessage && originalPart?.kind === "toolCall") {
    const failedSpec: ToolCallSpec = {
      ...originalPart.data,
      status: {
        kind: "failed",
        data: {
          retriable: true,
          reason: errorText || `工具 ${toolName || originalPart.data.name} 执行失败`,
        },
      },
      result: null,
    };
    yield toolCallUpdated(originalMessage.id, toolCallId, failedSpec);
    updateToolCallInChatHistory(state, originalMessage.id, toolCallId, failedSpec);
    outcome.producedVisibleFrame = true;
  } else if (toolCallId) {
    const spec: ToolCallSpec = {
      id: toolCallId,
      name: toolName || "tool",
      render: { kind: "chatInline" },
      status: {
        kind: "failed",
        data: {
          retriable: true,
          reason: errorText || `工具 ${toolName || "tool"} 执行失败`,
        },
      },
      body: { kind: "generic", data: { argsJson: "" } },
      result: null,
    };
    const seq = nextSeq(state, agentMessageId);
    const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
    yield chatMessageAppended(agentMessageId, seq, toolCallPart);
    ensureAgentChatHistoryMessage(state, agentMessageId);
    appendPartToChatHistory(state, agentMessageId, toolCallPart);
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
  }
  context.streamingPlaceholders.delete(toolCallId);
  schedulePersist(state, "tool_error").catch((error) =>
    logger.error("Persist after tool-error failed", { error: String(error) }),
  );
  return true;
}
