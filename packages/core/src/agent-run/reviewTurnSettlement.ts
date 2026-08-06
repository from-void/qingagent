import type {
  ActionCardData,
  BridgeFrame,
  ReviewContext,
} from "@qingagent/contract-ts";
import type { SessionState } from "../session/sessionState.js";

export type ReviewTurnOutcome = "ok" | "error" | "cancelled";

function statusForOutcome(outcome: ReviewTurnOutcome): NonNullable<ActionCardData["status"]> {
  if (outcome === "ok") return "done";
  if (outcome === "error") return "failed";
  return "aborted";
}

function incompleteReviewModelNote(
  reviewContext: ReviewContext,
  outcome: Exclude<ReviewTurnOutcome, "ok">,
): string {
  const fact = outcome === "cancelled" ? "审查已中止" : "审查未完成";
  return (
    `[系统事实] 上一轮“${reviewContext.templateName}”${fact}，没有完成。` +
    "后续若用户追问进度，必须如实说明这一事实；" +
    "除非本轮实际重新发起并完成审查，否则不得声称“收尾审查”“审查完成”或“已经复核”。"
  );
}

/** 同时更新可恢复 chatHistory 与直播帧，避免静态动作卡在中止后继续显示完成勾。 */
export function settleReviewActionCard(
  state: SessionState,
  messageId: string,
  reviewContext: ReviewContext,
  outcome: ReviewTurnOutcome,
): Extract<BridgeFrame, { kind: "actionCardUpdated" }> | null {
  const message = state.chatHistory.find((item) => item.id === messageId);
  if (!message) return null;
  const partIndex = message.parts.findIndex((part) => part.kind === "actionCard");
  if (partIndex < 0) return null;
  const part = message.parts[partIndex];
  if (!part || part.kind !== "actionCard") return null;

  const card: ActionCardData = {
    ...part.data,
    status: statusForOutcome(outcome),
  };
  message.parts[partIndex] = { kind: "actionCard", data: card };

  if (outcome !== "ok") {
    state.messages.push({
      role: "system",
      content: incompleteReviewModelNote(reviewContext, outcome),
    });
  }

  return {
    kind: "actionCardUpdated",
    data: { messageId, card },
  };
}
