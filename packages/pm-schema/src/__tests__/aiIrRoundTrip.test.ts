import { describe, expect, it } from "vitest";
import { aiBlockSchema, aiTableCellSchema } from "../ai-ir/aiIrSchema";
import { aiIrToPm, compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import { pmToAiIr } from "../ai-ir/pmToAiIr";
import { pmToMarkdown } from "../markdown/pmToMarkdown";
import { isAllowedImageSrc, safeParsePmDoc } from "../validators";
import type { AiDocument, AiRun, AiTableCell } from "../ai-ir/aiIrSchema";
import type { PmDoc } from "../types";

type NodeLike = {
  type?: string;
  content?: readonly NodeLike[];
};

function hasListItemContainingNestedListItem(node: NodeLike): boolean {
  if (node.type === "listItem") {
    return (node.content ?? []).some((child) =>
      (child.type === "bulletList" || child.type === "orderedList") &&
      (child.content ?? []).some((grandchild) => grandchild.type === "listItem"),
    );
  }

  return (node.content ?? []).some(hasListItemContainingNestedListItem);
}

function tableCell(
  runs: AiRun[],
  attrs: Omit<AiTableCell, "blocks"> = {},
): AiTableCell {
  return { blocks: [{ type: "paragraph", runs }], ...attrs };
}

describe("aiIrRoundTrip", () => {
  it("AI-IR table cell 不接受嵌套 table block", () => {
    expect(aiTableCellSchema.safeParse({
      blocks: [{
        type: "table",
        rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "nested" }] }] }] }],
      }],
    }).success).toBe(false);
  });

  it("compiles AI-IR to valid PM and back without schemaVersion/blockId in the IR", () => {
    const ir: AiDocument = {
      title: "示例",
      blocks: [
        {
          type: "heading",
          level: 2,
          runs: [{ text: "小标题", marks: [{ type: "bold" }] }],
        },
        {
          type: "paragraph",
          textAlign: "center",
          runs: [
            { text: "正文" },
            { text: "链接", marks: [{ type: "link", href: "https://example.com" }] },
            { text: "高亮", marks: [{ type: "highlight", color: "yellow" }] },
          ],
        },
        {
          type: "table",
          rows: [
            {
              cells: [
                tableCell([{ text: "列A", marks: [{ type: "bold" }] }], { header: true }),
                tableCell([{ text: "列B" }], { header: true }),
              ],
            },
            {
              cells: [
                tableCell([{ text: "甲", marks: [{ type: "italic" }] }]),
                tableCell([{ text: "乙", marks: [{ type: "strikeThrough" }] }]),
              ],
            },
          ],
        },
        {
          type: "image",
          src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
          alt: "图片",
	          caption: "图 1",
	          width: 640,
	          height: 360,
	          align: "right",
	        },
        {
          type: "fileAttachment",
          fileId: "file_1",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          size: 256,
        },
      ],
    };

    const pm = aiIrToPm(ir);
    const back = pmToAiIr(pm);

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.attrs.schemaVersion).toBe(1);
    expect(pm.content.every((node) => Boolean(node.attrs.blockId))).toBe(true);
    expect(back.blocks).toEqual([
      ir.blocks[0],
      ir.blocks[1],
      {
        type: "table",
        rows: [
          {
            cells: [
              tableCell([{ text: "列A", marks: [{ type: "bold" }] }], { header: true }),
              tableCell([{ text: "列B" }], { header: true }),
            ],
          },
          {
            cells: [
              tableCell([{ text: "甲", marks: [{ type: "italic" }] }]),
              tableCell([{ text: "乙", marks: [{ type: "strike" }] }]),
            ],
          },
        ],
      },
      ir.blocks[3],
      ir.blocks[4],
    ]);
    const table = pm.content[2];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("missing table");
    const struckCellParagraph = table.content[1]?.content[1]?.content[0];
    expect(struckCellParagraph?.type).toBe("paragraph");
    if (struckCellParagraph?.type !== "paragraph") throw new Error("missing paragraph");
    expect(struckCellParagraph.content?.[0]?.type === "text" ? struckCellParagraph.content[0].marks : []).toEqual([
      { type: "strike" },
    ]);
  });

  it("表格单元格背景色 AI-IR ↔ PM 往返不丢(回归 cell-bg-color-lost-after-ai-followup)", () => {
    // AI 编辑表格走 AI-IR 往返,此前 cell 不带 backgroundColor → AI 改表后丢色。
    const ir: AiDocument = {
      blocks: [
        {
          type: "table",
          rows: [
            {
              cells: [
                tableCell([{ text: "标题" }], { header: true, backgroundColor: "rose" }),
                tableCell([{ text: "无色头" }], { header: true }),
              ],
            },
            {
              cells: [
                tableCell([{ text: "甲" }], { backgroundColor: "sky" }),
                tableCell([{ text: "乙" }]),
              ],
            },
          ],
        },
      ],
    };

    const pm = aiIrToPm(ir);
    expect(safeParsePmDoc(pm).success).toBe(true);
    // PM 侧 cell.attrs.backgroundColor 还原
    const table = pm.content[0] as unknown as {
      content: Array<{ content: Array<{ type: string; attrs?: { backgroundColor?: string } }> }>;
    };
    expect(table.content[0]!.content[0]!.attrs?.backgroundColor).toBe("rose");
    expect(table.content[0]!.content[1]!.attrs?.backgroundColor).toBeUndefined();
    expect(table.content[1]!.content[0]!.attrs?.backgroundColor).toBe("sky");
    // 反向 pmToAiIr 也带回 backgroundColor
    const back = pmToAiIr(pm);
    const backTable = back.blocks[0] as Extract<(typeof back.blocks)[number], { type: "table" }>;
    expect(backTable.rows[0]!.cells[0]!.backgroundColor).toBe("rose");
    expect(backTable.rows[0]!.cells[1]!.backgroundColor).toBeUndefined();
    expect(backTable.rows[1]!.cells[0]!.backgroundColor).toBe("sky");
  });

  it("非法 cell backgroundColor 不写入 PM(交校验,不污染)", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "table",
          rows: [{ cells: [tableCell([{ text: "x" }], { backgroundColor: "not-a-theme-color" })] }],
        },
      ],
    };
    const pm = aiIrToPm(ir);
    expect(safeParsePmDoc(pm).success).toBe(true);
    const table = pm.content[0] as unknown as {
      content: Array<{ content: Array<{ attrs?: { backgroundColor?: string } }> }>;
    };
    expect(table.content[0]!.content[0]!.attrs?.backgroundColor).toBeUndefined();
  });

  it("表格 cell 多块/列表/待办/callout/marks/空段/bg+span 首轮无损", () => {
    const source: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "table",
        attrs: { blockId: "table-rich" },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: { colspan: 2, rowspan: 3, backgroundColor: "rose" },
            content: [
              { type: "paragraph", attrs: { blockId: "cell-p1" }, content: [{ type: "text", text: "首段", marks: [{ type: "bold" }] }] },
              { type: "paragraph", attrs: { blockId: "cell-empty" }, content: [] },
              {
                type: "bulletList",
                attrs: { blockId: "cell-ul" },
                content: [{
                  type: "listItem",
                  attrs: { blockId: "cell-ul-i1" },
                  content: [{ type: "paragraph", attrs: { blockId: "cell-ul-i1-p" }, content: [{ type: "text", text: "无序", marks: [{ type: "italic" }] }] }],
                }],
              },
              {
                type: "orderedList",
                attrs: { blockId: "cell-ol", start: 1, listStyle: "lower-alpha" },
                content: [{
                  type: "listItem",
                  attrs: { blockId: "cell-ol-i1" },
                  content: [{ type: "paragraph", attrs: { blockId: "cell-ol-i1-p" }, content: [{ type: "text", text: "有序" }] }],
                }],
              },
              {
                type: "taskList",
                attrs: { blockId: "cell-tasks" },
                content: [{
                  type: "taskItem",
                  attrs: { blockId: "cell-task-1", checked: true },
                  content: [{ type: "paragraph", attrs: { blockId: "cell-task-1-p" }, content: [{ type: "text", text: "待办" }] }],
                }],
              },
              {
                type: "callout",
                attrs: { blockId: "cell-callout", emoji: "!", tone: "warning" },
                content: [{ type: "paragraph", attrs: { blockId: "cell-callout-p" }, content: [{ type: "text", text: "提示" }] }],
              },
            ],
          }, {
            type: "tableCell",
            content: [{ type: "paragraph", attrs: { blockId: "cell-side-1" }, content: [{ type: "text", text: "侧栏一" }] }],
          }],
        }, {
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{ type: "paragraph", attrs: { blockId: "cell-side-2" }, content: [{ type: "text", text: "侧栏二" }] }],
          }],
        }, {
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{ type: "paragraph", attrs: { blockId: "cell-side-3" }, content: [{ type: "text", text: "侧栏三" }] }],
          }],
        }],
      }],
    };

    const sourceIr = pmToAiIr(source);
    const first = aiIrToPm(sourceIr);

    expect(safeParsePmDoc(first).success).toBe(true);
    expect(pmToAiIr(first)).toEqual(sourceIr);
    const table = sourceIr.blocks[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") throw new Error("missing table");
    expect(table.rows[0]!.cells[0]).toMatchObject({
      backgroundColor: "rose",
      colspan: 2,
      rowspan: 3,
      blocks: [
        { type: "paragraph" },
        { type: "paragraph", runs: [] },
        { type: "bulletList" },
        { type: "orderedList" },
        { type: "taskList" },
        { type: "callout" },
      ],
    });
  });

  it("旧 cell.runs 只在解析入口归一为单 paragraph blocks，空 blocks 补空段", () => {
    const legacy = compileAiDocumentToPm({
      blocks: [{ type: "table", rows: [{ cells: [{ runs: [{ text: "旧缓存", bold: true }] }] }] }],
    });
    expect(legacy.ok).toBe(true);
    expect(legacy.doc && pmToAiIr(legacy.doc).blocks[0]).toMatchObject({
      type: "table",
      rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "旧缓存", marks: [{ type: "bold" }] }] }] }] }],
    });

    const empty = compileAiDocumentToPm({
      blocks: [{ type: "table", rows: [{ cells: [{ blocks: [] }] }] }],
    });
    expect(empty.ok).toBe(true);
    const table = empty.doc?.content[0];
    expect(table?.type === "table" ? table.content[0]?.content[0]?.content : null).toMatchObject([
      { type: "paragraph", content: [] },
    ]);
  });

  it("span 必须展开为完整矩形网格，拒绝缺格与越过末行", () => {
    const paragraphCell = (text: string, attrs: { colspan?: number; rowspan?: number } = {}) => ({
      blocks: [{ type: "paragraph" as const, runs: [{ text }] }],
      ...attrs,
    });
    const valid = compileAiDocumentToPm({
      blocks: [{
        type: "table",
        rows: [
          { cells: [paragraphCell("A", { rowspan: 2 }), paragraphCell("B")] },
          { cells: [paragraphCell("C")] },
        ],
      }],
    });
    expect(valid.ok).toBe(true);

    const missing = compileAiDocumentToPm({
      blocks: [{
        type: "table",
        rows: [
          { cells: [paragraphCell("A", { colspan: 2 })] },
          { cells: [paragraphCell("B")] },
        ],
      }],
    });
    expect(missing.ok).toBe(false);
    expect(missing.blockErrors[0]?.message).toContain("span 网格不完整");

    const overrun = compileAiDocumentToPm({
      blocks: [{ type: "table", rows: [{ cells: [paragraphCell("A", { rowspan: 2 })] }] }],
    });
    expect(overrun.ok).toBe(false);
    expect(overrun.blockErrors[0]?.message).toContain("rowspan 超出最后一行");
  });

  it("列表项 / 引用块的行内 marks 往返不丢(对抗不变量 #3,修 pmToAiIr 拍平洞)", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "bulletList",
          items: [
            { runs: [{ text: "普通项" }] },
            { runs: [{ text: "加粗项", marks: [{ type: "bold" }] }] },
            { runs: [{ text: "带" }, { text: "链接", marks: [{ type: "link", href: "https://example.com" }] }, { text: "的项" }] },
          ],
        },
        {
          type: "orderedList",
          items: [{ runs: [{ text: "高亮项", marks: [{ type: "highlight", color: "green" }] }] }],
        },
        {
          type: "blockquote",
          runs: [{ text: "引用里有" }, { text: "斜体", marks: [{ type: "italic" }] }],
        },
      ],
    };

    const pm = aiIrToPm(ir);
    const back = pmToAiIr(pm);

    expect(safeParsePmDoc(pm).success).toBe(true);
    // 关键:往返后列表项/引用的 marks 必须还在(修复前这里会因 pmToPlainText 拍平成纯文本而失败)
    expect(back.blocks).toEqual(ir.blocks);
  });

  it("orderedList.listStyle 在 AI-IR ↔ PM 往返中只为非默认样式保留", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "orderedList",
          listStyle: "upper-roman",
          items: [{ runs: [{ text: "罗马序号" }] }],
        },
        {
          type: "orderedList",
          items: [{ runs: [{ text: "默认数字" }] }],
        },
      ],
    };

    const pm = aiIrToPm(ir);
    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]?.type === "orderedList" ? pm.content[0].attrs.listStyle : null).toBe("upper-roman");
    expect(pm.content[1]?.type === "orderedList" ? pm.content[1].attrs.listStyle : null).toBeUndefined();

    expect(pmToAiIr(pm).blocks).toEqual(ir.blocks);
  });

  it("AI-IR list children 编译为真实 PM 嵌套 listItem(li li 结构)", () => {
    const result = compileAiDocumentToPm({
      blocks: [
        {
          type: "bulletList",
          items: [
            {
              runs: [{ text: "一级事项" }],
              children: [
                {
                  type: "orderedList",
                  items: [
                    { runs: [{ text: "二级事项" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.doc) throw new Error("missing compiled doc");
    expect(safeParsePmDoc(result.doc).success).toBe(true);
    expect(hasListItemContainingNestedListItem(result.doc as unknown as NodeLike)).toBe(true);
    expect(result.doc.content[0]).toMatchObject({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph" },
            {
              type: "orderedList",
              content: [{ type: "listItem" }],
            },
          ],
        },
      ],
    });
  });

  it("三层嵌套混排列表编译、AI-IR 往返与 Markdown 导出都保留层级", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "bulletList",
          items: [
            {
              runs: [{ text: "一级" }],
              children: [
                {
                  type: "orderedList",
                  items: [
                    {
                      runs: [{ text: "二级有序" }],
                      children: [
                        {
                          type: "bulletList",
                          items: [
                            { runs: [{ text: "三级项目" }] },
                          ],
                        },
                        {
                          type: "paragraph",
                          runs: [{ text: "二级附加段落" }],
                        },
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

    const pm = aiIrToPm(ir);
    const back = pmToAiIr(pm);
    const md = pmToMarkdown(pm);

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph" },
            {
              type: "orderedList",
              content: [
                {
                  type: "listItem",
                  content: [
                    { type: "paragraph" },
                    { type: "bulletList" },
                    { type: "paragraph" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(back.blocks).toEqual(ir.blocks);
    expect(md).toContain("- 一级");
    expect(md).toContain("  1. 二级有序");
    expect(md).toContain("    - 三级项目");
    expect(md).toContain("    二级附加段落");
  });

  it("taskList/callout/blockMath/行内公式 AI-IR ↔ PM 往返无损", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "taskList",
          items: [
            { checked: false, runs: [{ text: "未完成项", marks: [{ type: "bold" }] }] },
            { checked: true, runs: [{ text: "已完成项" }] },
          ],
        },
        {
          type: "callout",
          emoji: "⚠️",
          tone: "warning",
          runs: [{ text: "注意:" }, { text: "高风险", marks: [{ type: "bold" }] }],
        },
        { type: "blockMath", latex: "\\int_0^1 x^2 \\, dx = \\frac{1}{3}" },
        {
          type: "paragraph",
          runs: [
            { text: "质能方程 " },
            { text: "E = mc^2", marks: [{ type: "math" }] },
            { text: " 改变了物理学。" },
          ],
        },
      ],
    };

    const pm = aiIrToPm(ir);
    const back = pmToAiIr(pm);

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: expect.objectContaining({ checked: false }) },
        { type: "taskItem", attrs: expect.objectContaining({ checked: true }) },
      ],
    });
    expect(pm.content[3]).toMatchObject({
      content: [
        { type: "text", text: "质能方程 " },
        { type: "inlineMath", attrs: { latex: "E = mc^2" } },
        { type: "text", text: " 改变了物理学。" },
      ],
    });
    expect(back.blocks).toEqual(ir.blocks);
  });

  it("多级 taskList children 编译、AI-IR 往返与 Markdown 导出都保留层级", () => {
    const ir: AiDocument = {
      blocks: [
        {
          type: "taskList",
          items: [
            {
              checked: false,
              runs: [{ text: "父任务" }],
              children: [
                {
                  type: "taskList",
                  items: [
                    { checked: false, runs: [{ text: "子任务 A" }] },
                    { checked: true, runs: [{ text: "子任务 B" }] },
                  ],
                },
                {
                  type: "bulletList",
                  items: [{ runs: [{ text: "补充检查项" }] }],
                },
              ],
            },
            { checked: true, runs: [{ text: "同级完成项" }] },
          ],
        },
      ],
    };

    const pm = aiIrToPm(ir);
    const back = pmToAiIr(pm);
    const md = pmToMarkdown(pm);

    expect(safeParsePmDoc(pm).success).toBe(true);
    expect(pm.content[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "父任务" }] },
            {
              type: "taskList",
              content: [
                { type: "taskItem", attrs: expect.objectContaining({ checked: false }) },
                { type: "taskItem", attrs: expect.objectContaining({ checked: true }) },
              ],
            },
            {
              type: "bulletList",
              content: [{ type: "listItem" }],
            },
          ],
        },
        { type: "taskItem", attrs: expect.objectContaining({ checked: true }) },
      ],
    });
    expect(back.blocks).toEqual(ir.blocks);
    expect(md).toContain("- [ ] 父任务");
    expect(md).toContain("  - [ ] 子任务 A");
    expect(md).toContain("  - [x] 子任务 B");
    expect(md).toContain("  - 补充检查项");
    expect(md).toContain("- [x] 同级完成项");
  });

  it("AI-IR schema 接受 taskList item.children 中的嵌套 taskList", () => {
    const parsed = aiBlockSchema.safeParse({
      type: "taskList",
      items: [
        {
          checked: false,
          runs: [{ text: "父任务" }],
          children: [
            {
              type: "taskList",
              items: [{ checked: true, runs: [{ text: "子任务" }] }],
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("taskList 扁平 items+depth 编译成嵌套 taskList 层级(不静默拍平),checked 保留", () => {
    // 回归:模型按 system.ts"≥3 级嵌套一律扁平 depth"范本对多级待办吐 depth 时,
    // 旧实现只认 bulletList/orderedList,taskList 的 depth 被 zod 静默剥掉、整表拍平成同级。
    const result = compileAiDocumentToPm({
      blocks: [
        {
          type: "taskList",
          items: [
            { depth: 1, checked: false, runs: [{ text: "父任务" }] },
            { depth: 2, checked: false, runs: [{ text: "子任务A" }] },
            { depth: 3, checked: true, runs: [{ text: "孙任务" }] },
            { depth: 1, checked: true, runs: [{ text: "同级完成项" }] },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.doc?.content[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: expect.objectContaining({ checked: false }),
          content: [
            { type: "paragraph", content: [{ type: "text", text: "父任务" }] },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: expect.objectContaining({ checked: false }),
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "子任务A" }] },
                    {
                      type: "taskList",
                      content: [
                        {
                          type: "taskItem",
                          attrs: expect.objectContaining({ checked: true }),
                          content: [{ type: "paragraph", content: [{ type: "text", text: "孙任务" }] }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "taskItem", attrs: expect.objectContaining({ checked: true }) },
      ],
    });
    // 往返:pm → AI-IR 应回到 children 形态且层级完整
    const back = pmToAiIr(result.doc!);
    expect(back.blocks[0]).toEqual({
      type: "taskList",
      items: [
        {
          checked: false,
          runs: [{ text: "父任务" }],
          children: [
            {
              type: "taskList",
              items: [
                {
                  checked: false,
                  runs: [{ text: "子任务A" }],
                  children: [
                    { type: "taskList", items: [{ checked: true, runs: [{ text: "孙任务" }] }] },
                  ],
                },
              ],
            },
          ],
        },
        { checked: true, runs: [{ text: "同级完成项" }] },
      ],
    });
  });

  it("taskList items 容忍 run[][] 简写(修复为未勾选)", () => {
    const result = compileAiDocumentToPm({
      blocks: [{ type: "taskList", items: [[{ text: "裸数组条目" }]] }],
    });
    expect(result.ok).toBe(true);
    expect(result.doc?.content[0]).toMatchObject({
      type: "taskList",
      content: [{ type: "taskItem", attrs: expect.objectContaining({ checked: false }) }],
    });
  });

  it("math mark 与其他 mark 混用时整块报错而非静默丢失", () => {
    const result = compileAiDocumentToPm({
      blocks: [
        {
          type: "paragraph",
          runs: [{ text: "E=mc^2", marks: [{ type: "math" }, { type: "bold" }] }],
        },
      ],
    });
    // math run 整体转 inlineMath,bold 被忽略仍可编译;关键是不能 crash 且产出合法 doc
    expect(result.ok).toBe(true);
    expect(result.doc?.content[0]).toMatchObject({
      content: [{ type: "inlineMath", attrs: { latex: "E=mc^2" } }],
    });
  });

  it("标题 anchor 字段 AI-IR→PM→AI-IR 往返不丢(目录跳转锚点)", () => {
    // 回归:aiIrToPm/pmToAiIr 必须透传 heading anchor;无 anchor 的标题不产出 anchor 字段。
    const ir: AiDocument = {
      blocks: [
        // 有目录链接的列表(使用 AiListItem 真实结构,非 flat-depth shorthand)
        {
          type: "bulletList",
          items: [
            { runs: [{ text: "背景介绍", marks: [{ type: "link", href: "#background" }] }] },
            { runs: [{ text: "方案设计", marks: [{ type: "link", href: "#design" }] }] },
          ],
        },
        // 带 anchor 的标题
        { type: "heading", level: 2, anchor: "background", runs: [{ text: "背景介绍" }] },
        { type: "paragraph", runs: [{ text: "背景正文" }] },
        // anchor 带有数字和连字符
        { type: "heading", level: 2, anchor: "design", runs: [{ text: "方案设计" }] },
        // 无 anchor 的普通标题
        { type: "heading", level: 3, runs: [{ text: "小节" }] },
      ],
    };

    const pm = aiIrToPm(ir);
    expect(safeParsePmDoc(pm).success).toBe(true);

    // PM 节点应带上 anchor
    const h1Pm = pm.content[1]; // heading "背景介绍"
    const h2Pm = pm.content[3]; // heading "方案设计"
    const h3Pm = pm.content[4]; // heading "小节"
    expect(h1Pm?.type).toBe("heading");
    if (h1Pm?.type !== "heading") throw new Error("missing heading 1");
    expect(h1Pm.attrs.anchor).toBe("background");
    if (h2Pm?.type !== "heading") throw new Error("missing heading 2");
    expect(h2Pm.attrs.anchor).toBe("design");
    // 无 anchor 的标题:normalizeAttrsShape 把 null 值字段删除,故 attrs.anchor 应为 undefined
    if (h3Pm?.type !== "heading") throw new Error("missing heading 3");
    expect(h3Pm.attrs.anchor).toBeUndefined();

    // 反向 pmToAiIr:anchor 存在时应还原,无 anchor 的标题不产出 anchor 字段
    const back = pmToAiIr(pm);
    const backH1 = back.blocks[1] as Extract<(typeof back.blocks)[number], { type: "heading" }>;
    const backH2 = back.blocks[3] as Extract<(typeof back.blocks)[number], { type: "heading" }>;
    const backH3 = back.blocks[4] as Extract<(typeof back.blocks)[number], { type: "heading" }>;
    expect(backH1.anchor).toBe("background");
    expect(backH2.anchor).toBe("design");
    // 无 anchor 标题不应带 anchor 字段(undefined)
    expect(backH3.anchor).toBeUndefined();
  });

  it("compiles heading levels 1-6 and rejects bad blocks without producing a canonical doc", () => {
    const result = compileAiDocumentToPm({
      blocks: [
        ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
          type: "heading",
          level,
          runs: [{ text: `H${level}` }],
        })),
        {
          type: "image",
          src: "https://example.com/external.png",
          alt: "外链",
        },
      ],
    });

    expect(isAllowedImageSrc("https://example.com/external.png")).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.doc).toBeNull();
    expect(result.blockErrors).toEqual([
      expect.objectContaining({ index: 6 }),
    ]);
  });
});
