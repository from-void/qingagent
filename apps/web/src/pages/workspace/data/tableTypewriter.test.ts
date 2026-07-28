import { describe, expect, it } from "vitest";
import type { PmBlockNode } from "@qingagent/pm-schema";
import type { ViewBlock } from "./protocol";
import {
  TABLE_TYPEWRITER_MAX_CELLS,
  TABLE_TYPEWRITER_MAX_GRAPHEMES,
  distributeTableTypedGraphemes,
  buildReviewTableRevealPlan,
  reconcileFinalizedReviewTablePatchIds,
  tableTypewriterFallbackReason,
} from "./tableTypewriter";

const table = (head: string[], rows: string[][]): ViewBlock => ({ kind: "table", head, rows });

function pmTable(
  attrs: {
    colspan?: number;
    rowspan?: number;
    colwidth?: number[] | null;
    backgroundColor?: string | null;
  } = {},
  blocks = 1,
): PmBlockNode {
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

function pmFormattedTable({
  blockType = "paragraph",
  textAlign = null,
  marks = [],
}: {
  blockType?: "paragraph" | "heading" | "codeBlock" | "penNote";
  textAlign?: string | null;
  marks?: Array<Record<string, unknown>>;
} = {}): PmBlockNode {
  const blockAttrs = blockType === "heading"
    ? { blockId: "formatted-p", level: 2, textAlign }
    : blockType === "codeBlock"
      ? { blockId: "formatted-p", language: "plaintext" }
      : blockType === "paragraph"
        ? { blockId: "formatted-p", textAlign }
        : { blockId: "formatted-p" };
  return {
    type: "table",
    attrs: { blockId: "formatted-table" },
    content: [{
      type: "tableRow",
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
        content: [{
          type: blockType,
          attrs: blockAttrs,
          content: [{ type: "text", text: "格式", ...(marks.length > 0 ? { marks } : {}) }],
        }],
      }],
    }],
  } as PmBlockNode;
}

function pmTableWithInlineMath(): PmBlockNode {
  return {
    type: "table",
    attrs: { blockId: "table-math" },
    content: [{
      type: "tableRow",
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null },
        content: [{
          type: "paragraph",
          attrs: { blockId: "p-math" },
          content: [{ type: "inlineMath", attrs: { latex: "x^2" } }],
        }],
      }],
    }],
  } as PmBlockNode;
}

describe("table typewriter policy", () => {
  it("普通单块表允许逐字，span 与多块 cell 整块 fallback", () => {
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable())).toBeNull();
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable({ colspan: 2 }))).toBe("span");
    expect(tableTypewriterFallbackReason(table([], [["甲"]]), pmTable({}, 2))).toBe("multi-block-cell");
    expect(tableTypewriterFallbackReason(table([], [["x^2"]]), pmTableWithInlineMath())).toBe("non-text-cell");
  });

  it("仅放行无样式普通段落：单元格属性、块类型、对齐与文字 marks 均整表 fallback", () => {
    expect(tableTypewriterFallbackReason(
      table([], [["列宽"]]),
      pmTable({ colwidth: [120] }),
    )).toBe("cell-style");
    expect(tableTypewriterFallbackReason(
      table([], [["底色"]]),
      pmTable({ backgroundColor: "sky" }),
    )).toBe("cell-style");
    expect(tableTypewriterFallbackReason(
      table([], [["标题"]]),
      pmFormattedTable({ blockType: "heading" }),
    )).toBe("non-paragraph-cell");
    expect(tableTypewriterFallbackReason(
      table([], [["代码"]]),
      pmFormattedTable({ blockType: "codeBlock" }),
    )).toBe("non-paragraph-cell");
    expect(tableTypewriterFallbackReason(
      table([], [["笔记"]]),
      pmFormattedTable({ blockType: "penNote" }),
    )).toBe("non-paragraph-cell");
    expect(tableTypewriterFallbackReason(
      table([], [["居中"]]),
      pmFormattedTable({ textAlign: "center" }),
    )).toBe("formatted-text");
    expect(tableTypewriterFallbackReason(
      table([], [["粗体"]]),
      pmFormattedTable({ marks: [{ type: "bold" }] }),
    )).toBe("formatted-text");
    expect(tableTypewriterFallbackReason(
      table([], [["链接"]]),
      pmFormattedTable({ marks: [{ type: "link", attrs: { href: "https://example.com" } }] }),
    )).toBe("formatted-text");
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

  it("纯删除表格不产 reveal 计划，避免无 widget 空跑", () => {
    expect(buildReviewTableRevealPlan({
      patchId: "delete-table",
      op: "delete",
      blocks: [table([], [["不可见旧表"]])],
      beforePmNodes: [pmTable()],
    })).toBeNull();
  });

  it("接受/拒绝终态跨状态回写保留，仅离场或显式重播清理", () => {
    const finalized = new Set(["accepted-table", "gone-table"]);
    expect(reconcileFinalizedReviewTablePatchIds(
      finalized,
      ["accepted-table", "pending-table"],
      false,
    )).toEqual(new Set(["accepted-table"]));
    expect(reconcileFinalizedReviewTablePatchIds(finalized, ["accepted-table"], true)).toEqual(new Set());
  });
});
