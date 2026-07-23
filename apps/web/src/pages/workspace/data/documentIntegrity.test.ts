import { describe, expect, it } from "vitest";
import type { PmBlockNode, PmDoc } from "@qingagent/pm-schema";
import {
  isAbnormalDocumentCollapse,
  measureDocumentShape,
} from "./documentIntegrity";

function paragraph(blockId: string, text: string): PmBlockNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function doc(content: PmBlockNode[]): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content };
}

const damagedHeading = doc([
  {
    type: "heading",
    attrs: { blockId: "heading-damaged", level: 1 },
    content: [{ type: "text", text: "300" }],
  },
]);

describe("documentIntegrity", () => {
  it("识别多块表格文档骤降为单一标题的高危坍缩", () => {
    const baseline = doc([
      paragraph("intro", "季度销量与目标对比"),
      {
        type: "table",
        attrs: { blockId: "sales-table" },
        content: [
          {
            type: "tableRow",
            content: [
              tableCell("quarter", "季度"),
              tableCell("sales", "销量"),
              tableCell("target", "目标"),
            ],
          },
          {
            type: "tableRow",
            content: [
              tableCell("q1", "Q1"),
              tableCell("q1-sales", "120"),
              tableCell("q1-target", "150"),
            ],
          },
        ],
      },
      {
        type: "image",
        attrs: {
          blockId: "chart",
          src: "https://example.test/chart.png",
          alt: "季度柱状图",
        },
      },
    ]);

    expect(measureDocumentShape(baseline)).toMatchObject({
      topLevelNodeCount: 3,
    });
    expect(isAbnormalDocumentCollapse(baseline, damagedHeading)).toBe(true);
  });

  it("不误伤单块编辑和仍保留主体内容的正常删改", () => {
    const singleBefore = doc([paragraph("p", "原文内容")]);
    const singleAfter = doc([paragraph("p", "300")]);
    expect(isAbnormalDocumentCollapse(singleBefore, singleAfter)).toBe(false);

    const multiBefore = doc([
      paragraph("p1", "这是第一段需要保留的完整正文内容"),
      paragraph("p2", "这是第二段需要保留的完整正文内容"),
      paragraph("p3", "这是第三段需要保留的完整正文内容"),
    ]);
    const condensed = doc([
      paragraph("summary", "三段正文压缩后的摘要仍然保留大部分核心内容与关键结论"),
    ]);
    expect(isAbnormalDocumentCollapse(multiBefore, condensed)).toBe(false);
  });
});

function tableCell(blockId: string, text: string) {
  return {
    type: "tableCell" as const,
    content: [paragraph(blockId, text)],
  };
}
