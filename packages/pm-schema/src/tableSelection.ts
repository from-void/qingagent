import { pmToPlainText } from "./pmToPlainText";
import type { PmDoc, PmNode, PmTableNode } from "./types";

export interface PmTableSelectionRange {
  axis: "row" | "column";
  startIndex: number;
  endIndex: number;
}

export function findPmTableByBlockId(doc: PmDoc, blockId: string): PmTableNode | null {
  let found: PmTableNode | null = null;
  const visit = (node: PmNode): void => {
    if (found) return;
    if (node.type === "table" && node.attrs.blockId === blockId) {
      found = node;
      return;
    }
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content as PmNode[]) visit(child);
    }
  };
  for (const node of doc.content) visit(node);
  return found;
}

export function pmTableTextRows(table: PmTableNode): string[][] {
  return table.content.map((row) => row.content.map((cell) =>
    pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: cell.content }).trim(),
  ));
}

export function pmTableSelectionCellTexts(
  doc: PmDoc,
  blockId: string,
  selection: PmTableSelectionRange,
): string[] | null {
  const table = findPmTableByBlockId(doc, blockId);
  if (!table) return null;
  const rows = pmTableTextRows(table);
  if (selection.axis === "row") {
    if (selection.endIndex >= rows.length) return null;
    return rows
      .slice(selection.startIndex, selection.endIndex + 1)
      .flatMap((row) => row);
  }
  if (rows.some((row) => selection.endIndex >= row.length)) return null;
  return rows.flatMap((row) => row.slice(selection.startIndex, selection.endIndex + 1));
}
