import {
  sanitizeVisibleText,
  type BridgeFrame,
  type MessagePart,
} from "@qingagent/contract-ts";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";

function messagePartIsUserVisible(
  context: AgentStreamTurnContext,
  part: MessagePart,
): boolean {
  if (part.kind === "thinking") return false;
  if (part.kind === "text") {
    // Mastra 的 text-delta 是增量分片。任何单片（包括当下累计前缀）都不足以
    // 证明合并后的完整文本能通过前端过滤；统一留到 finalize 再复算。
    return false;
  }
  return true;
}

/**
 * 流结束时才用前端同一规则检查完整文本；此前的 true 只可能来自工具卡、
 * 文档、批注等非文本可见帧，因此用 OR 保留这些既有可见产物。
 */
export function recomputeUserVisibleOutput(
  context: AgentStreamTurnContext,
): boolean {
  context.hasUserVisibleOutput =
    context.hasUserVisibleOutput ||
    sanitizeVisibleText(context.accumulatedText) !== null;
  return context.hasUserVisibleOutput;
}

function frameIsUserVisible(
  context: AgentStreamTurnContext,
  frame: BridgeFrame,
): boolean {
  switch (frame.kind) {
    case "chatMessageAdded":
      return (
        frame.data.message.role.kind === "agent" &&
        frame.data.message.parts.some((part) => messagePartIsUserVisible(context, part))
      );
    case "chatMessageAppended":
      return messagePartIsUserVisible(context, frame.data.part);
    case "actionCardUpdated":
      return true;
    case "toolCallUpdated": {
      const message = context.state.chatHistory.find(
        (item) => item.id === frame.data.messageId,
      );
      return message?.parts.some(
        (part) =>
          part.kind === "toolCall" &&
          part.data.id === frame.data.toolCallId,
      ) === true;
    }
    case "confirmRequested":
    case "confirmResolved":
    case "documentSnapshotWritten":
    case "docGenerationEvent":
    case "docCommitted":
    case "docDiffReady":
    case "docWriteResult":
    case "annotationGroupsReady":
    case "annotationPreview":
    case "todosChanged":
    case "resourceUpserted":
    case "resourceUpdated":
    case "resourceRemoved":
      return true;
    case "stream":
      return frame.data.kind === "draftingFailed";
    default:
      // stream start/end、reasoning、annotationPreviewCleared、busy 状态切换及
      // 纯协议/元数据帧都不能证明本轮给了用户可消费的结果。
      return false;
  }
}

export async function* trackUserVisibleFrames<TReturn>(
  context: AgentStreamTurnContext,
  source: AsyncGenerator<BridgeFrame, TReturn>,
): AsyncGenerator<BridgeFrame, TReturn> {
  let completed = false;
  try {
    for (;;) {
      const next = await source.next();
      if (next.done) {
        completed = true;
        return next.value;
      }
      if (frameIsUserVisible(context, next.value)) {
        context.hasUserVisibleOutput = true;
      }
      yield next.value;
    }
  } finally {
    if (!completed) {
      await source.return(undefined as never);
    }
  }
}
