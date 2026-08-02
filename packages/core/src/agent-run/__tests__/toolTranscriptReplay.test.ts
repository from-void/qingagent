import { describe, expect, it } from "vitest";
import { createSession } from "../../session/sessionState.js";
import {
  appendToolTranscriptMessage,
  normalizeLegacyToolTranscriptMessages,
} from "../frames.js";

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

  it("确定性迁移旧会话中的精确回放帧，正常讨论文本保持不变", () => {
    const normalDiscussion = {
      role: "assistant" as const,
      content: "代码里的 [tool-result] 只是一个标记，不代表真的执行了工具。",
    };
    const messages = [
      {
        role: "assistant" as const,
        content: [
          "[tool-result]",
          "toolName: editDraft",
          "toolCallId: call-edit-1",
          'args: {"action":"replaceText","token":"hidden"}',
          'result: {"ok":true,"docVersion":9}',
        ].join("\n"),
      },
      normalDiscussion,
    ];

    const normalized = normalizeLegacyToolTranscriptMessages(messages);

    expect(normalized).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolName: "editDraft",
          toolCallId: "call-edit-1",
          args: { action: "replaceText", token: "hidden" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolName: "editDraft",
          toolCallId: "call-edit-1",
          result: { ok: true, docVersion: 9 },
        }],
      },
      normalDiscussion,
    ]);
    expect(normalized.at(-1)).toBe(normalDiscussion);
    expect(normalizeLegacyToolTranscriptMessages([normalDiscussion])).toEqual([
      normalDiscussion,
    ]);
    expect(normalizeLegacyToolTranscriptMessages(normalized)).toBe(normalized);
  });
});
