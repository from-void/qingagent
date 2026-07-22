import type { BridgeFrame } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import {
  createAgentStreamTurnContext,
  type ProcessAgentStreamOptions,
  type ProcessOutcome,
} from "./agentStreamTurnContext.js";
import { finalizeAgentStream } from "./agentStreamFinalize.js";
import { handleLifecycleEvent } from "./agentStreamLifecycle.js";
import { handleSuspensionEvent } from "./agentStreamSuspension.js";
import { handleApprovalEvent } from "./agentStreamApproval.js";
import { handleTextAndReasoningEvent } from "./agentStreamText.js";
import { handleToolCallEvent } from "./agentStreamToolCall.js";
import { handleToolOutputEvent } from "./agentStreamToolOutput.js";
import { handleToolResultEvent } from "./agentStreamToolResult.js";
import {
  IDLE_TIMEOUT_ABORT_REASON,
  isUserAbortSignal,
  withIdleTimeout,
} from "./streamErrors.js";

// usageCoverageMatrix 以原模块为稳定调用点索引；真实记账实现已下沉到 lifecycle handler。
const AGENT_USAGE_CALL_SITE = "agent";
void AGENT_USAGE_CALL_SITE;
const logger = mastra.getLogger();

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
  let heartbeatReceivedCount = 0;
  try {
    const monitoredStream = withIdleTimeout(
      fullStream as AsyncIterable<AgentStreamEvent>,
      context.timeoutMs,
      () => context.abortController.abort(IDLE_TIMEOUT_ABORT_REASON),
      {
        firstChunkTimeoutMs: context.firstChunkTimeoutMs,
        heartbeatOnlyTimeoutMs: context.toolHeartbeatTimeoutMs,
        isHeartbeat: (chunk) => {
          const heartbeat = isToolHeartbeatEvent(chunk);
          if (heartbeat && heartbeatReceivedCount++ === 0) {
            const heartbeatOutput = chunk.type === "tool-output"
              ? chunk.payload.output
              : undefined;
            logger.debug("Tool heartbeat reached agent stream watchdog", {
              sessionId: context.state.sessionId,
              streamId: context.streamId,
              runId: context.runId,
              tool: heartbeatOutput?.tool ?? null,
              seq: heartbeatOutput?.seq ?? null,
              receivedCount: heartbeatReceivedCount,
            });
          }
          return heartbeat;
        },
        abortSignal: context.abortController.signal,
      },
    );
    for await (const chunk of monitoredStream) {
      // 上游在 abort 前已排队的 chunk 仍可能继续抵达。用户取消后禁止再把这些
      // 文本/工具事件写入会话；跳出循环仍会经过 finalize/finally 完成必要收尾。
      if (isUserAbortSignal(context.abortController.signal)) break;
      if (!context.firstChunkLogged && !isToolHeartbeatEvent(chunk)) {
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
      if (lifecycleResult === "terminal") {
        yield* context.annotationPreview.clear();
        return context.outcome;
      }
      if (lifecycleResult === "handled") continue;
      if (yield* handleToolOutputEvent(context, chunk)) continue;
      if (yield* handleTextAndReasoningEvent(context, chunk)) continue;

      const approvalResult = yield* handleApprovalEvent(context, chunk);
      if (approvalResult === "handled") continue;

      const suspensionResult = yield* handleSuspensionEvent(context, chunk);
      if (suspensionResult === "terminal") {
        yield* context.annotationPreview.clear();
        return context.outcome;
      }
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
