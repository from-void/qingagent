import { describe, expect, it } from "vitest";
import { sanitizeVisibleText } from "./VisibleText";

describe("sanitizeVisibleText", () => {
  it.each([
    ["纯空白", " \r\n\t "],
    [
      "带来源标记和完整字段的工具结果帧",
      [
        "[tool-result]",
        "toolName: editDraft",
        "toolCallId: call-1",
        'args: {"blockId":"block-a"}',
        'result: {"ok":true}',
      ].join("\n"),
    ],
  ])("%s 会被完整过滤", (_label, body) => {
    expect(sanitizeVisibleText(body)).toBeNull();
  });

  it.each([
    ["技术术语", "AI-IR 使用 numericValue 和 block-section 表达 tool call。"],
    [
      "英文过程式句首",
      "Let me explain the protocol.\nI will show a legal example.\n这是完整回复。",
    ],
    [
      "技术 JSON 代码",
      '```json\n{"blocks":[{"id":"block-a","numericValue":3}]}\n```',
    ],
    [
      "协议标记示例",
      "代码里的 [tool-result] 只是文档示例，不是内部来源帧。",
    ],
    [
      "系统提示词说明",
      "The system prompt may include a developer instruction.",
    ],
  ])("%s 默认完整保留", (_label, body) => {
    expect(sanitizeVisibleText(body)).toBe(body);
  });

  it("正文里的普通括号、转义引号与 JSON 字样不会被误删", () => {
    const body = '结果包含字符 ] }、转义引号 \\"，以及普通的 JSON 说明。';
    expect(sanitizeVisibleText(body)).toBe(body);
  });
});
