import { describe, expect, it } from "vitest";
import type { PmDoc } from "../../types";
import {
  aiBlockSchema,
  type AiBlock,
  type AiListItem,
  type AiRun,
  type AiTableCell,
  type AiTaskListItem,
} from "../aiIrSchema";
import {
  aiBlockToQingml,
  aiBlocksToQingml,
  aiListItemToQingml,
  aiTableRowToQingml,
} from "../aiIrToQingml";
import { qingmlParse, qingmlParseFragment } from "../qingmlParse";
import { pmToAiIr } from "../pmToAiIr";

function tableCell(
  runs: AiRun[],
  attrs: Omit<AiTableCell, "blocks"> = {},
): AiTableCell {
  return { blocks: [{ type: "paragraph", runs }], ...attrs };
}

describe("aiIrToQingml", () => {
  it("序列化所有 AiBlock 类型后可由 qingmlParse 等价读回", () => {
    const blocks: AiBlock[] = [
      {
        type: "heading",
        level: 3,
        anchor: "sec-1",
        textAlign: "center",
        runs: [{ text: "小标题" }],
      },
      {
        type: "paragraph",
        textAlign: "justify",
        runs: [
          { text: "普通" },
          {
            text: "粗斜链接",
            marks: [
              { type: "bold" },
              { type: "italic" },
              { type: "link", href: "https://example.com", title: "来源" },
            ],
          },
          { text: "高亮", marks: [{ type: "highlight", color: "yellow" }] },
          { text: "红字", marks: [{ type: "textColor", color: "red" }] },
          { text: "下划线", marks: [{ type: "underline" }] },
          { text: "删除", marks: [{ type: "strike" }] },
          { text: "代码", marks: [{ type: "code" }] },
          { text: "换\n行" },
          { text: "E=mc^2", marks: [{ type: "math" }] },
        ],
      },
      { type: "blockquote", runs: [{ text: "引用原文" }] },
      {
        type: "codeBlock",
        language: "python",
        text: "if value < 10 && ready:\n    print(\"<ok>\")",
      },
      {
        type: "bulletList",
        items: [
          {
            runs: [{ text: "一级A" }],
            children: [{
              type: "bulletList",
              items: [{ runs: [{ text: "二级A1" }] }, { runs: [{ text: "二级A2" }] }],
            }],
          },
          { runs: [{ text: "一级B" }] },
        ],
      },
      {
        type: "orderedList",
        listStyle: "lower-alpha",
        items: [{ runs: [{ text: "有序项" }] }],
      },
      { type: "horizontalRule" },
      {
        type: "table",
        rows: [
          {
            header: true,
            cells: [
              tableCell([{ text: "列A" }], { header: true, backgroundColor: "rose" }),
              tableCell([{ text: "列B" }], { header: true }),
            ],
          },
          {
            cells: [
              {
                blocks: [
                  { type: "paragraph", runs: [{ text: "a1" }] },
                  { type: "bulletList", items: [{ runs: [{ text: "补充" }] }] },
                ],
                backgroundColor: "sand",
                colspan: 2,
                rowspan: 3,
              },
              tableCell([{ text: "b1" }]),
            ],
          },
        ],
      },
      {
        type: "image",
        src: "data:image/svg+xml,%3Csvg xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E",
        alt: "示意图",
        caption: "图注",
        width: 320,
        height: 180,
        align: "center",
      },
      {
        type: "fileAttachment",
        fileId: "file-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
      { type: "penNote", runs: [{ text: "手写批注" }] },
      {
        type: "taskList",
        items: [
          { checked: false, runs: [{ text: "未完成" }] },
          {
            checked: true,
            runs: [{ text: "已完成" }],
            children: [{
              type: "taskList",
              items: [{ checked: true, runs: [{ text: "子任务" }] }],
            }],
          },
        ],
      },
      { type: "callout", emoji: "!", tone: "warning", runs: [{ text: "风险提示" }] },
      {
        type: "columnList",
        columns: [
          { widthRatio: 0.5, blocks: [{ type: "paragraph", runs: [{ text: "左栏" }] }] },
          { widthRatio: 0.5, blocks: [{ type: "heading", level: 4, runs: [{ text: "右栏" }] }] },
        ],
      },
      { type: "blockMath", latex: "a &< b" },
      { type: "diagram", lang: "mermaid", source: "flowchart TD\n  A[\"x < y\"] --> B" },
    ];

    const qingml = aiBlocksToQingml(blocks);

    expect(qingml).toContain("<br/>");
    expect(qingml).toContain("value &lt; 10 &amp;&amp; ready");
    expect(qingml).toContain("A[\"x &lt; y\"]");
    expect(qingml).toContain('<td colspan="2" rowspan="3" bg="sand"><p>a1</p><ul><li>补充</li></ul></td>');
    expect(qingml).toContain("<th><p>列B</p></th>");
    const parsed = qingmlParse(qingml);

    expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsed.blocks).toEqual(blocks);
  });

  it("单块、列表行和表格行片段序列化可被 qingmlParseFragment 读回", () => {
    const block: AiBlock = { type: "paragraph", runs: [{ text: "片段块" }] };
    const item: AiListItem = {
      runs: [{ text: "父项" }],
      children: [{ type: "bulletList", items: [{ runs: [{ text: "子项" }] }] }],
    };
    const task: AiTaskListItem = { checked: true, runs: [{ text: "任务项" }] };
    const cells: AiTableCell[] = [
      tableCell([{ text: "列A" }], { header: true, backgroundColor: "rose" }),
      tableCell([{ text: "a1" }]),
    ];

    expect(qingmlParseFragment(aiBlockToQingml(block), "replaceBlock")).toMatchObject({
      ok: true,
      kind: "blocks",
      blocks: [block],
    });
    expect(qingmlParseFragment(aiListItemToQingml(item), "replaceListItem")).toMatchObject({
      ok: true,
      kind: "listItem",
      item,
    });
    expect(qingmlParseFragment(aiListItemToQingml(task), "replaceListItem")).toMatchObject({
      ok: true,
      kind: "listItem",
      item: task,
    });
    expect(qingmlParseFragment(aiTableRowToQingml(cells), "insertTableRow")).toMatchObject({
      ok: true,
      kind: "row",
      cells,
    });
  });

  it("PM→AI-IR→QingML→parse 保留多块 blockquote/callout 的块类型、列表和 marks", () => {
    const pm: PmDoc = {
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [
        {
          type: "blockquote",
          attrs: { blockId: "quote" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "quote-p" },
              content: [{ type: "text", text: "粗体段", marks: [{ type: "bold" }] }],
            },
            {
              type: "heading",
              attrs: { blockId: "quote-h", level: 3 },
              content: [{ type: "text", text: "引用标题" }],
            },
            {
              type: "bulletList",
              attrs: { blockId: "quote-list" },
              content: [{
                type: "listItem",
                attrs: { blockId: "quote-item" },
                content: [{
                  type: "paragraph",
                  attrs: { blockId: "quote-item-p" },
                  content: [{ type: "text", text: "列表项", marks: [{ type: "italic" }] }],
                }],
              }],
            },
          ],
        },
        {
          type: "callout",
          attrs: { blockId: "callout", emoji: "💡", tone: "info" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "callout-p-1" },
              content: [{ type: "text", text: "提示一" }],
            },
            {
              type: "paragraph",
              attrs: { blockId: "callout-p-2" },
              content: [{ type: "text", text: "提示二", marks: [{ type: "underline" }] }],
            },
          ],
        },
      ],
    };
    const ir = pmToAiIr(pm);
    const qingml = aiBlocksToQingml(ir.blocks);
    expect(qingml).toContain(
      "<blockquote><p><b>粗体段</b></p><h3>引用标题</h3><ul><li><i>列表项</i></li></ul></blockquote>",
    );
    expect(qingml).toContain(
      '<callout emoji="💡" tone="info"><p>提示一</p><p><u>提示二</u></p></callout>',
    );

    const parsed = qingmlParse(qingml);
    const withoutBlockIds = JSON.parse(JSON.stringify(ir.blocks, (key, value) =>
      key === "blockId" ? undefined : value)) as AiBlock[];
    expect(parsed.warnings.filter((warning) => warning.severity === "bad-block")).toEqual([]);
    expect(parsed.blocks).toEqual(withoutBlockIds);
  });

  it("structured container schema 强制 runs/blocks 二选一，且 callout blocks 仅收 paragraph", () => {
    expect(aiBlockSchema.safeParse({
      type: "blockquote",
      runs: [{ text: "旧式" }],
      blocks: [{ type: "paragraph", runs: [{ text: "结构化" }] }],
    }).success).toBe(false);
    expect(aiBlockSchema.safeParse({ type: "blockquote" }).success).toBe(false);
    expect(aiBlockSchema.safeParse({
      type: "callout",
      blocks: [{ type: "heading", level: 2, runs: [{ text: "非法标题" }] }],
    }).success).toBe(false);
    expect(aiBlockSchema.safeParse({
      type: "callout",
      blocks: [{ type: "paragraph", runs: [{ text: "合法段落" }] }],
    }).success).toBe(true);
  });
});
