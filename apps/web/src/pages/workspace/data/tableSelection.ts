import {
  tableSelectionTextSignature,
  type TableSelection,
} from "@qingagent/contract-ts";
import type { AiModifyTarget } from "./aiModifyTarget";

export type TableSelectionRange = readonly [number, number];

export function normalizeTableSelection(
  axis: TableSelection["axis"],
  range: TableSelectionRange,
): Omit<TableSelection, "signature"> {
  return {
    axis,
    startIndex: Math.min(range[0], range[1]),
    endIndex: Math.max(range[0], range[1]),
  };
}

export function collectTableSelectionCellTexts(
  rows: readonly (readonly string[])[],
  selection: Pick<TableSelection, "axis" | "startIndex" | "endIndex">,
): string[] {
  if (selection.axis === "row") {
    return rows
      .slice(selection.startIndex, selection.endIndex + 1)
      .flatMap((row) => [...row]);
  }
  return rows.flatMap((row) => row.slice(selection.startIndex, selection.endIndex + 1));
}

export function tableSelectionLabel(
  rows: readonly (readonly string[])[],
  selection: Pick<TableSelection, "axis" | "startIndex" | "endIndex">,
): string {
  if (selection.axis === "row") {
    return rows
      .slice(selection.startIndex, selection.endIndex + 1)
      .map((row) => row.join(" | "))
      .join("\n");
  }
  return collectTableSelectionCellTexts(rows, selection).join("\n");
}

export function tableSelectionSuffix(
  selection: Pick<TableSelection, "axis" | "startIndex" | "endIndex">,
): string {
  const range = selection.startIndex === selection.endIndex
    ? String(selection.startIndex + 1)
    : `${selection.startIndex + 1}–${selection.endIndex + 1}`;
  return `表格·第${range}${selection.axis === "row" ? "行" : "列"}`;
}

export function createTableAiModifyTarget(input: {
  blockId: string;
  rows: readonly (readonly string[])[];
  axis: TableSelection["axis"];
  range: TableSelectionRange;
  signatureCellTexts?: readonly string[];
}): AiModifyTarget {
  const normalized = normalizeTableSelection(input.axis, input.range);
  const cellTexts = input.signatureCellTexts ?? collectTableSelectionCellTexts(input.rows, normalized);
  const tableSelection: TableSelection = {
    ...normalized,
    signature: tableSelectionTextSignature(cellTexts),
  };
  return {
    label: tableSelectionLabel(input.rows, tableSelection),
    suffix: tableSelectionSuffix(tableSelection),
    blockId: input.blockId,
    tableSelection,
  };
}

export function tableHasSpanInDom(table: HTMLTableElement): boolean {
  return Array.from(table.rows).some((row) =>
    Array.from(row.cells).some((cell) => cell.colSpan > 1 || cell.rowSpan > 1),
  );
}

export const tableHasMergedCells = tableHasSpanInDom;

export function tableAiModifyDisabledReason(table: HTMLTableElement): string | null {
  return tableHasSpanInDom(table) ? "含合并单元格的表格暂不支持" : null;
}
