import { describe, expect, it } from "vitest";
import { compileAiDocumentWithBlockRetry } from "../tools/generateDoc.js";

// 「最难任务」覆盖:一篇用尽所有 block 类型 + 所有 inline marks 的富样式文档,
// 跑完整管线(AI-IR → PM doc),确保每一环都不挂。
// 这是搜索链路那类"长文+复杂结构"bug 的根防线:任何 block/mark 在管线任一环掉链子都会被这条测出来。
const RICH_BLOCKS: unknown[] = [
  { type: "heading", level: 1, runs: [{ text: "AI 产业全景报道" }] },
  { type: "heading", level: 2, runs: [{ text: "一、投资与成本", marks: [{ type: "bold" }] }] },
  {
    type: "paragraph",
    textAlign: "left",
    runs: [
      { text: "普通文字，" },
      { text: "加粗", marks: [{ type: "bold" }] },
      { text: "、" },
      { text: "斜体", marks: [{ type: "italic" }] },
      { text: "、" },
      { text: "下划线", marks: [{ type: "underline" }] },
      { text: "、" },
      { text: "删除线", marks: [{ type: "strike" }] },
      { text: "、" },
      { text: "行内代码", marks: [{ type: "code" }] },
      { text: "、" },
      { text: "高亮", marks: [{ type: "highlight", color: "yellow" }] },
      { text: "、" },
      { text: "链接", marks: [{ type: "link", href: "https://example.com" }] },
      { text: "。" },
    ],
  },
  { type: "blockquote", runs: [{ text: "“瓶颈不再是模型，而是组织。”——某报告原话" }] },
  {
    type: "bulletList",
    items: [[{ text: "无序要点一" }], [{ text: "无序要点二" }]],
  },
  {
    type: "orderedList",
    items: [[{ text: "有序步骤一" }], [{ text: "有序步骤二" }]],
  },
  { type: "codeBlock", language: "ts", text: "const cost = 0.1; // 每百万 token" },
  {
    type: "table",
    rows: [
      {
        cells: [
          { blocks: [{ type: "paragraph", runs: [{ text: "厂商" }] }], header: true },
          { blocks: [{ type: "paragraph", runs: [{ text: "参数" }] }], header: true },
        ],
      },
      {
        cells: [
          { blocks: [{ type: "paragraph", runs: [{ text: "DeepSeek-V4" }] }] },
          { blocks: [{ type: "paragraph", runs: [{ text: "284B/13B" }] }] },
        ],
      },
    ],
  },
  { type: "horizontalRule" },
  { type: "penNote", runs: [{ text: "旁注：数据来源见文末。" }] },
  { type: "paragraph", textAlign: "left", runs: [{ text: "结语段落。" }] },
];

describe("富样式文档全覆盖(最难任务)", () => {
  it("AI-IR → PM → legacySections 整条管线都能保留所有 block/mark", async () => {
    const result = await compileAiDocumentWithBlockRetry({
      title: "AI 产业全景报道",
      blocks: RICH_BLOCKS,
    });

    // 1) 生成成功 + output 校验通过(quote/hr/list 那次 bug 的根回归)
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    // 2) PM doc 覆盖所有 block type
    const pmTypes = new Set<string>(result.doc.content.map((n) => n.type));
    for (const t of [
      "heading",
      "paragraph",
      "blockquote",
      "bulletList",
      "orderedList",
      "codeBlock",
      "table",
      "horizontalRule",
    ]) {
      expect(pmTypes.has(t)).toBe(true);
    }

    // 4) inline marks 仍保留在 PM canonical 内。
    const paragraph = result.doc.content.find((node) => node.type === "paragraph");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"bold\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"italic\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"underline\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"strike\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"code\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"highlight\"");
    expect(JSON.stringify(paragraph)).toContain("\"type\":\"link\"");
  });
});
