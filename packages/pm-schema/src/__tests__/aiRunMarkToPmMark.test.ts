import { describe, expect, it } from "vitest";
import {
  aiIrToPm,
  aiRunMarkToPmMark,
  getStablePmJson,
  type AiDocument,
} from "../index";

describe("aiRunMarkToPmMark", () => {
  it("mark-basic: 基础 mark 转成对应 PM mark", () => {
    expect(aiRunMarkToPmMark({ type: "bold" })).toEqual({ type: "bold" });
    expect(aiRunMarkToPmMark({ type: "italic" })).toEqual({ type: "italic" });
    expect(aiRunMarkToPmMark({ type: "underline" })).toEqual({ type: "underline" });
    expect(aiRunMarkToPmMark({ type: "code" })).toEqual({ type: "code" });
  });

  it("mark-strikeNormalize: strikeThrough 与 strike 归一", () => {
    expect(aiRunMarkToPmMark({ type: "strikeThrough" })).toEqual({ type: "strike" });
    expect(aiRunMarkToPmMark({ type: "strike" })).toEqual(
      aiRunMarkToPmMark({ type: "strikeThrough" }),
    );
  });

  it("mark-link: link 保留 href/title", () => {
    expect(aiRunMarkToPmMark({
      type: "link",
      href: "https://example.com",
      title: "示例",
    })).toEqual({
      type: "link",
      attrs: { href: "https://example.com", title: "示例" },
    });
    expect(aiRunMarkToPmMark({ type: "link", href: "#intro" })).toEqual({
      type: "link",
      attrs: { href: "#intro", title: null },
    });
  });

  it("mark-highlight: highlight 保留 color", () => {
    expect(aiRunMarkToPmMark({ type: "highlight", color: "purple" })).toEqual({
      type: "highlight",
      attrs: { color: "purple" },
    });
  });

  it("mark-textColor: textColor 保留 color", () => {
    expect(aiRunMarkToPmMark({ type: "textColor", color: "red" })).toEqual({
      type: "textColor",
      attrs: { color: "red" },
    });
  });

  it("mark-behaviorParity: aiIrToPm 仍走公共转换且输出稳定", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "paragraph",
          runs: [
            { text: "粗", marks: [{ type: "bold" }] },
            { text: "斜", marks: [{ type: "italic" }] },
            { text: "链", marks: [{ type: "link", href: "https://example.com", title: "示例" }] },
            { text: "红", marks: [{ type: "textColor", color: "red" }] },
            { text: "亮", marks: [{ type: "highlight", color: "yellow" }] },
            { text: "删", marks: [{ type: "strikeThrough" }] },
          ],
        },
      ],
    };

    const pm = aiIrToPm(ir);

    expect(getStablePmJson(pm.content[0])).toContain("\"type\":\"strike\"");
    expect(pm.content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { text: "粗", marks: [aiRunMarkToPmMark({ type: "bold" })] },
        { text: "斜", marks: [aiRunMarkToPmMark({ type: "italic" })] },
        { text: "链", marks: [aiRunMarkToPmMark({ type: "link", href: "https://example.com", title: "示例" })] },
        { text: "红", marks: [aiRunMarkToPmMark({ type: "textColor", color: "red" })] },
        { text: "亮", marks: [aiRunMarkToPmMark({ type: "highlight", color: "yellow" })] },
        { text: "删", marks: [aiRunMarkToPmMark({ type: "strikeThrough" })] },
      ],
    });
  });
});
