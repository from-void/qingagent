import { describe, expect, it } from "vitest";
import { createSession } from "../../session/sessionState.js";
import { appendToolTranscriptMessage } from "../frames.js";

describe("tool transcript replay", () => {
  it("把工具调用与结果按标准角色结构写入模型历史，而不是 assistant 正文", () => {
    const state = createSession("structured-tool-transcript");

    appendToolTranscriptMessage(state, {
      toolName: "readDraft",
      toolCallId: "call-read-1",
      args: { mode: "full", apiKey: "secret" },
      result: { docVersion: 9, ok: true },
    });

    expect(state.messages).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolName: "readDraft",
          toolCallId: "call-read-1",
          args: { mode: "full", apiKey: "***" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolName: "readDraft",
          toolCallId: "call-read-1",
          result: { docVersion: 9, ok: true },
        }],
      },
    ]);
    expect(JSON.stringify(state.messages)).not.toContain("[tool-result]");
  });
});
