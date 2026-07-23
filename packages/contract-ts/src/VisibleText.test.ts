import { describe, expect, it } from "vitest";
import { sanitizeVisibleText } from "./VisibleText";

describe("sanitizeVisibleText", () => {
  it.each([
    ["纯空白", " \r\n\t "],
    ["工具结果标记", "[tool-result] raw args/result"],
    ["AI-IR", "AI-IR draft payload"],
    [
      "fence 内部 JSON",
      '```json\n{"blocks":[{"id":"block-a","numericValue":3}]}\n```',
    ],
    [
      "前导内部 JSON",
      '{"tool":"editDraft","args":{"blockId":"block-a"},"result":{"ok":true}}',
    ],
  ])("%s 会被完整过滤", (_label, body) => {
    expect(sanitizeVisibleText(body)).toBeNull();
  });

  it("只移除内部过程行，保留并规范化真实回复", () => {
    expect(
      sanitizeVisibleText(
        "Let me inspect the request.\r\n这是第一行。\r\nI should call the tool.\r\n这是第二行。",
      ),
    ).toBe("这是第一行。\n这是第二行。");
  });

  it("正文里的普通括号、转义引号与 JSON 字样不会被误删", () => {
    const body = '结果包含字符 ] }、转义引号 \\"，以及普通的 JSON 说明。';
    expect(sanitizeVisibleText(body)).toBe(body);
  });
});
