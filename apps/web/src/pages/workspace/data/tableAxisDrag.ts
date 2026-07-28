import { materializeDraftBlockNodes, type PmBlockNode } from "@qingagent/pm-schema";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { tableAxisSelectionKey } from "./tableToolbar";

export type TableDragAxis = "row" | "column";

export interface TableAxisDropInput {
  blockId: string;
  axis: TableDragAxis;
  sourceStart: number;
  sourceEnd: number;
  dropBoundary: number;
  clone: boolean;
}

export interface TableAxisDropInspection {
  allowed: boolean;
  noOp: boolean;
  reason?: "table-missing" | "source-out-of-range" | "drop-out-of-range" | "source-cuts-span" | "drop-cuts-span";
}

interface LocatedTable {
  node: ProseMirrorNode;
  pos: number;
}

export function inspectTableAxisDrop(
  editor: Editor,
  input: Omit<TableAxisDropInput, "clone">,
): TableAxisDropInspection {
  const located = findTable(editor, input.blockId);
  if (!located) return { allowed: false, noOp: false, reason: "table-missing" };
  const map = TableMap.get(located.node);
  const size = input.axis === "row" ? map.height : map.width;
  const sourceStart = Math.min(input.sourceStart, input.sourceEnd);
  const sourceEnd = Math.max(input.sourceStart, input.sourceEnd);
  if (sourceStart < 0 || sourceEnd >= size) {
    return { allowed: false, noOp: false, reason: "source-out-of-range" };
  }
  if (input.dropBoundary < 0 || input.dropBoundary > size) {
    return { allowed: false, noOp: false, reason: "drop-out-of-range" };
  }

  const sourceBoundaryEnd = sourceEnd + 1;
  for (const rect of uniqueCellRects(map)) {
    const cellStart = input.axis === "row" ? rect.top : rect.left;
    const cellEnd = input.axis === "row" ? rect.bottom : rect.right;
    const intersectsSource = cellStart < sourceBoundaryEnd && cellEnd > sourceStart;
    const containedBySource = cellStart >= sourceStart && cellEnd <= sourceBoundaryEnd;
    if (intersectsSource && !containedBySource) {
      return { allowed: false, noOp: false, reason: "source-cuts-span" };
    }
    if (cellStart < input.dropBoundary && input.dropBoundary < cellEnd) {
      return { allowed: false, noOp: false, reason: "drop-cuts-span" };
    }
  }

  return {
    allowed: true,
    noOp: input.dropBoundary >= sourceStart && input.dropBoundary <= sourceBoundaryEnd,
  };
}

export function applyTableAxisDrop(editor: Editor, input: TableAxisDropInput): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false;
  const inspection = inspectTableAxisDrop(editor, input);
  if (!inspection.allowed || inspection.noOp) return false;
  const located = findTable(editor, input.blockId);
  if (!located) return false;
  const map = TableMap.get(located.node);
  const sourceStart = Math.min(input.sourceStart, input.sourceEnd);
  const sourceEnd = Math.max(input.sourceStart, input.sourceEnd);
  const tableJson = located.node.toJSON() as PmBlockNode;
  const reordered = input.axis === "row"
    ? reorderRows(tableJson, sourceStart, sourceEnd, input.dropBoundary, input.clone)
    : reorderColumns(tableJson, located.node, map, sourceStart, sourceEnd, input.dropBoundary, input.clone);
  const prepared = input.clone
    ? materializeDraftBlockNodes([reordered], {
        namespace: `table-axis-clone:${input.blockId}:${input.axis}`,
        existingIds: collectPmBlockIds(editor.state.doc),
      })[0]!
    : reordered;
  const nextTable = editor.schema.nodeFromJSON(prepared);
  const tr = editor.state.tr.replaceWith(
    located.pos,
    located.pos + located.node.nodeSize,
    nextTable,
  );
  assertUniquePmBlockIds(tr.doc);
  // 整表 replaceWith 会把旧 CellSelection 的两个 cell 位置一起映射到"表后一格"，
  // CellSelection.map 随即降级成 TextSelection.between —— 表格是末块时光标直接甩到
  // 文档最末尾(真机 P1)。落位后必须显式把选区钉回移动后的那几列/行。
  const moved = resolveMovedAxisSelection(tr.doc, located.pos, input, sourceStart, sourceEnd);
  if (moved) tr.setSelection(moved).setMeta(tableAxisSelectionKey, input.axis);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** 落位后的目标轴区间：非克隆且向后移动时要扣掉自身占位，其余情形落点即新起点。 */
export function resolveMovedAxisRange(
  input: Pick<TableAxisDropInput, "clone" | "dropBoundary">,
  sourceStart: number,
  sourceEnd: number,
): { startIndex: number; endIndex: number } {
  const count = sourceEnd - sourceStart + 1;
  const startIndex = input.clone || input.dropBoundary <= sourceStart
    ? input.dropBoundary
    : input.dropBoundary - count;
  return { startIndex, endIndex: startIndex + count - 1 };
}

function resolveMovedAxisSelection(
  doc: ProseMirrorNode,
  tablePos: number,
  input: TableAxisDropInput,
  sourceStart: number,
  sourceEnd: number,
): Selection | null {
  const table = doc.nodeAt(tablePos);
  if (!table || table.type.spec.tableRole !== "table") return null;
  const { startIndex, endIndex } = resolveMovedAxisRange(input, sourceStart, sourceEnd);
  const map = TableMap.get(table);
  const limit = input.axis === "row" ? map.height : map.width;
  if (startIndex < 0 || endIndex >= limit) return null;
  const tableStart = tablePos + 1;
  try {
    const $start = doc.resolve(tableStart + (input.axis === "row"
      ? map.positionAt(startIndex, 0, table)
      : map.positionAt(0, startIndex, table)));
    const $end = doc.resolve(tableStart + (input.axis === "row"
      ? map.positionAt(endIndex, 0, table)
      : map.positionAt(0, endIndex, table)));
    return input.axis === "row"
      ? CellSelection.rowSelection($start, $end)
      : CellSelection.colSelection($start, $end);
  } catch {
    // 合并单元格等极端形状下无法构造整轴选区时保持沉默，交由调用方的兜底选区。
    return null;
  }
}

function reorderRows(
  table: PmBlockNode,
  sourceStart: number,
  sourceEnd: number,
  dropBoundary: number,
  clone: boolean,
): PmBlockNode {
  if (table.type !== "table") return table;
  const rows = table.content.slice();
  const selected = rows.slice(sourceStart, sourceEnd + 1);
  const inserted = clone ? selected.map((row, index) => markCloneBlockIds(row, `row-${index}`)) : selected;
  const remaining = clone
    ? rows
    : [...rows.slice(0, sourceStart), ...rows.slice(sourceEnd + 1)];
  const insertAt = clone
    ? dropBoundary
    : dropBoundary > sourceEnd
      ? dropBoundary - selected.length
      : dropBoundary;
  return {
    ...table,
    content: [...remaining.slice(0, insertAt), ...inserted, ...remaining.slice(insertAt)],
  };
}

function reorderColumns(
  table: PmBlockNode,
  tableNode: ProseMirrorNode,
  map: TableMap,
  sourceStart: number,
  sourceEnd: number,
  dropBoundary: number,
  clone: boolean,
): PmBlockNode {
  if (table.type !== "table") return table;
  let rowStart = 0;
  const rows = table.content.map((row, rowIndex) => {
    const rowNode = tableNode.child(rowIndex);
    let cellStart = rowStart + 1;
    const entries = row.content.map((cell, cellIndex) => {
      const rect = map.findCell(cellStart);
      const entry = { cell, cellIndex, rect };
      cellStart += rowNode.child(cellIndex).nodeSize;
      return entry;
    });
    rowStart += rowNode.nodeSize;
    const selected = entries.filter((entry) =>
      entry.rect.left >= sourceStart && entry.rect.right <= sourceEnd + 1,
    );
    const remaining = clone
      ? entries
      : entries.filter((entry) => !selected.includes(entry));
    const insertAt = remaining.filter((entry) => entry.rect.left < dropBoundary).length;
    const inserted = clone
      ? selected.map((entry) => ({
          ...entry,
          cell: markCloneBlockIds(entry.cell, `column-${rowIndex}-${entry.cellIndex}`),
        }))
      : selected;
    return {
      ...row,
      content: [
        ...remaining.slice(0, insertAt).map((entry) => entry.cell),
        ...inserted.map((entry) => entry.cell),
        ...remaining.slice(insertAt).map((entry) => entry.cell),
      ],
    };
  });
  return { ...table, content: rows };
}

function uniqueCellRects(map: TableMap): Array<{ left: number; right: number; top: number; bottom: number }> {
  return Array.from(new Set(map.map)).map((offset) => map.findCell(offset));
}

function findTable(editor: Editor, blockId: string): LocatedTable | null {
  let result: LocatedTable | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "table" && node.attrs.blockId === blockId) {
      result = { node, pos };
      return false;
    }
    return true;
  });
  return result;
}

function markCloneBlockIds<T>(value: T, namespace: string): T {
  let occurrence = 0;
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const record = current as Record<string, unknown>;
    const attrs = record.attrs && typeof record.attrs === "object"
      ? record.attrs as Record<string, unknown>
      : null;
    const nextAttrs = attrs && typeof attrs.blockId === "string"
      ? { ...attrs, blockId: `ai-block-table-clone-${namespace}-${occurrence++}` }
      : attrs;
    return {
      ...record,
      ...(nextAttrs ? { attrs: nextAttrs } : {}),
      ...(Array.isArray(record.content) ? { content: record.content.map(visit) } : {}),
    };
  };
  return visit(value) as T;
}

function collectPmBlockIds(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const blockId = node.attrs.blockId;
    if (typeof blockId === "string" && blockId.length > 0) ids.add(blockId);
    return true;
  });
  return ids;
}

function assertUniquePmBlockIds(doc: ProseMirrorNode): void {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const blockId = node.attrs.blockId;
    if (typeof blockId !== "string" || blockId.length === 0) return true;
    if (ids.has(blockId)) throw new Error(`表格克隆后出现重复 blockId: ${blockId}`);
    ids.add(blockId);
    return true;
  });
}
