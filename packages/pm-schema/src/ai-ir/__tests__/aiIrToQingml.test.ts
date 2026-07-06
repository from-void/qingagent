import { describe, expect, it } from "vitest";
import type { AiBlock, AiListItem, AiTableCell, AiTaskListItem } from "../aiIrSchema";
import {
  aiBlockToQingml,
  aiBlocksToQingml,
  aiListItemToQingml,
  aiTableRowToQingml,
} from "../aiIrToQingml";
import { qingmlParse, qingmlParseFragment } from "../qingmlParse";

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
              { header: true, runs: [{ text: "列A" }], backgroundColor: "rose" },
              { header: true, runs: [{ text: "列B" }] },
            ],
          },
          {
            cells: [
              { runs: [{ text: "a1" }], backgroundColor: "sand" },
              { runs: [{ text: "b1" }] },
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
      { header: true, runs: [{ text: "列A" }], backgroundColor: "rose" },
      { runs: [{ text: "a1" }] },
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
});
