import type { BridgeFrame } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import { recordUsageEvent } from "@qingagent/db";
import { resolveDeepseekAuth, resolveModelId } from "../llm/modelConfig.js";
import {
  normalizeLlmUsage,
  recordLlmRequestSpan,
  recordLlmStepResponseSpan,
  toNumber,
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

export type LifecycleEventResult = "unhandled" | "handled" | "terminal";

export async function* handleLifecycleEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, LifecycleEventResult> {
  const {
    state,
    agentMessageId,
    streamId,
    runId,
    requestContext,
    abortController,
    outcome,
  } = context;

  if (chunk.type === "error") {
    const apiError = chunk.payload.error;
    const idleTimeout = isIdleTimeoutChunk(chunk);
    if (isUserAbortSignal(abortController.signal)) {
      outcome.streamWasUserAborted = true;
      logger.info("Ignoring stream error chunk from user-aborted turn", {
        sessionId: state.sessionId,
        streamId,
        idleTimeout,
        error: apiError instanceof Error ? apiError.message : String(apiError),
      });
      return "handled";
    }
    if (idleTimeout) context.sawIdleTimeout = true;
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
      outcome.retryableIdleTimeoutChunk = chunk;
      return "terminal";
    }
    if (transient && !outcome.producedVisibleFrame && !outcome.sawSideEffectToolCall) {
      outcome.transientErrorChunk = chunk;
      return "terminal";
    }
    if (!context.accumulatedText) {
      yield appendVisibleStreamErrorText(state, agentMessageId, errorDetails.userMessage);
      context.accumulatedText += errorDetails.userMessage;
      outcome.producedVisibleFrame = true;
    }
    yield draftingFailedFrame(streamId, errorDetails);
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  if (chunk.type === "tripwire") {
    const notice = guardrailTripwireMessage(chunk);
    yield appendVisibleStreamErrorText(state, agentMessageId, notice);
    context.accumulatedText += notice;
    outcome.producedVisibleFrame = true;
    logger.warn("Guardrail tripwire emitted visible failure frame", {
      sessionId: state.sessionId,
      streamId,
      reason: notice,
    });
    yield draftingFailedFrame(streamId, notice, false);
    return "handled";
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
    const stepOutput = asRecord(payload?.output);
    const usageRecord = asRecord(stepOutput?.usage);
    const siblingMetadata =
      stepOutput?.providerMetadata ??
      payload?.providerMetadata ??
      asRecord(payload?.stepResult)?.providerMetadata;
    const usage = normalizeLlmUsage(
      usageRecord
        ? {
            ...usageRecord,
            ...(siblingMetadata ? { providerMetadata: siblingMetadata } : {}),
          }
        : stepOutput?.usage,
    );
    if (usage) {
      const { origin } = resolveDeepseekAuth(requestContext);
      void recordUsageEvent({
        sessionId: state.sessionId,
        runId,
        callSite: "agent",
        modelId: resolveModelId(requestContext, "flash"),
        keyOrigin: origin,
        inputTokens: toNumber(usage.inputTokens),
        outputTokens: toNumber(usage.outputTokens),
        cacheHitTokens: toNumber(usage.promptCacheHitTokens),
        cacheMissTokens: toNumber(usage.promptCacheMissTokens),
      });
    }
    context.activeStepIndex = null;
    return "handled";
  }

  return "unhandled";
}
