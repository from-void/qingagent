import type { BridgeFrame } from "@qingagent/contract-ts";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import {
  createAgentStreamTurnContext,
  type ProcessAgentStreamOptions,
  type ProcessOutcome,
} from "./agentStreamTurnContext.js";
import { finalizeAgentStream } from "./agentStreamFinalize.js";
import { handleLifecycleEvent } from "./agentStreamLifecycle.js";
import { handleSuspensionEvent } from "./agentStreamSuspension.js";
import { handleTextAndReasoningEvent } from "./agentStreamText.js";
import { handleToolCallEvent } from "./agentStreamToolCall.js";
import { handleToolOutputEvent } from "./agentStreamToolOutput.js";
import { handleToolResultEvent } from "./agentStreamToolResult.js";
import { IDLE_TIMEOUT_ABORT_REASON, withIdleTimeout } from "./streamErrors.js";

// usageCoverageMatrix 以原模块为稳定调用点索引；真实记账实现已下沉到 lifecycle handler。
const AGENT_USAGE_CALL_SITE = "agent";
void AGENT_USAGE_CALL_SITE;

export function formatTurnLog(evt: string, fields: Record<string, string | number>): string {
  const parts = [`[turn] evt=${safeTurnLogValue(evt)}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${safeTurnLogValue(String(value))}`);
  }
  return parts.join(" ");
}

function safeTurnLogValue(value: string): string {
  return value.replace(/\s+/g, "_");
}

function isToolHeartbeatEvent(chunk: AgentStreamEvent): boolean {
  return chunk.type === "tool-output" && chunk.payload.output?.type === "tool-heartbeat";
}

// ---------------------------------------------------------------------------
// processAgentStream — shared stream processor for initial and resumed streams
// ---------------------------------------------------------------------------

export type { ProcessAgentStreamOptions, ProcessOutcome } from "./agentStreamTurnContext.js";

/**
 * Process a Mastra agent fullStream, emitting BridgeFrame frames for each chunk.
 * Used by both `runAgentTurn` (initial stream) and bridgeHandler (resumed stream).
 *
 * Returns an object indicating whether the stream was suspended.
 */
export function processAgentStream(
  fullStream: AsyncIterable<AgentStreamEvent>,
  opts: ProcessAgentStreamOptions,
): AsyncGenerator<BridgeFrame, ProcessOutcome>;
/** 兼容历史测试夹具与 Mastra 当前仍声明为宽泛 ChunkType 的 fullStream 出口。 */
export function processAgentStream(
  fullStream: AsyncIterable<unknown>,
  opts: ProcessAgentStreamOptions,
): AsyncGenerator<BridgeFrame, ProcessOutcome>;
export async function* processAgentStream(
  fullStream: AsyncIterable<unknown>,
  opts: ProcessAgentStreamOptions,
): AsyncGenerator<BridgeFrame, ProcessOutcome> {
  const context = await createAgentStreamTurnContext(opts);
  try {
    const monitoredStream = withIdleTimeout(
      fullStream as AsyncIterable<AgentStreamEvent>,
      context.timeoutMs,
      () => context.abortController.abort(IDLE_TIMEOUT_ABORT_REASON),
      {
        heartbeatOnlyTimeoutMs: context.toolHeartbeatTimeoutMs,
        isHeartbeat: isToolHeartbeatEvent,
      },
    );
    for await (const chunk of monitoredStream) {
      if (!context.firstChunkLogged) {
        context.firstChunkLogged = true;
        console.info(
          formatTurnLog("firstChunk", {
            session: context.state.sessionId,
            stream: context.streamId,
            waitMs: Date.now() - context.streamStartTime,
          }),
        );
      }

      const lifecycleResult = yield* handleLifecycleEvent(context, chunk);
      if (lifecycleResult === "terminal") return context.outcome;
      if (lifecycleResult === "handled") continue;
      if (yield* handleToolOutputEvent(context, chunk)) continue;
      if (yield* handleTextAndReasoningEvent(context, chunk)) continue;

      const suspensionResult = yield* handleSuspensionEvent(context, chunk);
      if (suspensionResult === "terminal") return context.outcome;
      if (suspensionResult === "handled") continue;
      if (yield* handleToolCallEvent(context, chunk)) continue;
      if (yield* handleToolResultEvent(context, chunk)) continue;
    }

    return yield* finalizeAgentStream(context);
  } finally {
    if (context.restoreStreamIdOnExit) {
      context.state.streamId = context.previousStreamId;
    }
  }
}
