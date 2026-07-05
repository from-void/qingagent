import type { ChatMessage } from "../data/protocol";

export function getLastAssistantMessageId(
  messages: readonly ChatMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role.kind === "agent") return message.id;
  }
  return null;
}

export function getThinkingSummaryLabel(
  textLength: number,
  streamActive: boolean,
  isLastAssistantMessage: boolean,
): string {
  const prefix =
    streamActive && isLastAssistantMessage ? "思考中" : "已思考";
  return `${prefix} · ${textLength} 字`;
}
