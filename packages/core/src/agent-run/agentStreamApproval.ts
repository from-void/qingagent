import type { BridgeFrame, ToolCallSpec } from "@qingagent/contract-ts";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { emitOrUpdateToolCall } from "./agentStreamToolOutput.js";
import { emitProjectedDocState } from "../doc-engine/docStateMachine.js";
import { draftingFailedFrame } from "./streamErrors.js";
import { markToolIoSpanSuspended } from "./toolIoSpans.js";
import { confirmedCommandCardSpec } from "./toolCards.js";

export type ApprovalEventResult = "unhandled" | "handled";

function failedApprovalSpec(
  toolCallId: string,
  toolName: string,
  reason: string,
): ToolCallSpec {
  return {
    id: toolCallId || "invalid-approval",
    name: toolName || "tool",
    render: { kind: "chatInline" },
    status: { kind: "failed", data: { retriable: false, reason } },
    body: { kind: "generic", data: { argsJson: "" } },
    result: { kind: "genericText", data: reason },
  };
}

/** requireApproval 的独立宿主通道；不读写 askUser suspension owner。 */
export async function* handleApprovalEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, ApprovalEventResult> {
  if (chunk.type !== "tool-call-approval") return "unhandled";

  const toolCallId =
    typeof chunk.payload.toolCallId === "string" ? chunk.payload.toolCallId : "";
  const toolName =
    typeof chunk.payload.toolName === "string" ? chunk.payload.toolName : "";
  context.outcome.sawToolCall = true;
  context.outcome.sawSideEffectToolCall = true;
  context.sawAnyToolCall = true;
  context.sawNonUiToolCall = true;
  context.sawTextAfterLastTool = false;

  if (context.abortController.signal.aborted) {
    return "handled";
  }

  const result = await context.confirmService.requestCommandConfirm({
    state: context.state,
    runId: context.runId,
    toolCallId,
    toolName,
    args: chunk.payload.args,
    aborted: context.abortController.signal.aborted,
    abortSignal: context.abortController.signal,
  });
  if (context.abortController.signal.aborted) {
    if (result.ok) {
      await context.confirmService.cancelRequestedCommandConfirm(
        context.state,
        result.pending,
        "abort-signal",
      );
    }
    return "handled";
  }
  if (!result.ok) {
    const safeReason = "确认没有完成，命令没有执行。请稍后再试。";
    yield* emitOrUpdateToolCall(
      context,
      failedApprovalSpec(toolCallId, toolName, safeReason),
    );
    yield draftingFailedFrame(context.streamId, safeReason);
    context.outcome.producedVisibleFrame = true;
    const pending = context.state.pendingConfirms.get(toolCallId);
    if (pending?.status === "pending" || pending?.status === "resuming") {
      context.wasSuspended = true;
    }
    return "handled";
  }

  context.wasSuspended = true;
  markToolIoSpanSuspended(context.toolIoSpans.get(toolCallId));
  context.toolIoSpans.delete(toolCallId);
  if (result.storedGrantApproval) {
    // 命中记忆时首个可见产物直接是命令卡；pending 表示已确认但尚在会话 FIFO 中。
    yield* emitOrUpdateToolCall(
      context,
      confirmedCommandCardSpec(result.pending, "pending"),
    );
    context.outcome.storedGrantApprovals.push({
      pending: result.pending,
      decisionId: result.storedGrantApproval.decisionId,
    });
    context.outcome.producedVisibleFrame = true;
    return "handled";
  }
  if (toolCallId && toolName) {
    yield* emitOrUpdateToolCall(context, {
      id: toolCallId,
      name: toolName,
      render: { kind: "chatInline" },
      status: { kind: "running", data: { progressPct: null, etaSec: null } },
      // 人工确认时卡片会覆盖此占位；原始参数不得进入 Frame。
      body: { kind: "generic", data: { argsJson: "" } },
      result: null,
    });
  }
  yield result.frame;
  yield* emitProjectedDocState(context.state, "confirm_requested");
  context.outcome.producedVisibleFrame = true;
  return "handled";
}
