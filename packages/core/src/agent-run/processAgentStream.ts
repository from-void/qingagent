import type { BridgeFrame } from "@qingagent/contract-ts";
import { mastra } from "../mastra.js";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import {
  invalidateTurnOwnership,
  turnOwnershipFromRequestContext,
} from "../session/turnOwnership.js";
import {
  createAgentStreamTurnContext,
  type AgentStreamTurnContext,
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
import { trackUserVisibleFrames } from "./agentStreamVisibility.js";

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

/** 有卡片正等用户点确认 = 本轮活着,只是在等人。 */
function hasPendingConfirm(state: { pendingConfirms: Map<string, { status: string }> }): boolean {
  for (const pending of state.pendingConfirms.values()) {
    if (pending.status === "pending" || pending.status === "resuming") return true;
  }
  return false;
}

function isToolHeartbeatEvent(chunk: AgentStreamEvent): boolean {
  return chunk.type === "tool-output" && chunk.payload.output?.type === "tool-heartbeat";
}

/**
 * Mastra 会先发送 start/step-start 等生命周期元数据；它们不代表模型已经开始产出。
 * 段首宽限只在文本、推理增量或真实工具调用参数抵达后结束。
 */
function isContentfulStreamEvent(chunk: AgentStreamEvent): boolean {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof chunk.payload.text === "string" && chunk.payload.text.length > 0;
    case "tool-call-delta":
      return typeof chunk.payload.argsTextDelta === "string" && chunk.payload.argsTextDelta.length > 0;
    case "tool-call":
      return true;
    default:
      return false;
  }
}

/** 工具执行完后外层模型会开启新 step；下一段首内容需重新获得 TTFT 宽限。 */
function startsContentSegment(chunk: AgentStreamEvent): boolean {
  if (chunk.type === "tool-result" || chunk.type === "tool-error") return true;
  if (chunk.type !== "step-finish") return false;
  const payload = chunk.payload as Record<string, unknown>;
  const stepResult = payload.stepResult && typeof payload.stepResult === "object"
    ? payload.stepResult as Record<string, unknown>
    : null;
  return (stepResult?.reason ?? payload.finishReason ?? payload.reason) === "tool-calls";
}

function countChunkType(context: AgentStreamTurnContext, chunk: AgentStreamEvent): void {
  const type = typeof chunk.type === "string" && chunk.type.length > 0
    ? chunk.type
    : "unknown";
  context.chunkTypeCounts.set(type, (context.chunkTypeCounts.get(type) ?? 0) + 1);
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
  const turnOwnership = turnOwnershipFromRequestContext(context.requestContext);
  let heartbeatReceivedCount = 0;
  try {
    const monitoredStream = withIdleTimeout(
      fullStream as AsyncIterable<AgentStreamEvent>,
      context.timeoutMs,
      ({ heartbeatOnly }) => {
        // 待确认卡是"等人"不是"卡死":挂起期间本就没有 chunk,任何无帧判定都必须
        // 把它当活跃信号,否则用户还没来得及点确认,回合已被 idle 看门狗杀掉,
        // 卡片直接落成中止(0729 真机 P1)。
        if (hasPendingConfirm(context.state)) {
          logger.info("Idle watchdog vetoed: turn is waiting for a user confirm", {
            sessionId: context.state.sessionId,
            streamId: context.streamId,
            runId: context.runId,
            heartbeatOnly,
            pendingConfirmCount: context.state.pendingConfirms.size,
          });
          return false;
        }
        context.abortController.abort(IDLE_TIMEOUT_ABORT_REASON);
        invalidateTurnOwnership(context.state, turnOwnership);
        return true;
      },
      {
        firstChunkTimeoutMs: context.firstChunkTimeoutMs,
        heartbeatOnlyTimeoutMs: context.toolHeartbeatTimeoutMs,
        isContentful: isContentfulStreamEvent,
        startsContentSegment,
        isHeartbeat: (chunk) => {
          const heartbeat = isToolHeartbeatEvent(chunk);
          if (heartbeat && heartbeatReceivedCount++ === 0) {
            const heartbeatOutput = chunk.type === "tool-output"
              ? chunk.payload.output
              : undefined;
            logger.info("Tool heartbeat consumed by agent stream watchdog", {
              sessionId: context.state.sessionId,
              streamId: context.streamId,
              runId: context.runId,
              tool: heartbeatOutput?.tool ?? null,
              seq: heartbeatOutput?.seq ?? null,
              receivedCount: heartbeatReceivedCount,
              resetsIdleTimer: true,
            });
          }
          return heartbeat;
        },
        abortSignal: context.abortController.signal,
      },
    );
    for await (const chunk of monitoredStream) {
      countChunkType(context, chunk);
      // 上游在 abort 前已排队的 chunk 仍可能继续抵达。用户取消后禁止再把这些
      // 文本/工具事件写入会话；跳出循环仍会经过 finalize/finally 完成必要收尾。
      if (isUserAbortSignal(context.abortController.signal)) break;
      if (!context.firstChunkLogged && isContentfulStreamEvent(chunk)) {
        context.firstChunkLogged = true;
        console.info(
          formatTurnLog("firstChunk", {
            session: context.state.sessionId,
            stream: context.streamId,
            waitMs: Date.now() - context.streamStartTime,
          }),
        );
      }

      const lifecycleResult = yield* trackUserVisibleFrames(
        context,
        handleLifecycleEvent(context, chunk),
      );
      if (lifecycleResult === "terminal") {
        yield* context.annotationPreview.clear();
        return context.outcome;
      }
      if (lifecycleResult === "finalize") break;
      if (lifecycleResult === "handled") continue;
      if (yield* trackUserVisibleFrames(context, handleToolOutputEvent(context, chunk))) {
        continue;
      }
      if (yield* trackUserVisibleFrames(context, handleTextAndReasoningEvent(context, chunk))) {
        continue;
      }

      const approvalResult = yield* trackUserVisibleFrames(
        context,
        handleApprovalEvent(context, chunk),
      );
      if (approvalResult === "handled") continue;

      const suspensionResult = yield* trackUserVisibleFrames(
        context,
        handleSuspensionEvent(context, chunk),
      );
      if (suspensionResult === "terminal") {
        yield* context.annotationPreview.clear();
        return context.outcome;
      }
      if (suspensionResult === "handled") continue;
      if (yield* trackUserVisibleFrames(context, handleToolCallEvent(context, chunk))) {
        continue;
      }
      if (yield* trackUserVisibleFrames(context, handleToolResultEvent(context, chunk))) {
        continue;
      }
    }

    return yield* trackUserVisibleFrames(context, finalizeAgentStream(context));
  } finally {
    if (context.restoreStreamIdOnExit) {
      context.state.streamId = context.previousStreamId;
    }
  }
}
