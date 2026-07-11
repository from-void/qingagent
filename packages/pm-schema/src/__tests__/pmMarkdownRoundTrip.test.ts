import { describe, expect, it } from "vitest";
import { markdownToPm } from "../markdown/markdownToPm";
import { pmToMarkdown } from "../markdown/pmToMarkdown";
import { safeParsePmDoc } from "../validators";

describe("pmMarkdownRoundTrip", () => {
  it("round-trips the restricted markdown block set through PM", () => {
    const markdown = [
      "# 标题",
      "",
      "### 小节",
      "",
      "- 条目一",
      "- 条目二",
      "",
      "> 引用",
      "> 第二行",
      "",
      "| 列 A | 列 B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "| a\\|b | 4 |",
      "",
      "---",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "![图片](/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png)",
    ].join("\n");

    const pm = markdownToPm(markdown);
    const serialized = pmToMarkdown(pm);
    const reparsed = markdownToPm(serialized);

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content.some((node) => node.type === "table")).toBe(true);
    expect(pm.content.some((node) => node.type === "blockquote")).toBe(true);
    expect(reparsed).toEqual(pm);
  });

  it("E6 回归:导出 markdown 表格单元格保留加粗/链接行内 mark(不再丢成纯文本)", () => {
    const pm = {
      type: "doc" as const,
      attrs: { schemaVersion: 1 as const },
      content: [
        {
          type: "table" as const,
          attrs: { blockId: "block-t" },
          content: [
            {
              type: "tableRow" as const,
              content: [
                { type: "tableCell" as const, content: [{ type: "paragraph" as const, attrs: { blockId: "block-h1" }, content: [{ type: "text" as const, text: "表头" }] }] },
              ],
            },
            {
              type: "tableRow" as const,
              content: [
                {
                  type: "tableCell" as const,
                  content: [
                    {
                      type: "paragraph" as const,
                      attrs: { blockId: "block-c1" },
                      content: [
                        { type: "text" as const, text: "粗体", marks: [{ type: "bold" as const }] },
                        { type: "text" as const, text: "与" },
                        { type: "text" as const, text: "链接", marks: [{ type: "link" as const, attrs: { href: "https://example.com" } }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(safeParsePmDoc(pm).success).toBe(true);
    const md = pmToMarkdown(pm);
    expect(md).toContain("**粗体**");
    expect(md).toContain("[链接](https://example.com)");
  });

  it("不会把普通管道文本误判成表格", () => {
    const pm = markdownToPm("A | B 只是普通句子");

    expect(pm.content[0]?.type).toBe("paragraph");
  });

  it("R3-01 解析块级 markdown 的行内 mark、数学块和 mermaid 图表", () => {
    const pm = markdownToPm([
      "# **标题**",
      "",
      "正文含 *斜体*、`code` 和 $E=mc^2$。",
      "",
      "$$",
      String.raw`\frac{1}{2}`,
      "$$",
      "",
      "```mermaid",
      "flowchart TD",
      "A-->B",
      "```",
    ].join("\n"));

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "heading",
      content: [{ type: "text", text: "标题", marks: [{ type: "bold" }] }],
    });
    expect(pm.content[1]).toMatchObject({
      type: "paragraph",
      content: expect.arrayContaining([
        { type: "text", text: "斜体", marks: [{ type: "italic" }] },
        { type: "text", text: "code", marks: [{ type: "code" }] },
        { type: "inlineMath", attrs: { latex: "E=mc^2" } },
      ]),
    });
    expect(pm.content[2]).toMatchObject({ type: "blockMath", attrs: { latex: String.raw`\frac{1}{2}` } });
    expect(pm.content[3]).toMatchObject({ type: "diagram", attrs: { lang: "mermaid" } });
  });

  it("递归解析粗斜体内的 code、行内公式与嵌套 mark", () => {
    const boldWithCode = markdownToPm("**a `b` c**");
    const italicWithMath = markdownToPm("*x $y$ z*");
    const nestedMarks = markdownToPm("**斜体*嵌套***");
    const plainBold = markdownToPm("**bold**");

    expect(safeParsePmDoc(boldWithCode).success).toBe(true);
    expect(boldWithCode.content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "a ", marks: [{ type: "bold" }] },
        { type: "text", text: "b", marks: [{ type: "code" }] },
        { type: "text", text: " c", marks: [{ type: "bold" }] },
      ],
    });

    expect(safeParsePmDoc(italicWithMath).success).toBe(true);
    expect(italicWithMath.content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "x ", marks: [{ type: "italic" }] },
        { type: "inlineMath", attrs: { latex: "y" } },
        { type: "text", text: " z", marks: [{ type: "italic" }] },
      ],
    });

    expect(nestedMarks.content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "斜体", marks: [{ type: "bold" }] },
        { type: "text", text: "嵌套", marks: [{ type: "italic" }, { type: "bold" }] },
      ],
    });
    expect(plainBold.content[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }],
    });
  });

  it("R4-013 解析 markdown task item 为 taskList/taskItem", () => {
    const pm = markdownToPm(["- [ ] 未完成", "- [x] 已完成", "- [X] 也完成"].join("\n"));

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: false }),
          content: [{ type: "paragraph", content: [{ type: "text", text: "未完成" }] }],
        },
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: true }),
          content: [{ type: "paragraph", content: [{ type: "text", text: "已完成" }] }],
        },
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: true }),
          content: [{ type: "paragraph", content: [{ type: "text", text: "也完成" }] }],
        },
      ],
    });
  });

  it("R5-11 保留 taskItem 下的缩进 bullet 子项", () => {
    const pm = markdownToPm(["- [ ] task one", "- [x] task two", "  - nested child"].join("\n"));

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "task one" }] }],
        },
        {
          type: "taskItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "task two" }] },
            {
              type: "bulletList",
              content: [{
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "nested child" }] }],
              }],
            },
          ],
        },
      ],
    });
  });

  it("导出 markdown 时保留 taskList 子 taskList 层级", () => {
    const pm = markdownToPm(["- [ ] 父任务", "  - [x] 子任务", "  - 普通补充项"].join("\n"));

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pmToMarkdown(pm)).toBe(["- [ ] 父任务", "  - [x] 子任务", "  - 普通补充项"].join("\n"));
  });

  it("R4-013 保留多级缩进列表的嵌套结构", () => {
    const pm = markdownToPm(
      Array.from({ length: 8 }, (_, index) => `${"  ".repeat(index)}- L${index + 1}`).join("\n"),
    );

    expect(safeParsePmDoc(pm).success).toBe(true);
    let node = pm.content[0];
    for (let depth = 1; depth <= 8; depth += 1) {
      expect(node?.type).toBe("bulletList");
      if (node?.type !== "bulletList") throw new Error(`expected bulletList at depth ${depth}`);
      const item = node.content[0];
      const paragraph = item?.content[0];
      expect(paragraph?.type).toBe("paragraph");
      expect(paragraph?.type === "paragraph" ? paragraph.content?.[0] : undefined).toMatchObject({
        type: "text",
        text: `L${depth}`,
      });
      node = item?.content.find((child) => child.type === "bulletList");
    }
  });
});
