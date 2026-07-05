import { describe, expect, it } from "vitest";
import { compileAiDocumentToPm, repairAiIrShorthand } from "../ai-ir/aiIrToPm";
import { getStablePmJson } from "../hash";

// 对抗性输入测试:模型把 run 标记写成"裸字段"简写(线上真实失败形态),
// 此前 Zod 非严格静默剥离 → 链接/样式丢失但 ok:true(假阳性)。修复后应宽容并入 marks。

function linkMarkJsonOf(input: unknown): string {
  const result = compileAiDocumentToPm(input);
  expect(result.ok, JSON.stringify(result.blockErrors)).toBe(true);
  return getStablePmJson(result.doc);
}

type NodeLike = {
  type?: string;
  content?: readonly NodeLike[];
};

function maxListItemDepth(node: NodeLike, insideListItem = false): number {
  const nextInside = insideListItem || node.type === "listItem";
  const selfDepth = insideListItem && node.type === "listItem" ? 1 : 0;
  const childDepth = Math.max(0, ...(node.content ?? []).map((child) => maxListItemDepth(child, nextInside)));
  return selfDepth + childDepth;
}

function compileOk(input: unknown): NonNullable<ReturnType<typeof compileAiDocumentToPm>["doc"]> {
  const result = compileAiDocumentToPm(input);
  expect(result.ok, JSON.stringify(result.blockErrors)).toBe(true);
  if (!result.doc) throw new Error("missing doc");
  return result.doc;
}

describe("repairAiIrShorthand — run 简写宽容修复(对抗脏输入)", () => {
  it('裸 link 字段 {text,link} → 转成 link mark(线上真实 bug:trace 4506f27d)', () => {
    const json = linkMarkJsonOf({
      blocks: [
        { type: "paragraph", runs: [{ text: "参考资料", link: "https://example.com/a" }] },
      ],
    });
    expect(json).toContain('"type":"link"');
    expect(json).toContain('"href":"https://example.com/a"');
  });

  it("裸 href 字段 {text,href} → 转成 link mark", () => {
    const json = linkMarkJsonOf({
      blocks: [{ type: "paragraph", runs: [{ text: "x", href: "https://example.com/b" }] }],
    });
    expect(json).toContain('"href":"https://example.com/b"');
  });

  it("裸布尔 {text,bold:true,italic:true} → 转成 bold/italic mark", () => {
    const json = linkMarkJsonOf({
      blocks: [{ type: "paragraph", runs: [{ text: "强调", bold: true, italic: true }] }],
    });
    expect(json).toContain('"type":"bold"');
    expect(json).toContain('"type":"italic"');
  });

  it("已有规范 marks 不被破坏,且裸字段不产生重复 link mark", () => {
    const repaired = repairAiIrShorthand({
      blocks: [
        {
          type: "paragraph",
          runs: [{ text: "x", link: "https://dup.com", marks: [{ type: "link", href: "https://keep.com" }] }],
        },
      ],
    }) as { blocks: Array<{ runs: Array<{ marks?: Array<{ type: string; href?: string }> }> }> };
    const marks = repaired.blocks[0]!.runs[0]!.marks ?? [];
    const linkMarks = marks.filter((m) => m.type === "link");
    expect(linkMarks).toHaveLength(1);
    expect(linkMarks[0]!.href).toBe("https://keep.com"); // 保留已有,丢弃裸字段
  });

  it("bulletList 条目里的裸 link 也被修复", () => {
    const json = linkMarkJsonOf({
      blocks: [
        { type: "bulletList", items: [[{ text: "条目", link: "https://example.com/list" }]] },
      ],
    });
    expect(json).toContain('"href":"https://example.com/list"');
  });

  it("taskList item.children 里的 run 简写和嵌套块简写也被修复", () => {
    const input = {
      blocks: [
        {
          type: "taskList",
          items: [
            {
              runs: [{ text: "父任务", bold: true }],
              children: [
                {
                  type: "taskList",
                  items: [[{ text: "子任务", link: "https://example.com/task-child" }]],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(repairAiIrShorthand(input)).toMatchObject({
      blocks: [
        {
          type: "taskList",
          items: [
            {
              checked: false,
              runs: [{ text: "父任务", marks: [{ type: "bold" }] }],
              children: [
                {
                  type: "taskList",
                  items: [
                    {
                      checked: false,
                      runs: [{ text: "子任务", marks: [{ type: "link", href: "https://example.com/task-child" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(compileOk(input)).toMatchObject({
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              content: [
                { type: "paragraph" },
                {
                  type: "taskList",
                  content: [{ type: "taskItem" }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("table 单元格 run 里的裸 link 也被修复", () => {
    const json = linkMarkJsonOf({
      blocks: [
        {
          type: "table",
          rows: [{ cells: [{ runs: [{ text: "列", link: "https://example.com/cell" }] }] }],
        },
      ],
    });
    expect(json).toContain('"href":"https://example.com/cell"');
  });

  it("规范输入是 no-op:不改变已经正确的 run", () => {
    const input = {
      blocks: [
        { type: "paragraph", runs: [{ text: "x", marks: [{ type: "link", href: "https://ok.com" }] }] },
      ],
    };
    expect(repairAiIrShorthand(input)).toEqual(input);
  });

  it("非 http 的裸 link 被并入 marks 后由 schema 拒绝(不静默吞)", () => {
    const result = compileAiDocumentToPm({
      blocks: [{ type: "paragraph", runs: [{ text: "x", link: "javascript:alert(1)" }] }],
    });
    // 修复把它并入 link mark → linkHrefSchema 拒绝非法 href → 明确报错,而非静默丢链接。
    expect(result.ok).toBe(false);
  });

  it("模型用缩进项目符号伪装二级列表时,修复为 list item children", () => {
    const input = {
      blocks: [
        {
          type: "bulletList",
          items: [
            { runs: [{ text: "一级目标" }] },
            { runs: [{ text: "  - 二级动作 A" }] },
            { runs: [{ text: "  - 二级动作 B" }] },
            { runs: [{ text: "另一个一级目标" }] },
          ],
        },
      ],
    };

    expect(repairAiIrShorthand(input)).toMatchObject({
      blocks: [
        {
          type: "bulletList",
          items: [
            {
              runs: [{ text: "一级目标" }],
              children: [
                {
                  type: "bulletList",
                  items: [
                    { runs: [{ text: "二级动作 A" }] },
                    { runs: [{ text: "二级动作 B" }] },
                  ],
                },
              ],
            },
            { runs: [{ text: "另一个一级目标" }] },
          ],
        },
      ],
    });

    expect(maxListItemDepth(compileOk(input) as unknown as NodeLike)).toBeGreaterThan(0);
  });

  it("模型用 1.1 / 1.1.1 伪装三级有序列表时,修复为递归 children", () => {
    const input = {
      blocks: [
        {
          type: "orderedList",
          items: [
            { runs: [{ text: "1. 准备阶段" }] },
            { runs: [{ text: "1.1 明确目标" }] },
            { runs: [{ text: "1.1.1 收集资料" }] },
            { runs: [{ text: "2. 执行阶段" }] },
          ],
        },
      ],
    };

    expect(repairAiIrShorthand(input)).toMatchObject({
      blocks: [
        {
          type: "orderedList",
          items: [
            {
              runs: [{ text: "准备阶段" }],
              children: [
                {
                  type: "orderedList",
                  items: [
                    {
                      runs: [{ text: "明确目标" }],
                      children: [
                        {
                          type: "orderedList",
                          items: [{ runs: [{ text: "收集资料" }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            { runs: [{ text: "执行阶段" }] },
          ],
        },
      ],
    });

    expect(maxListItemDepth(compileOk(input) as unknown as NodeLike)).toBeGreaterThan(1);
  });

  it("模型用 ①②③ 伪装子项时,挂到前一个一级条目 children 下", () => {
    const input = {
      blocks: [
        {
          type: "bulletList",
          items: [
            { runs: [{ text: "一级主题" }] },
            { runs: [{ text: "① 子项一" }] },
            { runs: [{ text: "② 子项二" }] },
          ],
        },
      ],
    };

    expect(repairAiIrShorthand(input)).toMatchObject({
      blocks: [
        {
          type: "bulletList",
          items: [
            {
              runs: [{ text: "一级主题" }],
              children: [
                {
                  type: "orderedList",
                  items: [
                    { runs: [{ text: "子项一" }] },
                    { runs: [{ text: "子项二" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
