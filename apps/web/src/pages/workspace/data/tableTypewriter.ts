import type { PmBlockNode } from "@qingagent/pm-schema";
import type { BlockPatchInput, ViewBlock } from "./protocol";
import { splitGraphemes, tableCellEntries } from "./presentationSpans";

export const TABLE_TYPEWRITER_MAX_CELLS = 120;
export const TABLE_TYPEWRITER_MAX_GRAPHEMES = 1500;

export type TableTypewriterFallbackReason =
  | "not-table"
  | "span"
  | "multi-block-cell"
  | "non-text-cell"
  | "too-many-cells"
  | "too-many-graphemes";

export type ReviewTableCellTypedCounts = ReadonlyMap<string, number>;
export type ReviewTableTypedByPatch = ReadonlyMap<string, ReviewTableCellTypedCounts>;

export interface ReviewTableRevealCell {
  key: string;
  graphemeCount: number;
}

export interface ReviewTableRevealPlan {
  patchId: string;
  cells: ReviewTableRevealCell[];
  totalGraphemes: number;
}

export function tableTypewriterFallbackReason(
  section: ViewBlock,
  pmNode?: PmBlockNode,
): TableTypewriterFallbackReason | null {
  if (section.kind !== "table") return "not-table";
  const entries = tableCellEntries(section);
  if (entries.length > TABLE_TYPEWRITER_MAX_CELLS) return "too-many-cells";
  const graphemeCount = entries.reduce(
    (sum, entry) => sum + splitGraphemes(entry.text).length,
    0,
  );
  if (graphemeCount > TABLE_TYPEWRITER_MAX_GRAPHEMES) return "too-many-graphemes";

  if (pmNode?.type === "table") {
    for (const row of pmNode.content) {
      for (const cell of row.content) {
        if ((cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1) {
          return "span";
        }
        if (cell.content.length !== 1) return "multi-block-cell";
        const blockType = cell.content[0]?.type;
        if (!blockType || !["paragraph", "heading", "codeBlock", "penNote"].includes(blockType)) {
          return "non-text-cell";
        }
      }
    }
  }
  return null;
}

export function shouldTypewriteTable(section: ViewBlock, pmNode?: PmBlockNode): boolean {
  return tableTypewriterFallbackReason(section, pmNode) === null;
}

export function tableCellGraphemeCounts(section: ViewBlock): number[] {
  return section.kind === "table"
    ? tableCellEntries(section).map((entry) => splitGraphemes(entry.text).length)
    : [];
}

/** 把整表已揭示字数确定性投影回物理 cell，供审阅 widget 逐格截断。 */
export function distributeTableTypedGraphemes(
  cellCounts: readonly number[],
  totalTyped: number,
): number[] {
  let remaining = Math.max(0, Math.floor(totalTyped));
  return cellCounts.map((count) => {
    const typed = Math.min(Math.max(0, count), remaining);
    remaining -= typed;
    return typed;
  });
}

export function reviewTableCellKey(
  blockIndex: number,
  rowIndex: number,
  cellIndex: number,
): string {
  return `${blockIndex}:${rowIndex}:${cellIndex}`;
}

export function buildReviewTableRevealPlan(
  input: BlockPatchInput,
): ReviewTableRevealPlan | null {
  const cells: ReviewTableRevealCell[] = [];
  input.blocks.forEach((block, blockIndex) => {
    if (block.kind !== "table") return;
    if (!shouldTypewriteTable(block, input.pmNodes?.[blockIndex] ?? block.node)) return;
    for (const entry of tableCellEntries(block)) {
      cells.push({
        key: reviewTableCellKey(blockIndex, entry.rowIndex, entry.cellIndex),
        graphemeCount: splitGraphemes(entry.text).length,
      });
    }
  });
  if (cells.length === 0) return null;
  return {
    patchId: input.patchId,
    cells,
    totalGraphemes: cells.reduce((sum, cell) => sum + cell.graphemeCount, 0),
  };
}

export function reviewTableTypedCounts(
  plan: ReviewTableRevealPlan,
  totalTyped: number,
): Map<string, number> {
  const distributed = distributeTableTypedGraphemes(
    plan.cells.map((cell) => cell.graphemeCount),
    totalTyped,
  );
  return new Map(plan.cells.map((cell, index) => [cell.key, distributed[index] ?? 0]));
}
