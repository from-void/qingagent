import {
  isSensitiveReviewOrigin,
  maskSensitiveValues,
  type BridgeFrame,
  type MessagePart,
  type ReviewContext,
} from "@qingagent/contract-ts";
import type { AgentStreamTurnContext } from "./agentStreamTurnContext.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
} from "./frames.js";
import {
  appendPartToChatHistory,
  nextSeq,
} from "../session/sessionState.js";

export function isSensitiveReviewTurn(context: AgentStreamTurnContext): boolean {
  const reviewContext = context.requestContext?.get("reviewContext") as ReviewContext | null | undefined;
  return isSensitiveReviewOrigin(reviewContext?.type);
}

function maskStringValues(value: unknown): unknown {
  if (typeof value === "string") return maskSensitiveValues(value);
  if (Array.isArray(value)) return value.map(maskStringValues);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, maskStringValues(child)]),
  );
}

function argsContainSensitiveReviewOrigin(args: Record<string, unknown>): boolean {
  return Array.isArray(args.groups) && args.groups.some((value) => {
    if (!value || typeof value !== "object") return false;
    return isSensitiveReviewOrigin((value as { origin?: unknown }).origin as string | undefined);
  });
}

/** create_annotation_groups 的原始参数只供工具执行；卡片、span 与模型 transcript 一律用此副本。 */
export function maskSensitiveReviewToolArgs(
  context: AgentStreamTurnContext,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    toolName !== "create_annotation_groups"
    || (!isSensitiveReviewTurn(context) && !argsContainSensitiveReviewOrigin(args))
  ) {
    return args;
  }
  return maskStringValues(args) as Record<string, unknown>;
}

/**
 * 敏感类审查的完成文本整段缓冲后再发，避免手机号或邮箱被模型拆成多个 delta 时穿透。
 */
export function flushSensitiveReviewText(
  context: AgentStreamTurnContext,
): BridgeFrame | null {
  if (!isSensitiveReviewTurn(context) || context.sensitiveReviewTextFlushed) return null;
  context.sensitiveReviewTextFlushed = true;
  if (!context.accumulatedText) return null;

  context.accumulatedText = maskSensitiveValues(context.accumulatedText);
  const seq = nextSeq(context.state, context.agentMessageId);
  const part: MessagePart = { kind: "text", data: { body: context.accumulatedText } };
  ensureAgentChatHistoryMessage(context.state, context.agentMessageId);
  appendPartToChatHistory(context.state, context.agentMessageId, part);
  context.outcome.producedVisibleFrame ||= /\S/u.test(context.accumulatedText);
  return chatMessageAppended(context.agentMessageId, seq, part);
}

/**
 * 敏感类审查的推理文本按 reasoning id 整段打码后再发，避免跨 delta 泄漏。
 * 未传 id 时用于流收口，按首次出现顺序清空所有尚未结束的分段。
 */
export function flushSensitiveReviewReasoning(
  context: AgentStreamTurnContext,
  reasoningId?: string,
): BridgeFrame[] {
  if (!isSensitiveReviewTurn(context)) return [];
  const ids = reasoningId === undefined
    ? [...context.sensitiveReviewReasoningBuffers.keys()]
    : [reasoningId];
  const frames: BridgeFrame[] = [];

  for (const id of ids) {
    const buffered = context.sensitiveReviewReasoningBuffers.get(id);
    context.sensitiveReviewReasoningBuffers.delete(id);
    if (!buffered) continue;

    const part: MessagePart = {
      kind: "thinking",
      data: { id, steps: [maskSensitiveValues(buffered)] },
    };
    const seq = nextSeq(context.state, context.agentMessageId);
    ensureAgentChatHistoryMessage(context.state, context.agentMessageId);
    appendPartToChatHistory(context.state, context.agentMessageId, part);
    frames.push(chatMessageAppended(context.agentMessageId, seq, part));
  }

  return frames;
}
