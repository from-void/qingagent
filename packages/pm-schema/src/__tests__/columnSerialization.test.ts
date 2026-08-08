import { describe, expect, it } from "vitest";
import type { PmDoc } from "../types";
import { safeParsePmDoc, normalizePmDoc } from "../validators";
import { pmToPlainText } from "../pmToPlainText";
import { pmToClipboardHtml } from "../clipboard/pmToClipboardHtml";
import { pmToMarkdown } from "../markdown/pmToMarkdown";
import { pmToAiIr } from "../ai-ir/pmToAiIr";
import { compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import { analyzeAiIrEditability } from "../ai-ir/aiIrEditability";

// 内容分栏(columnList/column)序列化全链路回归。
function columnDoc(): PmDoc {
  return {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: "columnList",
        attrs: { blockId: "cl-1" },
        content: [
          {
            type: "column",
            attrs: { blockId: "col-1", widthRatio: 0.6 },
            content: [
              { type: "heading", attrs: { blockId: "h-1", level: 2 }, content: [{ type: "text", text: "左栏标题" }] },
              { type: "paragraph", attrs: { blockId: "p-1" }, content: [{ type: "text", text: "左栏正文" }] },
            ],
          },
          {
            type: "column",
            attrs: { blockId: "col-2", widthRatio: 0.4 },
            content: [{ type: "paragraph", attrs: { blockId: "p-2" }, content: [{ type: "text", text: "右栏正文" }] }],
          },
        ],
      },
    ],
  } as unknown as PmDoc;
}

type NodeLike = {
  type?: string;
  content?: readonly NodeLike[];
};

function countNodesOfType(node: NodeLike, type: string): number {
  const self = node.type === type ? 1 : 0;
  return self + (node.content ?? []).reduce((sum, child) => sum + countNodesOfType(child, type), 0);
}

describe("内容分栏 columnList/column 序列化", () => {
  it("校验:合法分栏(2 栏、各 1+ 块、widthRatio 0~1)通过 schema", () => {
    expect(safeParsePmDoc(columnDoc()).success).toBe(true);
  });

  it("校验:少于 2 栏不合法(columnList content min 2)", () => {
    const oneCol = columnDoc();
    (oneCol.content[0] as { content: unknown[] }).content.length = 1;
    expect(safeParsePmDoc(oneCol).success).toBe(false);
  });

  it("normalize:保留 columnList/column 结构与 widthRatio,补齐缺失 blockId", () => {
    const normalized = normalizePmDoc(columnDoc()) as unknown as PmDoc;
    const cl = normalized.content[0] as { type: string; content: Array<{ type: string; attrs: Record<string, unknown> }> };
    expect(cl.type).toBe("columnList");
    expect(cl.content).toHaveLength(2);
    expect(cl.content[0]!.type).toBe("column");
    expect(cl.content[0]!.attrs.widthRatio).toBe(0.6);
  });

  it("plainText:拼接各栏文本", () => {
    const text = pmToPlainText(columnDoc());
    expect(text).toContain("左栏标题");
    expect(text).toContain("左栏正文");
    expect(text).toContain("右栏正文");
  });

  it("clipboard HTML:输出 data-pm-node 容器(供编辑器内粘贴往返)+ widthRatio", () => {
    const html = pmToClipboardHtml(columnDoc());
    expect(html).toContain('data-pm-node="columnList"');
    expect(html).toContain('data-pm-node="column"');
    expect(html).toContain('data-width-ratio="0.6"');
    expect(html).toContain("左栏标题");
  });

  it("markdown:拍平为顺序块(布局有损,内容不丢)", () => {
    const md = pmToMarkdown(columnDoc());
    expect(md).toContain("## 左栏标题");
    expect(md).toContain("左栏正文");
    expect(md).toContain("右栏正文");
    expect(md).not.toContain("data-pm-node");
  });

  it("AI-IR:分栏以真实 columns/blocks 暴露给 AI,不降级为文本预览", () => {
    const ai = pmToAiIr(columnDoc());
    expect(ai.blocks).toHaveLength(1);
    const block = ai.blocks[0] as {
      type: string;
      columns?: Array<{ widthRatio?: number | null; blocks: Array<{ type: string; runs?: Array<{ text: string }> }> }>;
      text?: string;
    };
    expect(block.type).toBe("columnList");
    expect(block.text).toBeUndefined();
    expect(block.columns).toHaveLength(2);
    expect(block.columns?.[0]?.widthRatio).toBe(0.6);
    expect(block.columns?.[0]?.blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(block.columns?.[0]?.blocks[1]).toMatchObject({ type: "paragraph", runs: [{ text: "左栏正文" }] });
    const editability = analyzeAiIrEditability(columnDoc().content[0] as never);
    expect(editability).toEqual({ replaceBlockAllowed: true, lossyReasons: [] });
  });

  it("AI-IR:columnList 编译为真实 columnList/column 结构", () => {
    const result = compileAiDocumentToPm({
      blocks: [
        {
          type: "columnList",
          columns: [
            { widthRatio: 0.5, blocks: [{ type: "heading", level: 3, runs: [{ text: "左栏" }] }] },
            { widthRatio: 0.5, blocks: [{ type: "paragraph", runs: [{ text: "右栏" }] }] },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.doc?.content[0]).toMatchObject({
      type: "columnList",
      content: [
        { type: "column", attrs: expect.objectContaining({ widthRatio: 0.5 }), content: [{ type: "heading" }] },
        { type: "column", attrs: expect.objectContaining({ widthRatio: 0.5 }), content: [{ type: "paragraph" }] },
      ],
    });
  });

  it("AI-IR:columnList columns 编译后包含 DOM 可渲染的 columnList/column 节点", () => {
    const result = compileAiDocumentToPm({
      blocks: [
        {
          type: "columnList",
          columns: [
            {
              blocks: [
                { type: "paragraph", runs: [{ text: "左栏第一段" }] },
                { type: "bulletList", items: [{ runs: [{ text: "左栏要点" }] }] },
              ],
            },
            {
              blocks: [
                { type: "heading", level: 3, runs: [{ text: "右栏标题" }] },
                { type: "paragraph", runs: [{ text: "右栏正文" }] },
              ],
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.doc) throw new Error("missing compiled doc");
    expect(safeParsePmDoc(result.doc).success).toBe(true);
    expect(countNodesOfType(result.doc as unknown as NodeLike, "columnList")).toBe(1);
    expect(countNodesOfType(result.doc as unknown as NodeLike, "column")).toBe(2);
    expect(result.doc.content[0]).toMatchObject({
      type: "columnList",
      content: [
        { type: "column", content: [{ type: "paragraph" }, { type: "bulletList" }] },
        { type: "column", content: [{ type: "heading" }, { type: "paragraph" }] },
      ],
    });
  });

  it("AI-IR:columnList 缺 columns 时显式失败,不静默降级段落", () => {
    const result = compileAiDocumentToPm({
      blocks: [{ type: "columnList", text: "左栏 / 右栏" }],
    });

    expect(result.ok).toBe(false);
    expect(result.doc).toBeNull();
    expect(result.blockErrors.map((error) => error.message).join("\n")).toContain("columns");
  });
});
