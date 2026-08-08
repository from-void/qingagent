import { describe, expect, it } from "vitest";
import { pmDocToViewDocumentSnapshot } from "../data/protocol";
import { viewBlockToPmNode, viewSectionsToHtml } from "../data/viewDocHtml";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";

// round-1 真机端到端发现的根因回归:生成的图表在编辑器里显示成代码块。
// 根因是 PM→ViewBlock 把 diagram 降级成 code,而编辑器经 viewSectionsToHtml(sections)
// 播种内容,于是图表变代码块。修复:ViewBlock 保留 diagram 语义(只读渲染处才降级)。

function docWithDiagram(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      { type: "paragraph", attrs: { blockId: "p" }, content: [{ type: "text", text: "前言" }] },
      { type: "diagram", attrs: { blockId: "d", lang: "mermaid", source: "flowchart TD\n A-->B", svg: null } },
    ],
  } as unknown as PmDoc;
}

describe("ViewBlock 保留 diagram(不降级为 code)", () => {
  it("pmDocToViewDocumentSnapshot:diagram 节点 → diagram ViewBlock,且 pmDoc 原样保留", () => {
    const snap = pmDocToViewDocumentSnapshot(docWithDiagram(), 1);
    const kinds = snap.sections.map((s) => s.kind);
    expect(kinds).toContain("diagram");
    expect(kinds).not.toContain("code");
    const dg = snap.sections.find((s) => s.kind === "diagram");
    expect(dg && dg.kind === "diagram" ? dg.source : "").toContain("flowchart TD");
    // pmDoc 原样(编辑器优先用 pmDoc)
    expect(snap.pmDoc?.content.some((b) => b.type === "diagram")).toBe(true);
  });
});

describe("ViewBlock 原生 PM 兜底", () => {
  it("有序列表直接保留起始序号、样式与既有 blockId", () => {
    const node = viewBlockToPmNode({
      kind: "list",
      blockId: "ordered-fallback",
      ordered: true,
      start: 5,
      listStyle: "upper-roman",
      items: ["甲", "乙"],
    });

    expect(node).toMatchObject({
      type: "orderedList",
      attrs: { blockId: "ordered-fallback", start: 5, listStyle: "upper-roman" },
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "甲" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "乙" }] }] },
      ],
    });
  });

  it("附件直接构造成 fileAttachment，不再拍平成提示段落", () => {
    const node = viewBlockToPmNode({
      kind: "fileAttachment",
      blockId: "attachment-fallback",
      fileId: "file-1",
      filename: "规范.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });

    expect(node).toEqual({
      type: "fileAttachment",
      attrs: {
        blockId: "attachment-fallback",
        fileId: "file-1",
        filename: "规范.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    });
  });
});

describe("viewSectionsToHtml 审阅态行内 patch 保真", () => {
  it("有序列表把 listStyle 写回 TipTap 可识别的 HTML attrs", () => {
    const html = viewSectionsToHtml([{
      kind: "list",
      ordered: true,
      listStyle: "upper-roman",
      items: ["条目"],
    }]);

    expect(html).toContain('data-list-style="upper-roman"');
    expect(html).toContain('style="list-style-type: upper-roman"');
  });

  it("quote 带 patch inlineMath 时不被原始 pm 节点序列化吞掉", () => {
    const latex = String.raw`\sqrt{\sigma^{}} & x < y`;
    const html = viewSectionsToHtml([{
      kind: "quote",
      text: "旧引文",
      node: {
        type: "blockquote",
        attrs: { blockId: "q-node" },
        content: [{ type: "paragraph", attrs: { blockId: "q-p" }, content: [{ type: "text", text: "旧引文" }] }],
      } as PmBlockNode,
      spans: [
        { kind: "text", text: "引用 " },
        { kind: "patchInsMath", latex, patchId: "q-math" },
      ],
    }]);

    expect(html).toContain("data-type=\"inline-math\"");
    expect(html).toContain("data-latex=\"\\sqrt{\\sigma^{}} &amp; x &lt; y\"");
    expect(html).not.toContain("旧引文");
  });

  it("无 patch 的复杂列表与表格直接序列化原始 PM node", () => {
    const listNode = {
      type: "orderedList",
      attrs: { blockId: "ordered-rich", start: 5, listStyle: "upper-roman" },
      content: [{
        type: "listItem",
        attrs: { blockId: "ordered-rich-item" },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "ordered-rich-p" },
            content: [{ type: "text", text: "父项", marks: [{ type: "bold" }] }],
          },
          {
            type: "bulletList",
            attrs: { blockId: "ordered-rich-child" },
            content: [{
              type: "listItem",
              attrs: { blockId: "ordered-rich-child-item" },
              content: [{
                type: "paragraph",
                attrs: { blockId: "ordered-rich-child-p" },
                content: [{ type: "text", text: "子项" }],
              }],
            }],
          },
        ],
      }],
    } as PmBlockNode;
    const tableNode = {
      type: "table",
      attrs: { blockId: "table-rich" },
      content: [{
        type: "tableRow",
        content: [{
          type: "tableCell",
          attrs: {
            colspan: 2,
            rowspan: 1,
            colwidth: [120, 180],
            backgroundColor: null,
          },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "table-rich-p1" },
              content: [{ type: "text", text: "合并", marks: [{ type: "bold" }] }],
            },
            {
              type: "paragraph",
              attrs: { blockId: "table-rich-p2" },
              content: [{ type: "text", text: "说明" }],
            },
          ],
        }],
      }],
    } as PmBlockNode;

    const html = viewSectionsToHtml([
      {
        kind: "list",
        ordered: true,
        start: 5,
        listStyle: "upper-roman",
        items: ["父项\n子项"],
        node: listNode,
      },
      {
        kind: "table",
        head: [],
        rows: [["合并\n说明"]],
        node: tableNode,
      },
    ]);

    expect(html).toContain('<ol start="5" data-list-style="upper-roman"');
    expect(html).toContain("<strong>父项</strong>");
    expect(html).toContain("<ul><li><p>子项</p></li></ul>");
    expect(html).toContain('<td colspan="2" colwidth="120,180">');
    expect(html).toContain("<p><strong>合并</strong></p><p>说明</p></td>");
  });
});
