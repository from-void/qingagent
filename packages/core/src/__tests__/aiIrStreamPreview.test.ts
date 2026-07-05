import { describe, expect, it } from "vitest";
import { extractStreamingText, tailExcerpt } from "../utils/aiIrStreamPreview.js";

// 写稿小卡片的流式正文提取:输入是半截 AI-IR JSON(脏路径),不走 JSON.parse

describe("extractStreamingText 半截 JSON 容错提取", () => {
  it("完整 JSON:按顺序提取所有 text 值", () => {
    const raw = '[{"type":"heading","level":1,"runs":[{"text":"标题"}]},{"type":"paragraph","runs":[{"text":"第一段。"},{"text":"加粗尾巴","marks":[{"type":"bold"}]}]}]';
    expect(extractStreamingText(raw)).toBe("标题\n第一段。\n加粗尾巴");
  });

  it("流式半截:最后一个未闭合的字符串也要提出来(实时预览的关键)", () => {
    const raw = '[{"type":"paragraph","runs":[{"text":"写完的段落。"}]},{"type":"paragraph","runs":[{"text":"正在写到一半的句';
    expect(extractStreamingText(raw)).toBe("写完的段落。\n正在写到一半的句");
  });

  it("正文里的转义引号与换行不破坏提取", () => {
    const raw = '[{"type":"paragraph","runs":[{"text":"他说:\\"你好\\"。\\n换行后"}]}]';
    expect(extractStreamingText(raw)).toBe('他说:"你好"。\n换行后');
  });

  it("空输入与无 text 字段返回空串", () => {
    expect(extractStreamingText("")).toBe("");
    expect(extractStreamingText('[{"type":"horizontalRule"}')).toBe("");
  });
});

describe("tailExcerpt 滚动摘录", () => {
  it("短文本原样返回(空白压平)", () => {
    expect(tailExcerpt("你好\n世界")).toBe("你好 世界");
  });
  it("长文本取末尾 N 个码点", () => {
    const text = "甲".repeat(100) + "结尾十个字符在这里啦";
    expect(tailExcerpt(text, 10)).toBe("结尾十个字符在这里啦");
  });
});
