import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CellSelection, setCellAttr, TableMap } from "@tiptap/pm/tables";

export interface TableAxisSelection {
  axis: "column" | "row";
  startIndex: number;
  endIndex: number;
}

export type TableToolbarFormatCommand = "bold" | "italic" | "underline" | "strike" | "textColor" | "cellBackground";

export function isTableToolbarFormatCommand(cmd: string): cmd is TableToolbarFormatCommand {
  return cmd === "bold" || cmd === "italic" || cmd === "underline" || cmd === "strike" || cmd === "textColor" || cmd === "cellBackground";
}

export function setTableCellSelectionFromDom(
  editor: Editor,
  anchorCell: HTMLTableCellElement,
  headCell: HTMLTableCellElement = anchorCell,
): boolean {
  const anchorPos = resolveTableCellPos(editor, anchorCell);
  const headPos = resolveTableCellPos(editor, headCell);
  if (anchorPos == null || headPos == null) return false;
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, anchorPos, headPos)));
  return true;
}

/** 按模型逻辑列建立整列选区，避免 DOM cell 索引在表格重建后失真。 */
export function selectTableColumns(
  editor: Editor,
  tableBlockId: string,
  startCol: number,
  endCol: number,
): boolean {
  return selectTableAxis(editor, tableBlockId, "column", startCol, endCol);
}

/** 按模型逻辑行建立整行选区。 */
export function selectTableRows(
  editor: Editor,
  tableBlockId: string,
  startRow: number,
  endRow: number,
): boolean {
  return selectTableAxis(editor, tableBlockId, "row", startRow, endRow);
}

/** TableControls 的 active 状态只从当前 PM 选区投影，不另存一份真源。 */
export function readTableAxisSelection(
  editor: Editor,
  tableBlockId: string,
): TableAxisSelection | null {
  const selection = editor.state.selection;
  if (!(selection instanceof CellSelection)) return null;
  const located = findTableByBlockId(editor, tableBlockId);
  if (!located || selection.$anchorCell.node(-1) !== located.table || selection.$headCell.node(-1) !== located.table) {
    return null;
  }
  const map = TableMap.get(located.table);
  const tableStart = located.pos + 1;
  const anchorRect = map.findCell(selection.$anchorCell.pos - tableStart);
  const headRect = map.findCell(selection.$headCell.pos - tableStart);
  const isColSelection = selection.isColSelection();
  const isRowSelection = selection.isRowSelection();
  // 整表选区同时满足两个谓词；构造时用锚头方向编码来源轴，仍由 selection 本身判定。
  const axis = isColSelection && isRowSelection
    ? (selection.$anchorCell.pos > selection.$headCell.pos ? "row" : "column")
    : isColSelection
      ? "column"
      : isRowSelection
        ? "row"
        : null;
  if (axis === "column") {
    return {
      axis: "column",
      startIndex: Math.min(anchorRect.left, headRect.left),
      endIndex: Math.max(anchorRect.right, headRect.right) - 1,
    };
  }
  if (axis === "row") {
    return {
      axis: "row",
      startIndex: Math.min(anchorRect.top, headRect.top),
      endIndex: Math.max(anchorRect.bottom, headRect.bottom) - 1,
    };
  }
  return null;
}

export function applyTableToolbarFormat(editor: Editor, cmd: TableToolbarFormatCommand, value?: string | null): boolean {
  const chain = editor.chain().focus();
  switch (cmd) {
    case "bold":
      return chain.toggleBold().run();
    case "italic":
      return chain.toggleItalic().run();
    case "underline":
      return chain.toggleUnderline().run();
    case "strike":
      return chain.toggleStrike().run();
    case "textColor":
      if (!value || value === "transparent") return chain.unsetMark("textColor").run();
      return chain.setMark("textColor", { color: value }).run();
    case "cellBackground": {
      editor.commands.focus();
      return setCellAttr("backgroundColor", value && value !== "transparent" ? value : null)(
        editor.state,
        editor.view.dispatch,
      );
    }
  }
}

function resolveTableCellPos(editor: Editor, cell: HTMLTableCellElement): number | null {
  const candidates = new Set<number>();

  try {
    candidates.add(editor.view.posAtDOM(cell, 0));
  } catch {
    // stale DOM
  }
  try {
    candidates.add(editor.view.posAtDOM(cell, Math.min(1, cell.childNodes.length)));
  } catch {
    // stale DOM
  }
  try {
    const firstChild = cell.firstChild;
    if (firstChild) candidates.add(editor.view.posAtDOM(firstChild, 0) - 1);
  } catch {
    // stale DOM
  }

  for (const pos of candidates) {
    if (!Number.isInteger(pos) || pos < 0) continue;
    for (const candidate of [pos, pos - 1, pos + 1]) {
      if (candidate < 0 || candidate > editor.state.doc.content.size) continue;
      const resolved = editor.state.doc.resolve(candidate);
      const nodeAfter = resolved.nodeAfter;
      if (nodeAfter?.type.name === "tableCell" || nodeAfter?.type.name === "tableHeader") {
        return candidate;
      }
    }
  }

  return null;
}

function selectTableAxis(
  editor: Editor,
  tableBlockId: string,
  axis: TableAxisSelection["axis"],
  startIndex: number,
  endIndex: number,
): boolean {
  if (!editor.isEditable || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return false;
  const located = findTableByBlockId(editor, tableBlockId);
  if (!located) return false;
  const map = TableMap.get(located.table);
  const limit = axis === "column" ? map.width : map.height;
  if (startIndex < 0 || endIndex < 0 || startIndex >= limit || endIndex >= limit) return false;

  const low = Math.min(startIndex, endIndex);
  const high = Math.max(startIndex, endIndex);
  const tableStart = located.pos + 1;
  const anchorOffset = axis === "column"
    ? map.positionAt(0, low, located.table)
    : map.positionAt(high, 0, located.table);
  const headOffset = axis === "column"
    ? map.positionAt(0, high, located.table)
    : map.positionAt(low, 0, located.table);
  const $anchor = editor.state.doc.resolve(tableStart + anchorOffset);
  const $head = editor.state.doc.resolve(tableStart + headOffset);
  const selection = axis === "column"
    ? CellSelection.colSelection($anchor, $head)
    : CellSelection.rowSelection($anchor, $head);
  if (editor.state.selection.eq(selection)) return false;
  editor.view.dispatch(editor.state.tr.setSelection(selection));
  return true;
}

function findTableByBlockId(
  editor: Editor,
  tableBlockId: string,
): { table: ProseMirrorNode; pos: number } | null {
  let found: { table: ProseMirrorNode; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.spec.tableRole === "table" && node.attrs.blockId === tableBlockId) {
      found = { table: node, pos };
      return false;
    }
    return true;
  });
  return found;
}
