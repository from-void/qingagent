import type { BridgeFrame } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import {
  recordLlmRequestSpan,
  recordLlmStepResponseSpan,
} from "./agentSpans.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import {
  appendVisibleStreamErrorText,
  draftingFailedFrame,
  guardrailTripwireMessage,
  isIdleTimeoutChunk,
  isTransientStreamErrorChunk,
  isUserAbortSignal,
  streamErrorDetails,
} from "./streamErrors.js";

const logger = mastra.getLogger();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export type LifecycleEventResult =
  | "unhandled"
  | "handled"
  | "finalize"
  | "terminal";

export async function* handleLifecycleEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, LifecycleEventResult> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    abortController,
    outcome,
  } = context;

  if (chunk.type === "error") {
    const apiError = chunk.payload.error;
    const idleTimeout = isIdleTimeoutChunk(chunk);
    if (isUserAbortSignal(abortController.signal)) {
      outcome.streamWasUserAborted = true;
      outcome.terminalOutcome = { kind: "cancelled" };
      logger.info("Ignoring stream error chunk from user-aborted turn", {
        sessionId: state.sessionId,
        streamId,
        idleTimeout,
        error: apiError instanceof Error ? apiError.message : String(apiError),
      });
      return "handled";
    }
    if (idleTimeout) {
      context.sawIdleTimeout = true;
      if (chunk.payload.absoluteTimeoutKind === "automatic_length_revision") {
        context.sawAutomaticLengthRevisionTimeout = true;
      }
    }
    const errorDetails = streamErrorDetails(chunk);
    const transient = isTransientStreamErrorChunk(chunk);
    logger.error("LLM stream error chunk", {
      sessionId: state.sessionId,
      streamId,
      idleTimeout,
      statusCode: errorDetails.statusCode ?? null,
      category: errorDetails.category,
      retriable: errorDetails.retriable,
      transient,
      producedVisibleFrame: outcome.producedVisibleFrame,
      sawToolCall: outcome.sawToolCall,
      error: apiError instanceof Error ? apiError.message : String(apiError),
    });
    if (
      idleTimeout &&
      context.deferRetryableIdleTimeout &&
      !outcome.producedVisibleFrame &&
      !outcome.sawSideEffectToolCall
    ) {
      outcome.terminalOutcome = { kind: "error", details: errorDetails };
      outcome.retryableIdleTimeoutChunk = chunk;
      return "terminal";
    }
    const hasDraftArtifactToSettle =
      context.sawValidDraftMutation ||
      context.docGeneratedThisTurn ||
      context.validPatchCount > 0;
    if (idleTimeout && hasDraftArtifactToSettle) {
      // 工具已经产出可审候选/完整草稿时，idle 只代表外层模型收尾缺席。
      // 不先发 draftingFailed（它会让前端进入错误态）；统一交给 finalize
      // 落候选并发出明确的部分成功收口。
      logger.info("Idle timeout deferred to draft artifact settle", {
        sessionId: state.sessionId,
        streamId,
        sawValidDraftMutation: context.sawValidDraftMutation,
        docGeneratedThisTurn: context.docGeneratedThisTurn,
        validPatchCount: context.validPatchCount,
        pendingSuggestionCount: state.suggestions.size,
      });
      return "handled";
    }
    if (transient && !outcome.producedVisibleFrame && !outcome.sawSideEffectToolCall) {
      outcome.terminalOutcome = { kind: "error", details: errorDetails };
      outcome.transientErrorChunk = chunk;
      return "terminal";
    }
    outcome.terminalOutcome = { kind: "error", details: errorDetails };
    if (!context.accumulatedText) {
      yield appendVisibleStreamErrorText(state, agentMessageId, errorDetails.userMessage);
      context.accumulatedText += errorDetails.userMessage;
      outcome.producedVisibleFrame = true;
    }
    yield draftingFailedFrame(streamId, errorDetails);
    outcome.producedVisibleFrame = true;
    return "finalize";
  }

  if (chunk.type === "tripwire") {
    const notice = guardrailTripwireMessage(chunk);
    outcome.terminalOutcome = {
      kind: "error",
      details: {
        reason: notice,
        retriable: false,
        category: "unknown",
        userMessage: notice,
        action: "none",
      },
    };
    yield appendVisibleStreamErrorText(state, agentMessageId, notice);
    context.accumulatedText += notice;
    outcome.producedVisibleFrame = true;
    logger.warn("Guardrail tripwire emitted visible failure frame", {
      sessionId: state.sessionId,
      streamId,
      reason: notice,
    });
    yield draftingFailedFrame(streamId, notice, false);
    return "finalize";
  }

  if (chunk.type === "step-start") {
    context.stepIndex += 1;
    context.activeStepIndex = context.stepIndex;
    context.lastModelChunkAt = null;
    recordLlmRequestSpan(state, streamId, runId, context.stepIndex, chunk.payload);
    return "handled";
  }

  if (chunk.type === "step-finish") {
    if (context.activeStepIndex === null) {
      context.stepIndex += 1;
      context.activeStepIndex = context.stepIndex;
    }
    const payload = asRecord(chunk.payload);
    const stepResult = asRecord(payload?.stepResult);
    const reason = stepResult?.reason ?? payload?.finishReason ?? payload?.reason;
    context.lastStepFinishReason = typeof reason === "string" ? reason : null;
    recordLlmStepResponseSpan(
      state,
      streamId,
      runId,
      context.activeStepIndex,
      chunk.payload,
    );
    context.activeStepIndex = null;
    return "handled";
  }

  if (chunk.type === "finish") {
    const payload = asRecord(chunk.payload);
    const reason = payload?.finishReason ?? payload?.reason;
    if (typeof reason === "string") {
      context.lastStepFinishReason = reason;
    }
    return "handled";
  }

  return "unhandled";
}
