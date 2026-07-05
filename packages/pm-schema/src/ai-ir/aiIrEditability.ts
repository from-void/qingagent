import type { PmBlockNode } from "../types";

export type AiIrLossyReason =
  | "nestedList"
  | "multiBlockListItem"
  | "complexListItemBlock"
  | "multiBlockTableCell"
  | "complexTableCellBlock"
  | "multiBlockBlockquote"
  | "complexBlockquoteChild"
  | "columnLayout";

export interface AiIrEditability {
  replaceBlockAllowed: boolean;
  lossyReasons: AiIrLossyReason[];
}

const SIMPLE_CHILD_TYPES = new Set(["paragraph", "heading", "penNote"]);
const LIST_CHILD_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

export function analyzeAiIrEditability(block: PmBlockNode): AiIrEditability {
  const reasons = new Set<AiIrLossyReason>();
  visitBlock(block, reasons);
  return {
    replaceBlockAllowed: reasons.size === 0,
    lossyReasons: [...reasons],
  };
}

function visitBlock(block: PmBlockNode, reasons: Set<AiIrLossyReason>): void {
  if (block.type === "taskList") {
    for (const item of block.content) {
      const [first, ...rest] = item.content;
      if (first && first.type !== "paragraph") reasons.add("complexListItemBlock");
      if (rest.some((child) => !LIST_CHILD_TYPES.has(child.type))) reasons.add("multiBlockListItem");
      for (const child of rest) visitBlock(child, reasons);
    }
    return;
  }

  if (block.type === "callout") {
    if (block.content.length > 1) reasons.add("multiBlockBlockquote");
    return;
  }

  if (block.type === "columnList") {
    for (const column of block.content) {
      for (const child of column.content) visitBlock(child, reasons);
    }
    return;
  }

  if (block.type === "bulletList" || block.type === "orderedList") {
    for (const item of block.content) {
      for (const child of item.content) {
        visitBlock(child, reasons);
      }
    }
    return;
  }

  if (block.type === "table") {
    for (const row of block.content) {
      for (const cell of row.content) {
        if (cell.content.length > 1) reasons.add("multiBlockTableCell");
        for (const child of cell.content) {
          if (!SIMPLE_CHILD_TYPES.has(child.type)) reasons.add("complexTableCellBlock");
          visitBlock(child, reasons);
        }
      }
    }
    return;
  }

  if (block.type === "blockquote") {
    if (block.content.length > 1) reasons.add("multiBlockBlockquote");
    for (const child of block.content) {
      if (!SIMPLE_CHILD_TYPES.has(child.type)) reasons.add("complexBlockquoteChild");
      visitBlock(child, reasons);
    }
  }
}
