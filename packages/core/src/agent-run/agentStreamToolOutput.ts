import type {
  BridgeFrame,
  MessagePart,
  ResearchCardBody,
  ToolCallSpec,
  WriteDraftCardBody,
} from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { asDocGenerationEvent } from "../doc-engine/docGenerationEvents.js";
import { syncContentAndProjectDocState } from "../doc-engine/docStateSync.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  toolCallUpdated,
} from "./frames.js";
import {
  appendPartToChatHistory,
  nextSeq,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import {
  buildAskUserToolCallSpec,
  generateSvgToolCallSpec,
  normalizeGenerateSvgProgress,
  readImageToolCallSpec,
  researchCardToolCallSpec,
} from "./toolCards.js";

const logger = mastra.getLogger();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function hasToolCallPart(
  context: AgentStreamTurnContext,
  messageId: string,
  toolCallId: string,
): boolean {
  const message = context.state.chatHistory.find((item) => item.id === messageId);
  return message?.parts.some(
    (part) => part.kind === "toolCall" && part.data.id === toolCallId,
  ) === true;
}

export function* emitOrUpdateToolCall(
  context: AgentStreamTurnContext,
  spec: ToolCallSpec,
): Generator<BridgeFrame> {
  const { state, agentMessageId } = context;
  if (!hasToolCallPart(context, agentMessageId, spec.id)) {
    const seq = nextSeq(state, agentMessageId);
    const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
    ensureAgentChatHistoryMessage(state, agentMessageId);
    appendPartToChatHistory(state, agentMessageId, toolCallPart);
    yield chatMessageAppended(agentMessageId, seq, toolCallPart);
  }
  yield toolCallUpdated(agentMessageId, spec.id, spec);
  updateToolCallInChatHistory(state, agentMessageId, spec.id, spec);
}

export async function* handleToolOutputEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, boolean> {
  if (chunk.type !== "tool-output") return false;
  const { state, agentMessageId, streamId, outcome } = context;
  const output = chunk.payload.output;
  if (output?.type === "tool-heartbeat") {
    context.sawToolHeartbeat = true;
    return true;
  }
  outcome.sawToolCall = true;
  if (output?.type === "doc-generation-event") outcome.sawSideEffectToolCall = true;
  const toolCallId =
    typeof chunk.payload.toolCallId === "string" ? chunk.payload.toolCallId : null;

  if (output?.type === "research-fulltext" && Array.isArray(output.items)) {
    for (const raw of output.items) {
      if (!isRecord(raw) || typeof raw.text !== "string" || !raw.text) continue;
      const materialId = typeof raw.materialId === "string" ? raw.materialId : null;
      const entry = { text: raw.text, materialId };
      const url = typeof raw.url === "string" && raw.url ? raw.url : "";
      const title = typeof raw.title === "string" ? raw.title.trim() : "";
      if (url) context.researchFullTexts.set(url, entry);
      if (title) context.researchFullTexts.set(title, entry);
      if (materialId) context.researchFullTexts.set(materialId, entry);
    }
    return true;
  }

  if (output?.type === "doc-generation-event") {
    const event = asDocGenerationEvent(output.event);
    if (!event) {
      logger.warn("invalid doc-generation-event tool output ignored", {
        streamId,
        toolCallId,
      });
      return true;
    }
    if (context.docGeneratedThisTurn) return true;
    context.activeDocGenerationToolCallId = toolCallId;
    context.activeDocGenerationId = event.data.generationId;
    context.activeDocGenerationLastSeq = event.data.seq;
    if (event.kind === "generation_failed") {
      context.activeDocGenerationFailedEventSeen = true;
    }
    yield { kind: "docGenerationEvent", data: event };
    outcome.producedVisibleFrame = true;
    return true;
  }

  if (
    output?.type === "writedraft-progress" &&
    isRecord(output.progress) &&
    toolCallId
  ) {
    outcome.sawSideEffectToolCall = true;
    context.sawWriteDraftProgress = true;
    const progress = output.progress as WriteDraftCardBody;
    const spec: ToolCallSpec = {
      id: toolCallId,
      name: "writeDraft",
      render: { kind: "chatInline" },
      status:
        progress.phase === "failed"
          ? { kind: "failed", data: { retriable: true, reason: "writeDraft 生成失败" } }
          : { kind: "running", data: { progressPct: null, etaSec: null } },
      body: { kind: "writeDraftCard", data: progress },
      result: null,
    };
    yield* emitOrUpdateToolCall(context, spec);
    outcome.producedVisibleFrame = true;
    return true;
  }

  if (
    output?.type === "generatesvg-progress" &&
    isRecord(output.progress) &&
    toolCallId
  ) {
    outcome.sawSideEffectToolCall = true;
    const progress = normalizeGenerateSvgProgress(output.progress);
    if (!progress) return true;
    const meta = context.generateSvgMeta.get(toolCallId);
    const spec = generateSvgToolCallSpec(
      toolCallId,
      meta?.args ?? {},
      { kind: "running", data: { progressPct: null, etaSec: null } },
      null,
      progress,
    );
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    return true;
  }

  if (
    output?.type === "research-progress" &&
    isRecord(output.progress) &&
    toolCallId
  ) {
    outcome.sawSideEffectToolCall = true;
    const spec = researchCardToolCallSpec(
      toolCallId,
      output.progress as unknown as ResearchCardBody,
      { kind: "running", data: { progressPct: null, etaSec: null } },
    );
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    return true;
  }

  if (output?.type === "askuser-progress" && Array.isArray(output.questions)) {
    const progressToolCallId =
      typeof chunk.payload.toolCallId === "string" ? chunk.payload.toolCallId : null;
    const targetId = progressToolCallId ?? "askuser-progress";
    if (progressToolCallId !== null) context.askUserProgressToolCallId = progressToolCallId;
    const partialSpec = buildAskUserToolCallSpec({
      toolCallId: targetId,
      toolName: context.questionnaireToolName ?? "planDraft",
      id: "streaming",
      renderMode: context.askUserRenderMode,
      purpose: context.askUserPurpose,
      source: null,
      rationale: null,
      questions: output.questions,
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
    });
    if (!context.askUserProgressEmitted) {
      context.askUserProgressEmitted = true;
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: partialSpec };
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
      outcome.producedVisibleFrame = true;
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
      yield* syncContentAndProjectDocState(state, "ask_user_started");
    }
    yield toolCallUpdated(agentMessageId, targetId, partialSpec);
    updateToolCallInChatHistory(state, agentMessageId, targetId, partialSpec);
    outcome.producedVisibleFrame = true;
  }

  if (
    output?.type === "readimage-progress" &&
    isRecord(output.progress) &&
    toolCallId
  ) {
    const excerpt = output.progress.excerpt;
    const meta = context.readImageMeta.get(toolCallId);
    const spec = readImageToolCallSpec(
      toolCallId,
      meta?.args ?? {},
      { kind: "running", data: { progressPct: null, etaSec: null } },
      null,
      meta?.thumbnailSrc ?? null,
      typeof excerpt === "string" && excerpt ? excerpt : null,
    );
    yield* emitOrUpdateToolCall(context, spec);
    outcome.producedVisibleFrame = true;
  }
  return true;
}
