import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { stickyHeaderColumnOffsets } from "../../data/tableStickyColumn";

export interface TableBlockMenuState {
  hasHeaderRow: boolean;
  hasHeaderColumn: boolean;
}

export function readTableBlockMenuState(table: ProseMirrorNode | null | undefined): TableBlockMenuState {
  if (!table || table.type.spec.tableRole !== "table") {
    return { hasHeaderRow: false, hasHeaderColumn: false };
  }
  const firstRow = table.firstChild;
  const hasHeaderRow = Boolean(
    firstRow &&
    firstRow.childCount > 0 &&
    Array.from({ length: firstRow.childCount }, (_, index) => firstRow.child(index))
      .every((cell) => cell.type.name === "tableHeader"),
  );
  const hasHeaderColumn = stickyHeaderColumnOffsets(table).length > 0;
  return { hasHeaderRow, hasHeaderColumn };
}

export function toggleTableHeader(
  editor: Editor,
  tablePos: number,
  axis: "row" | "column",
): boolean {
  const table = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return false;
  const textPos = firstTextPosition(table, tablePos);
  if (textPos == null) return false;
  const chain = editor.chain().focus().setTextSelection(textPos);
  return axis === "row"
    ? chain.toggleHeaderRow().run()
    : chain.toggleHeaderColumn().run();
}

export function setEvenTableColumnWidths(
  editor: Editor,
  tablePos: number,
  availableWidth?: number,
): boolean {
  const table = editor.state.doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return false;

  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return false;
  }
  if (map.width < 1) return false;

  const totalWidth = resolveAvailableTableWidth(editor, tablePos, table, map, availableWidth);
  const logicalWidths = splitLogicalColumnWidths(totalWidth, map.width);
  const cellOffsets = [...new Set(map.map)];
  let tr = editor.state.tr;

  for (const offset of cellOffsets) {
    const cell = table.nodeAt(offset);
    if (!cell || (cell.type.name !== "tableCell" && cell.type.name !== "tableHeader")) return false;
    const rect = map.findCell(offset);
    const colspan = Number(cell.attrs.colspan) || 1;
    const colwidth = logicalWidths.slice(rect.left, rect.right);
    if (colwidth.length !== colspan) return false;
    tr = tr.setNodeMarkup(tablePos + 1 + offset, undefined, { ...cell.attrs, colwidth });
  }

  try {
    tr.doc.check();
    const nextTable = tr.doc.nodeAt(tablePos);
    if (!nextTable) return false;
    TableMap.get(nextTable);
  } catch {
    return false;
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

function firstTextPosition(table: ProseMirrorNode, tablePos: number): number | null {
  let found: number | null = null;
  table.descendants((node, relativePos) => {
    if (found != null) return false;
    if (!node.isTextblock) return true;
    found = tablePos + 1 + relativePos + 1;
    return false;
  });
  return found;
}

function resolveAvailableTableWidth(
  editor: Editor,
  tablePos: number,
  table: ProseMirrorNode,
  map: TableMap,
  override?: number,
): number {
  if (Number.isFinite(override) && (override ?? 0) > 0) return Math.max(map.width, Math.round(override!));

  const nodeDom = editor.view.nodeDOM(tablePos);
  const element = nodeDom instanceof HTMLElement ? nodeDom : null;
  const wrapper = element?.classList.contains("tableWrapper") ? element : element?.closest<HTMLElement>(".tableWrapper");
  if (wrapper && wrapper.clientWidth > 0) return Math.max(map.width, wrapper.clientWidth);

  const existing = readExistingLogicalWidths(table, map);
  if (existing) return existing.reduce((sum, width) => sum + width, 0);
  return map.width * 100;
}

function readExistingLogicalWidths(table: ProseMirrorNode, map: TableMap): number[] | null {
  const widths: Array<number | undefined> = Array.from({ length: map.width });
  for (const offset of new Set(map.map)) {
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    const colwidth = cell.attrs.colwidth;
    if (!Array.isArray(colwidth) || colwidth.length !== (Number(cell.attrs.colspan) || 1)) continue;
    const rect = map.findCell(offset);
    colwidth.forEach((width, index) => {
      if (Number.isFinite(width) && width > 0 && widths[rect.left + index] == null) {
        widths[rect.left + index] = width;
      }
    });
  }
  return widths.every((width): width is number => typeof width === "number") ? widths : null;
}

function splitLogicalColumnWidths(totalWidth: number, columnCount: number): number[] {
  const safeTotal = Math.max(columnCount, Math.round(totalWidth));
  const base = Math.floor(safeTotal / columnCount);
  const remainder = safeTotal - base * columnCount;
  return Array.from({ length: columnCount }, (_, index) => base + (index < remainder ? 1 : 0));
}
