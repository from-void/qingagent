import type { BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";

function messagePartIsUserVisible(
  context: AgentStreamTurnContext,
  part: MessagePart,
): boolean {
  if (part.kind === "thinking") return false;
  if (part.kind === "text") {
    // 不丢弃单个空白 delta：空格可能连接相邻分块。只看整轮累计文本是否已经
    // 出现非空白字符，避免纯空白流被误判为可见回复。
    return /\S/u.test(context.accumulatedText);
  }
  return true;
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
