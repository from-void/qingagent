import { describe, expect, it } from "vitest";
import type { AiDocument as ContractAiDocument } from "@qingagent/contract-ts";
import { aiDocumentSchema, type AiDocument as CanonicalAiDocument } from "../ai-ir/aiIrSchema";

const fixture: ContractAiDocument = {
  title: "全块类型镜像",
  blocks: [
    { type: "paragraph", textAlign: "justify", runs: [{ text: "段落", marks: [{ type: "bold" }, { type: "math" }] }] },
    { type: "heading", level: 2, anchor: "section", textAlign: "center", runs: [{ text: "标题" }] },
    {
      type: "blockquote",
      blocks: [{
        type: "paragraph",
        blockId: "quote-child",
        runs: [{ text: "结构化引用" }],
      }],
    },
    { type: "codeBlock", language: "ts", text: "const ok = true" },
    {
      type: "bulletList",
      items: [{
        runs: [{ text: "父项" }],
        children: [{ type: "orderedList", listStyle: "lower-alpha", items: [{ runs: [{ text: "子项" }] }] }],
      }],
    },
    { type: "orderedList", listStyle: "upper-roman", items: [{ runs: [{ text: "有序" }] }] },
    { type: "horizontalRule" },
    {
      type: "table",
      rows: [{
        header: true,
        cells: [{
          header: true,
          backgroundColor: "rose",
          colspan: 2,
          rowspan: 3,
          blocks: [
            { type: "paragraph", runs: [{ text: "单元格" }] },
            { type: "taskList", items: [{ checked: true, runs: [{ text: "cell task" }] }] },
            {
              type: "callout",
              tone: "warning",
              blocks: [{
                type: "paragraph",
                blockId: "callout-child",
                runs: [{ text: "structured cell callout" }],
              }],
            },
          ],
        }],
      }],
    },
    { type: "image", src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/image.png", alt: "图", caption: "图注", width: 320, height: 180, align: "right" },
    { type: "fileAttachment", fileId: "file-1", filename: "a.pdf", mimeType: "application/pdf", size: 42 },
    { type: "penNote", runs: [{ text: "手写" }] },
    {
      type: "taskList",
      items: [{
        checked: false,
        runs: [{ text: "任务" }],
        children: [{ type: "bulletList", items: [{ runs: [{ text: "说明" }] }] }],
      }],
    },
    { type: "callout", emoji: "!", tone: "ochre", runs: [{ text: "提示" }] },
    {
      type: "columnList",
      columns: [
        { widthRatio: 0.4, blocks: [{ type: "paragraph", runs: [{ text: "左" }] }] },
        { widthRatio: 0.6, blocks: [{ type: "paragraph", runs: [{ text: "右" }] }] },
      ],
    },
    { type: "blockMath", latex: "E=mc^2" },
    { type: "diagram", lang: "mermaid", source: "flowchart TD\nA-->B", svg: null },
  ],
};

// 编译期双向可赋值；任一镜像字段/联合成员漂移都会让 typecheck 失败。
const canonicalAssignable: CanonicalAiDocument = fixture;
const contractAssignable: ContractAiDocument = canonicalAssignable;

describe("contract-ts AiDocument 递归镜像", () => {
  it("覆盖 canonical 每种块并通过 canonical schema", () => {
    expect(contractAssignable.blocks).toHaveLength(16);
    expect(aiDocumentSchema.safeParse(contractAssignable).success).toBe(true);
  });
});
