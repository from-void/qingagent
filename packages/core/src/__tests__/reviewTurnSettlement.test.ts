import { describe, expect, it } from "vitest";
import type { ChatMessage, ReviewContext } from "@qingagent/contract-ts";
import { createSession } from "../session/sessionState.js";
import { settleReviewActionCard } from "../agent-run/reviewTurnSettlement.js";

const reviewContext: ReviewContext = {
  type: "consistency",
  templateId: "review-consistency-default",
  templateName: "全面自洽核查",
};

function reviewMessage(): ChatMessage {
  return {
    id: "review-user-message",
    role: { kind: "user" },
    ts: "2026-08-05T10:00:00.000Z",
    parts: [{
      kind: "actionCard",
      data: {
        title: "一致性审查",
        lines: [{ label: "模板", value: "全面自洽核查" }],
        status: "running",
      },
    }],
    chips: null,
  };
}

describe("settleReviewActionCard", () => {
  it("审查中止时把静态勾改成可恢复终态，并给接管轮写入禁止冒充收尾的事实", () => {
    const state = createSession("review-aborted");
    state.chatHistory.push(reviewMessage());

    const frame = settleReviewActionCard(
      state,
      "review-user-message",
      reviewContext,
      "cancelled",
    );

    expect(frame).toEqual({
      kind: "actionCardUpdated",
      data: {
        messageId: "review-user-message",
        card: {
          title: "一致性审查",
          lines: [{ label: "模板", value: "全面自洽核查" }],
          status: "aborted",
        },
      },
    });
    expect(state.chatHistory[0]?.parts[0]).toMatchObject({
      kind: "actionCard",
      data: { status: "aborted" },
    });
    expect(state.messages.at(-1)).toMatchObject({
      role: "system",
      content: expect.stringContaining("审查已中止"),
    });
    expect(String(state.messages.at(-1)?.content)).toContain("不得声称");
    expect(String(state.messages.at(-1)?.content)).toContain("收尾审查");
  });

  it.each([
    ["ok", "done"],
    ["error", "failed"],
  ] as const)("审查 %s 时落 %s 卡片终态", (outcome, status) => {
    const state = createSession(`review-${outcome}`);
    state.chatHistory.push(reviewMessage());

    const frame = settleReviewActionCard(
      state,
      "review-user-message",
      reviewContext,
      outcome,
    );

    expect(frame?.data.card.status).toBe(status);
  });
});
