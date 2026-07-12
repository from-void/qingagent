import type { BridgeFrame, MessagePart } from "@qingagent/contract-ts";
import type { AgentStreamEvent } from "./agentStreamEvents.js";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import { chatMessageAppended, newId } from "./frames.js";
import { appendPartToChatHistory, nextSeq } from "../session/sessionState.js";
import { isLikelyInternalTextDelta } from "./streamErrors.js";

export async function* handleTextAndReasoningEvent(
  context: AgentStreamTurnContext,
  chunk: AgentStreamEvent,
): AsyncGenerator<BridgeFrame, boolean> {
  const { state, agentMessageId } = context;
  if (chunk.type === "text-delta") {
    const text = typeof chunk.payload.text === "string" ? chunk.payload.text : "";
    if (isLikelyInternalTextDelta(text)) {
      context.lastModelChunkAt = new Date().toISOString();
      return true;
    }
    context.accumulatedText += text;
    context.sawTextAfterLastTool = true;
    context.lastModelChunkAt = new Date().toISOString();
    const seq = nextSeq(state, agentMessageId);
    const textPart: MessagePart = { kind: "text", data: { body: text } };
    yield chatMessageAppended(agentMessageId, seq, textPart);
    context.outcome.producedVisibleFrame = true;
    appendPartToChatHistory(state, agentMessageId, textPart);
    return true;
  }

  if (chunk.type === "reasoning-start") {
    context.reasoningId = chunk.payload.id ?? newId();
    return true;
  }
  if (chunk.type === "reasoning-delta") {
    const delta = chunk.payload.text ?? "";
    if (delta.length > 0) {
      const seq = nextSeq(state, agentMessageId);
      const thinkingPart: MessagePart = {
        kind: "thinking",
        data: {
          id: context.reasoningId ?? newId(),
          steps: [delta],
        },
      };
      yield chatMessageAppended(agentMessageId, seq, thinkingPart);
      appendPartToChatHistory(state, agentMessageId, thinkingPart);
    }
    return true;
  }
  if (chunk.type === "reasoning-end") {
    context.reasoningId = null;
    context.lastModelChunkAt = new Date().toISOString();
    return true;
  }
  return false;
}
