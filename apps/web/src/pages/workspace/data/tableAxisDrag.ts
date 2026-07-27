import { materializeDraftBlockNodes, type PmBlockNode } from "@qingagent/pm-schema";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";

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
  editor.view.dispatch(tr.scrollIntoView());
  return true;
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
