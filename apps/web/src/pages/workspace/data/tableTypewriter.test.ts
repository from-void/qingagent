import { describe, expect, it } from "vitest";
import type { PmBlockNode } from "@qingagent/pm-schema";
import type { ViewBlock } from "./protocol";
import {
  TABLE_TYPEWRITER_MAX_CELLS,
  TABLE_TYPEWRITER_MAX_GRAPHEMES,
  distributeTableTypedGraphemes,
  buildReviewTableRevealPlan,
  tableTypewriterFallbackReason,
} from "./tableTypewriter";

const table = (head: string[], rows: string[][]): ViewBlock => ({ kind: "table", head, rows });

function pmTable(attrs: { colspan?: number; rowspan?: number } = {}, blocks = 1): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId: "table" },
    content: [{
      type: "tableRow",
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, ...attrs },
        content: Array.from({ length: blocks }, (_, index) => ({
          type: "paragraph",
          attrs: { blockId: `p-${index}` },
          content: [],
        })),
      }],
    }],
  } as PmBlockNode;
}

describe("table typewriter policy", () => {
  it("普通单块表允许逐字，span 与多块 cell 整块 fallback", () => {
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable())).toBeNull();
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable({ colspan: 2 }))).toBe("span");
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable({}, 2))).toBe("multi-block-cell");
  });

  it("cell 数和 grapheme 超阈值时整块 fallback", () => {
    const manyCells = table([], [Array.from({ length: TABLE_TYPEWRITER_MAX_CELLS + 1 }, () => "")]);
    const longCell = table([], [["字".repeat(TABLE_TYPEWRITER_MAX_GRAPHEMES + 1)]]);
    expect(tableTypewriterFallbackReason(manyCells)).toBe("too-many-cells");
    expect(tableTypewriterFallbackReason(longCell)).toBe("too-many-graphemes");
  });

  it("整表进度按物理 cell 顺序分配", () => {
    expect(distributeTableTypedGraphemes([2, 0, 3], 4)).toEqual([2, 0, 2]);
  });

  it("审阅态复用同一 fallback：普通表产计划，span/多块表整块出现", () => {
    const input = (node: PmBlockNode) => ({
      patchId: "review-table",
      op: "insert" as const,
      blocks: [table([], [["甲"]])],
      pmNodes: [node],
    });
    expect(buildReviewTableRevealPlan(input(pmTable()))?.totalGraphemes).toBe(1);
    expect(buildReviewTableRevealPlan(input(pmTable({ rowspan: 2 })))).toBeNull();
    expect(buildReviewTableRevealPlan(input(pmTable({}, 2)))).toBeNull();
  });
});
