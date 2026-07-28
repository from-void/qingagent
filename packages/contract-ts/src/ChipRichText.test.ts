import { describe, expect, it } from "vitest";
import { parseChipRichText, serializeChipRichText } from "./ChipRichText";

describe("chip richText 转义协议", () => {
  it("字面 marker、反斜杠与真实 chip 可无损往返", () => {
    const serialized = serializeChipRichText([
      { kind: "text", text: "字面 {{chip:0}}，路径 C:\\tmp\\" },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
      { kind: "text", text: "，尾部 \\{{chip:9}}" },
    ]);

    expect(parseChipRichText(serialized)).toEqual([
      { kind: "text", text: "字面 {{chip:0}}，路径 C:\\tmp\\" },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
      { kind: "text", text: "，尾部 \\{{chip:9}}" },
    ]);
  });

  it("无冲突正文保持历史 wire 格式，旧消息仍可解析", () => {
    const serialized = serializeChipRichText([
      { kind: "text", text: "请查看 " },
      { kind: "chip", index: 2, marker: "{{chip:2}}" },
    ]);

    expect(serialized).toBe("请查看 {{chip:2}}");
    expect(parseChipRichText(serialized)).toEqual([
      { kind: "text", text: "请查看 " },
      { kind: "chip", index: 2, marker: "{{chip:2}}" },
    ]);
  });

  it("用户字面版本前缀与真实 chip 可无损往返", () => {
    const protocolPrefix = "\u001eqa-chip-rich-text-v1\u001f";
    const serialized = serializeChipRichText([
      { kind: "text", text: `${protocolPrefix}原文` },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
    ]);

    expect(serialized.startsWith(protocolPrefix + protocolPrefix)).toBe(true);
    expect(parseChipRichText(serialized)).toEqual([
      { kind: "text", text: `${protocolPrefix}原文` },
      { kind: "chip", index: 0, marker: "{{chip:0}}" },
    ]);
  });
});
