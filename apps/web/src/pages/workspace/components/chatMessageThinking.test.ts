import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../data/protocol";
import {
  getLastAssistantMessageId,
  getThinkingSummaryLabel,
} from "./chatMessageThinking";

function message(id: string, role: ChatMessage["role"]["kind"]): ChatMessage {
  return {
    id,
    role: { kind: role },
    ts: "2026-01-01T00:00:00.000Z",
    parts: [],
    chips: null,
  };
}

describe("chatMessageThinking helpers", () => {
  it("finds the final assistant message", () => {
    expect(
      getLastAssistantMessageId([
        message("u1", "user"),
        message("a1", "agent"),
        message("s1", "system"),
        message("a2", "agent"),
      ]),
    ).toBe("a2");
  });

  it("returns null when there is no assistant message", () => {
    expect(getLastAssistantMessageId([message("u1", "user")])).toBeNull();
  });

  it("uses active wording only for the final assistant message", () => {
    expect(getThinkingSummaryLabel(12, true, true)).toBe("思考中 · 12 字");
    expect(getThinkingSummaryLabel(12, true, false)).toBe(
      "已思考 · 12 字",
    );
    expect(getThinkingSummaryLabel(12, false, true)).toBe(
      "已思考 · 12 字",
    );
  });
});
