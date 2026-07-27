import { describe, expect, it } from "vitest";
import { isAbnormalDocumentCollapse } from "../documentIntegrity";
import type { PmBlockNode, PmDoc } from "../types";

function paragraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

describe("documentIntegrity", () => {
  it("合并大量短段落时按正文保留量判断，不把节点减少误判为坍缩", () => {
    const previous = doc(Array.from(
      { length: 12 },
      (_, index) => paragraph(`before-${index}`, "短"),
    ));
    const next = doc([paragraph("merged", "短".repeat(12))]);

    expect(isAbnormalDocumentCollapse(previous, next)).toBe(false);
  });

  it("把短段落重构为单个列表时不因节点和顶层块减少而拒绝", () => {
    const previous = doc(Array.from(
      { length: 12 },
      (_, index) => paragraph(`before-${index}`, "项"),
    ));
    const next = doc([{
      type: "orderedList",
      attrs: { blockId: "list", start: 1 },
      content: [{
        type: "listItem",
        attrs: { blockId: "item" },
        content: [paragraph("item-paragraph", "项".repeat(12))],
      }],
    }]);

    expect(isAbnormalDocumentCollapse(previous, next)).toBe(false);
  });

  it("仍拦截正文或媒体主体真正丢失", () => {
    const textPrevious = doc(Array.from(
      { length: 12 },
      (_, index) => paragraph(`before-${index}`, "内容"),
    ));
    expect(isAbnormalDocumentCollapse(
      textPrevious,
      doc([paragraph("damaged", "少")]),
    )).toBe(true);

    const mediaPrevious = doc([
      {
        type: "image",
        attrs: { blockId: "image-1", src: "https://example.test/1.png" },
      },
      {
        type: "image",
        attrs: { blockId: "image-2", src: "https://example.test/2.png" },
      },
    ]);
    expect(isAbnormalDocumentCollapse(mediaPrevious, doc([]))).toBe(true);
  });
});
