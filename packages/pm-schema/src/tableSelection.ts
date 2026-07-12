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
  return pmTableLogicalGrid(table).map((row) => row.map((cell) =>
    pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: cell.content }).trim(),
  ));
}

/**
 * 把物理 cell 投影到逻辑网格；跨 rowspan/colspan 的占位格都引用同一个起点 cell。
 * 该投影只表达 PM 已给出的 span 信号，不猜测或修补畸形表结构。
 */
export function pmTableLogicalGrid(table: PmTableNode): PmTableNode["content"][number]["content"][] {
  const grid: PmTableNode["content"][number]["content"][] = Array.from(
    { length: table.content.length },
    () => [],
  );
  table.content.forEach((row, rowIndex) => {
    let columnIndex = 0;
    for (const cell of row.content) {
      while (grid[rowIndex]![columnIndex]) columnIndex += 1;
      const colspan = cell.attrs?.colspan ?? 1;
      const rowspan = cell.attrs?.rowspan ?? 1;
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        const targetRow = grid[rowIndex + rowOffset];
        if (!targetRow) continue;
        for (let colOffset = 0; colOffset < colspan; colOffset += 1) {
          targetRow[columnIndex + colOffset] = cell;
        }
      }
      columnIndex += colspan;
    }
  });
  return grid;
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
