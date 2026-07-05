import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import { Fragment, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const COLUMN_DND_META = "qingagentColumnDnd";
export const MAX_COLUMNS = 4;
const MIN_NEW_COLUMN_RATIO = 0.15;
const MAX_NEW_COLUMN_RATIO = 0.33;
const RATIO_EPSILON = 0.0001;
let generatedColumnIdSeq = 0;

export type ColumnDropSide = "left" | "right";

export interface MovableBlock {
  pos: number;
  node: PmNode;
  parentType: string;
  parentPos: number | null;
  parentDepth: number;
  index: number;
  columnListPos: number | null;
  columnIndex: number | null;
}

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export type DropIntent =
  | { kind: "native" }
  | { kind: "vertical" }
  | { kind: "reject" }
  | { kind: "columnEdge"; source: MovableBlock; target: MovableBlock; side: ColumnDropSide; edgePx: number };

export interface ResolveDropIntentInput {
  state: EditorState;
  source: MovableBlock | null;
  coords: { left: number; top: number };
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null;
  getRect: (block: MovableBlock) => RectLike | null;
}

interface ColumnDraft {
  attrs: Record<string, unknown>;
  blocks: PmNode[];
}

interface ColumnDnDState {
  decorations: DecorationSet;
  target: { pos: number; side: ColumnDropSide } | null;
}

type ColumnDnDMeta =
  | { kind: "set"; pos: number; to: number; side: ColumnDropSide }
  | { kind: "clear" };

type DraggingView = EditorView & {
  dragging?: {
    slice?: Slice;
    node?: NodeSelection;
  } | null;
};

const columnDndKey = new PluginKey<ColumnDnDState>("qingagentColumnDnd");

const rejectedDirectTargetTypes = new Set([
  "column",
  "columnList",
  "tableRow",
  "tableCell",
  "tableHeader",
  "listItem",
  "taskItem",
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundRatio(value: number): number {
  return Number(value.toFixed(4));
}

function roundRatiosWithLastRemainder(ratios: readonly number[]): number[] {
  if (ratios.length === 0) return [];
  if (ratios.length === 1) return [1];
  const next = ratios.map((ratio) => roundRatio(ratio));
  const sumExceptLast = next.slice(0, -1).reduce((sum, ratio) => sum + ratio, 0);
  next[next.length - 1] = roundRatio(Math.max(0, 1 - sumExceptLast));
  return next;
}

function createGeneratedBlockId(kind: "columnList" | "column" | "paragraph"): string {
  const random =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${++generatedColumnIdSeq}`;
  return `block-${kind}-${random}`;
}

function createFallbackParagraph(doc: PmNode): PmNode {
  return doc.type.schema.nodes.paragraph!.create({ blockId: createGeneratedBlockId("paragraph") });
}

function ensureNonEmptyDocInTransaction(tr: Transaction) {
  if (tr.doc.childCount > 0) return;
  tr.insert(0, createFallbackParagraph(tr.doc));
}

export function normalizeColumnDropRatios(ratios: readonly unknown[]): number[] {
  if (ratios.length === 0) return [];
  const parsed = ratios.map((ratio) =>
    typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : null,
  );
  if (!parsed.every((ratio): ratio is number => ratio != null)) {
    return roundRatiosWithLastRemainder(Array.from({ length: ratios.length }, () => 1 / ratios.length));
  }
  const total = parsed.reduce((sum, ratio) => sum + ratio, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return roundRatiosWithLastRemainder(Array.from({ length: ratios.length }, () => 1 / ratios.length));
  }
  return roundRatiosWithLastRemainder(parsed.map((ratio) => ratio / total));
}

export function findDraggableBlock($pos: ResolvedPos): MovableBlock | null {
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const node = $pos.node(depth);
    const parent = $pos.node(depth - 1);
    if (!node.isBlock) continue;
    if (parent.type.name !== "doc" && parent.type.name !== "column") continue;
    const pos = $pos.before(depth);
    return {
      pos,
      node,
      parentType: parent.type.name,
      parentPos: depth > 1 ? $pos.before(depth - 1) : null,
      parentDepth: depth - 1,
      index: $pos.index(depth - 1),
      columnListPos: parent.type.name === "column" && depth >= 2 ? $pos.before(depth - 2) : null,
      columnIndex: parent.type.name === "column" && depth >= 2 ? $pos.index(depth - 2) : null,
    };
  }
  // 叶子块(atom,如 diagram / horizontalRule / image)无法从"内部位置"解析到自身
  // (向上走 node(depth) 永远拿到的是父节点)。改从边界命中:若解析点正好在某叶子块之前,
  // 用 $pos.nodeAfter 把这个叶子块当作可拖块返回。索引/父级口径与上面分支保持一致。
  const after = $pos.nodeAfter;
  const boundaryParent = $pos.parent;
  if (
    after &&
    after.isBlock &&
    (boundaryParent.type.name === "doc" || boundaryParent.type.name === "column")
  ) {
    const d = $pos.depth; // 父级深度;叶子块概念上位于 d+1
    return {
      pos: $pos.pos,
      node: after,
      parentType: boundaryParent.type.name,
      parentPos: d >= 1 ? $pos.before(d) : null,
      parentDepth: d,
      index: $pos.index(d),
      columnListPos: boundaryParent.type.name === "column" && d >= 2 ? $pos.before(d - 1) : null,
      columnIndex: boundaryParent.type.name === "column" && d >= 2 ? $pos.index(d - 1) : null,
    };
  }
  return null;
}

export function resolveBlockAtPos(state: EditorState, pos: number): MovableBlock | null {
  return resolveBlockInDoc(state.doc, pos);
}

function resolveBlockInDoc(doc: PmNode, pos: number): MovableBlock | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter;
  if (!node?.isBlock) return null;
  return {
    pos,
    node,
    parentType: $pos.parent.type.name,
    parentPos: $pos.depth > 0 ? $pos.before($pos.depth) : null,
    parentDepth: $pos.depth,
    index: $pos.index(),
    columnListPos: $pos.parent.type.name === "column" && $pos.depth >= 2 ? $pos.before($pos.depth - 1) : null,
    columnIndex: $pos.parent.type.name === "column" && $pos.depth >= 2 ? $pos.index($pos.depth - 1) : null,
  };
}

export function resolveMovableBlockAtCoords(
  state: EditorState,
  coords: { left: number; top: number },
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null,
  getRect?: (block: MovableBlock) => RectLike | null,
): MovableBlock | null {
  const hit = posAtCoords(coords);
  if (hit) {
    const boundedPos = clamp(hit.pos, 0, state.doc.content.size);
    const byPos = findDraggableBlock(state.doc.resolve(boundedPos));
    if (byPos && !rejectedDirectTargetTypes.has(byPos.node.type.name)) return byPos;
  }

  if (!getRect) return null;
  let best: MovableBlock | undefined;
  let bestArea = Number.POSITIVE_INFINITY;
  state.doc.descendants((node, pos, parent, index) => {
    if (!parent || !node.isBlock) return true;
    if (parent.type.name !== "doc" && parent.type.name !== "column") return true;
    if (rejectedDirectTargetTypes.has(node.type.name)) return true;
    const block: MovableBlock = {
      pos,
      node,
      parentType: parent.type.name,
      parentPos: null,
      parentDepth: 0,
      index,
      columnListPos: null,
      columnIndex: null,
    };
    const rect = getRect(block);
    if (!rect) return false;
    const inside =
      coords.top >= rect.top &&
      coords.top <= rect.bottom &&
      coords.left >= rect.left &&
      coords.left <= rect.right;
    if (!inside) return false;
    const area = Math.max(1, rect.width * rect.height);
    if (area < bestArea) {
      best = block;
      bestArea = area;
    }
    return false;
  });
  const fallback = best;
  if (!fallback) return null;
  return resolveBlockAtPos(state, fallback.pos) ?? fallback;
}

export function resolveDropIntent(input: ResolveDropIntentInput): DropIntent {
  const { source, state, coords, posAtCoords, getRect } = input;
  if (!source) return { kind: "native" };
  if (source.node.type.name === "columnList") return { kind: "native" };
  const target = resolveMovableBlockAtCoords(state, coords, posAtCoords, getRect);
  if (!target) return { kind: "native" };
  if (target.node.type.name === "columnList") return { kind: "native" };
  if (source.pos === target.pos || containsPos(source, target.pos) || containsPos(target, source.pos)) {
    return { kind: "reject" };
  }
  const rect = getRect(target);
  if (!rect || rect.width <= 0 || rect.height <= 0) return { kind: "native" };
  if (coords.top < rect.top || coords.top > rect.bottom) return { kind: "native" };
  const edgePx = clamp(rect.width * 0.2, 24, 64);
  const middle = rect.left + rect.width / 2;
  const side: ColumnDropSide = coords.left < middle ? "left" : "right";
  const distance = side === "left" ? coords.left - rect.left : rect.right - coords.left;
  if (distance > edgePx) return { kind: "vertical" };
  // MAX_COLUMNS:目标列所在 columnList 已满,且不是同列表内重排(重排不增列)→ 不建栏,
  // 降级竖直(让原生 dropcursor 接管),避免画了"建栏"金边却在 drop 时无法建栏。
  if (target.parentType === "column" && target.columnListPos != null) {
    const list = state.doc.nodeAt(target.columnListPos);
    if (
      list &&
      list.type.name === "columnList" &&
      list.childCount >= MAX_COLUMNS &&
      source.columnListPos !== target.columnListPos
    ) {
      return { kind: "vertical" };
    }
  }
  return { kind: "columnEdge", source, target, side, edgePx };
}

function containsPos(block: MovableBlock, pos: number): boolean {
  return pos > block.pos && pos < block.pos + block.node.nodeSize;
}

function isSourceAllowed(source: MovableBlock | null): source is MovableBlock {
  return !!source && source.node.type.name !== "columnList";
}

function isTargetAllowed(target: MovableBlock | null): target is MovableBlock {
  return !!target && !rejectedDirectTargetTypes.has(target.node.type.name);
}

function columnsFromList(list: PmNode): ColumnDraft[] {
  const columns: ColumnDraft[] = [];
  for (let i = 0; i < list.childCount; i++) {
    const column = list.child(i);
    const blocks: PmNode[] = [];
    for (let j = 0; j < column.childCount; j++) blocks.push(column.child(j));
    columns.push({ attrs: { ...column.attrs }, blocks });
  }
  return columns;
}

function filterEmptyColumns(columns: readonly ColumnDraft[]): ColumnDraft[] {
  return columns.filter((column) => column.blocks.length > 0);
}

function makeColumnListNodeFromDoc(doc: PmNode, attrs: Record<string, unknown>, columns: readonly ColumnDraft[]): PmNode {
  const ratios = normalizeColumnDropRatios(columns.map((column) => column.attrs.widthRatio));
  const schema = doc.type.schema;
  const nodes = columns.map((column, index) =>
    schema.nodes.column!.create({ ...column.attrs, widthRatio: ratios[index] }, Fragment.fromArray(column.blocks.slice())),
  );
  return schema.nodes.columnList!.create(attrs, Fragment.fromArray(nodes));
}

function replaceListInTransaction(
  tr: Transaction,
  listPos: number,
  list: PmNode,
  columns: readonly ColumnDraft[],
): boolean {
  const kept = filterEmptyColumns(columns);
  if (kept.length >= 2) {
    tr.replaceWith(listPos, listPos + list.nodeSize, makeColumnListNodeFromDoc(tr.doc, list.attrs, kept));
    return true;
  }
  if (kept.length === 1) {
    tr.replaceWith(listPos, listPos + list.nodeSize, Fragment.fromArray(kept[0]!.blocks));
    return true;
  }
  tr.delete(listPos, listPos + list.nodeSize);
  return true;
}

function removeSourceFromColumns(columns: readonly ColumnDraft[], source: MovableBlock): ColumnDraft[] {
  return columns.map((column, columnIndex) => {
    if (source.columnIndex !== columnIndex) return { attrs: column.attrs, blocks: column.blocks.slice() };
    return {
      attrs: column.attrs,
      blocks: column.blocks.filter((_, blockIndex) => blockIndex !== source.index),
    };
  });
}

function removeSourceFirst(tr: Transaction, source: MovableBlock): boolean {
  if (source.parentType === "doc") {
    tr.delete(source.pos, source.pos + source.node.nodeSize);
    return true;
  }
  if (source.parentType !== "column" || source.columnListPos == null) return false;
  const list = tr.doc.nodeAt(source.columnListPos);
  if (!list || list.type.name !== "columnList") return false;
  const columns = removeSourceFromColumns(columnsFromList(list), source);
  return replaceListInTransaction(tr, source.columnListPos, list, columns);
}

function safeFinalize(tr: Transaction): Transaction | null {
  if (!tr.docChanged) return null;
  ensureNonEmptyDocInTransaction(tr);
  try {
    tr.doc.check();
  } catch {
    return null;
  }
  return tr.setMeta(COLUMN_DND_META, true).scrollIntoView();
}

function mapTargetAfterSourceRemoval(tr: Transaction, target: MovableBlock, source: MovableBlock) {
  return tr.mapping.mapResult(target.pos, target.pos >= source.pos ? 1 : -1);
}

function sourceAndTargetValid(source: MovableBlock | null, target: MovableBlock | null): boolean {
  if (!isSourceAllowed(source) || !isTargetAllowed(target)) return false;
  if (source.pos === target.pos || containsPos(source, target.pos) || containsPos(target, source.pos)) return false;
  return true;
}

export function rebuildColumnList(
  state: EditorState,
  columnListPos: number,
  sourcePos?: number,
): Transaction | null {
  const list = state.doc.nodeAt(columnListPos);
  if (!list || list.type.name !== "columnList") return null;
  let columns = columnsFromList(list);
  if (typeof sourcePos === "number") {
    const source = resolveBlockAtPos(state, sourcePos);
    if (!source || source.columnListPos !== columnListPos) return null;
    columns = removeSourceFromColumns(columns, source);
  }
  const tr = state.tr;
  replaceListInTransaction(tr, columnListPos, list, columns);
  return safeFinalize(tr);
}

export function buildColumnList(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
  side: ColumnDropSide,
): Transaction | null {
  const source = resolveBlockAtPos(state, sourcePos);
  const target = resolveBlockAtPos(state, targetPos);
  if (!sourceAndTargetValid(source, target)) return null;
  if (!source || !target) return null;
  if (target.parentType !== "doc") return appendColumnToList(state, sourcePos, targetPos, side);

  const tr = state.tr;
  if (!removeSourceFirst(tr, source)) return null;
  const mapped = mapTargetAfterSourceRemoval(tr, target, source);
  if (mapped.deleted) return null;
  const mappedTarget = resolveBlockInDoc(tr.doc, mapped.pos);
  if (!mappedTarget || mappedTarget.parentType !== "doc" || mappedTarget.node.type.name === "columnList") return null;

  const columns =
    side === "left"
      ? [
          { attrs: { blockId: createGeneratedBlockId("column"), widthRatio: 0.5 }, blocks: [source.node] },
          { attrs: { blockId: createGeneratedBlockId("column"), widthRatio: 0.5 }, blocks: [mappedTarget.node] },
        ]
      : [
          { attrs: { blockId: createGeneratedBlockId("column"), widthRatio: 0.5 }, blocks: [mappedTarget.node] },
          { attrs: { blockId: createGeneratedBlockId("column"), widthRatio: 0.5 }, blocks: [source.node] },
        ];
  const list = makeColumnListNodeFromDoc(tr.doc, { blockId: createGeneratedBlockId("columnList") }, columns);
  tr.replaceWith(mappedTarget.pos, mappedTarget.pos + mappedTarget.node.nodeSize, list);
  return safeFinalize(tr);
}

export function appendColumnToList(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
  side: ColumnDropSide,
): Transaction | null {
  const source = resolveBlockAtPos(state, sourcePos);
  const target = resolveBlockAtPos(state, targetPos);
  if (!sourceAndTargetValid(source, target)) return null;
  if (!source || !target) return null;
  if (target.parentType !== "column" || target.columnListPos == null || target.columnIndex == null) return null;
  if (source.columnListPos === target.columnListPos) {
    return appendColumnToSameList(state, source, target, side);
  }

  const tr = state.tr;
  if (!removeSourceFirst(tr, source)) return null;
  const mappedTarget = mapTargetAfterSourceRemoval(tr, target, source);
  if (mappedTarget.deleted) return null;
  const nextTarget = resolveBlockInDoc(tr.doc, mappedTarget.pos);
  if (!nextTarget || nextTarget.parentType !== "column" || nextTarget.columnListPos == null || nextTarget.columnIndex == null) {
    return null;
  }
  const list = tr.doc.nodeAt(nextTarget.columnListPos);
  if (!list || list.type.name !== "columnList") return null;
  const columns = columnsFromList(list);
  const nextColumns = insertSourceColumn(columns, nextTarget.columnIndex, side, source.node);
  if (!nextColumns) return null;
  tr.replaceWith(
    nextTarget.columnListPos,
    nextTarget.columnListPos + list.nodeSize,
    makeColumnListNodeFromDoc(tr.doc, list.attrs, nextColumns),
  );
  return safeFinalize(tr);
}

function appendColumnToSameList(
  state: EditorState,
  source: MovableBlock,
  target: MovableBlock,
  side: ColumnDropSide,
): Transaction | null {
  if (source.columnListPos == null || target.columnListPos == null || source.columnListPos !== target.columnListPos) {
    return null;
  }
  const list = state.doc.nodeAt(source.columnListPos);
  if (!list || list.type.name !== "columnList") return null;
  // same-list 重排:在删源前快照上算 target 新索引。注意 target.columnIndex 是删源前的索引,
  // 若源所在列被整列丢弃(源是该列唯一块)且在 target 左侧,删后 target 及其右侧列索引全 -1,
  // 必须补偿,否则块落错栏(off-by-one)。源列未塌(还有其它块)则不偏移。
  const removed = removeSourceFromColumns(columnsFromList(list), source);
  const sourceColumnDropped =
    source.columnIndex != null && (removed[source.columnIndex]?.blocks.length ?? 0) === 0;
  const withoutSource = filterEmptyColumns(removed);
  if (withoutSource.length === 0) return null;
  let adjustedTargetIndex = target.columnIndex ?? 0;
  if (sourceColumnDropped && source.columnIndex != null && source.columnIndex < adjustedTargetIndex) {
    adjustedTargetIndex -= 1;
  }
  adjustedTargetIndex = clamp(adjustedTargetIndex, 0, withoutSource.length - 1);
  const nextColumns = insertSourceColumn(withoutSource, adjustedTargetIndex, side, source.node);
  if (!nextColumns) return null;
  const tr = state.tr.replaceWith(
    source.columnListPos,
    source.columnListPos + list.nodeSize,
    makeColumnListNodeFromDoc(state.doc, list.attrs, nextColumns),
  );
  return safeFinalize(tr);
}

function insertSourceColumn(
  columns: readonly ColumnDraft[],
  targetColumnIndex: number,
  side: ColumnDropSide,
  sourceNode: PmNode,
): ColumnDraft[] | null {
  if (targetColumnIndex < 0 || targetColumnIndex >= columns.length) return null;
  if (columns.length >= MAX_COLUMNS) return null;
  const newRatio = clamp(1 / (columns.length + 1), MIN_NEW_COLUMN_RATIO, MAX_NEW_COLUMN_RATIO);
  const oldRatios = normalizeColumnDropRatios(columns.map((column) => column.attrs.widthRatio));
  const scaled = columns.map((column, index) => ({
    attrs: { ...column.attrs, widthRatio: roundRatio((oldRatios[index] ?? 1 / columns.length) * (1 - newRatio)) },
    blocks: column.blocks.slice(),
  }));
  const newColumn: ColumnDraft = {
    attrs: { blockId: createGeneratedBlockId("column"), widthRatio: newRatio },
    blocks: [sourceNode],
  };
  const insertAt = side === "left" ? targetColumnIndex : targetColumnIndex + 1;
  return [...scaled.slice(0, insertAt), newColumn, ...scaled.slice(insertAt)];
}

// 在分隔线小圆点处插入一个新的空列：在 insertIndex 位置塞入只含空段落的 column，
// 其余列等比缩放为新列让出空间（复用 insertSourceColumn 的比例算法），受 MAX_COLUMNS 限制。
export function insertEmptyColumnTransaction(
  state: EditorState,
  columnListPos: number,
  insertIndex: number,
): Transaction | null {
  const list = state.doc.nodeAt(columnListPos);
  if (!list || list.type.name !== "columnList") return null;
  if (list.childCount >= MAX_COLUMNS) return null;
  const columns = columnsFromList(list);
  const idx = clamp(insertIndex, 0, columns.length);
  const newRatio = clamp(1 / (columns.length + 1), MIN_NEW_COLUMN_RATIO, MAX_NEW_COLUMN_RATIO);
  const oldRatios = normalizeColumnDropRatios(columns.map((column) => column.attrs.widthRatio));
  const scaled = columns.map((column, index) => ({
    attrs: { ...column.attrs, widthRatio: roundRatio((oldRatios[index] ?? 1 / columns.length) * (1 - newRatio)) },
    blocks: column.blocks.slice(),
  }));
  const emptyParagraph = state.doc.type.schema.nodes.paragraph!.create({
    blockId: createGeneratedBlockId("paragraph"),
  });
  const newColumn: ColumnDraft = {
    attrs: { blockId: createGeneratedBlockId("column"), widthRatio: newRatio },
    blocks: [emptyParagraph],
  };
  const nextColumns = [...scaled.slice(0, idx), newColumn, ...scaled.slice(idx)];
  const newListNode = makeColumnListNodeFromDoc(state.doc, list.attrs, nextColumns);
  const tr = state.tr.replaceWith(columnListPos, columnListPos + list.nodeSize, newListNode);
  // 把光标落进新建的空列里(其空段落),让用户可以直接开始输入。
  // 位置 = columnList 内偏移到第 idx 个 column 的起点,再 +2(进 column、进 paragraph)。
  let columnStart = columnListPos + 1;
  for (let i = 0; i < idx; i++) columnStart += newListNode.child(i).nodeSize;
  try {
    tr.setSelection(TextSelection.create(tr.doc, columnStart + 2));
  } catch {
    // 落点异常则保留默认选区,不影响插入本身。
  }
  return safeFinalize(tr);
}

// 删除整列（光标在空列按退格触发）：去掉 columnIndex 那一列、其余 ratio 重归一化；
// 剩 1 列则解体提回父层（replaceListInTransaction 已含该逻辑）。光标落到相邻列/解体内容里。
export function removeColumnTransaction(
  state: EditorState,
  columnListPos: number,
  columnIndex: number,
): Transaction | null {
  const list = state.doc.nodeAt(columnListPos);
  if (!list || list.type.name !== "columnList") return null;
  if (columnIndex < 0 || columnIndex >= list.childCount) return null;
  const columns = columnsFromList(list).filter((_, i) => i !== columnIndex);
  const tr = state.tr;
  if (!replaceListInTransaction(tr, columnListPos, list, columns)) return null;
  // 放置光标：列表还在→落到相邻列(优先前一列)末尾；已解体→落到解体内容开头附近。
  const node = tr.doc.nodeAt(columnListPos);
  let target: number;
  if (node && node.type.name === "columnList") {
    const idx = clamp(columnIndex - 1, 0, node.childCount - 1);
    let p = columnListPos + 1;
    for (let i = 0; i < idx; i++) p += node.child(i)!.nodeSize;
    target = p + node.child(idx)!.nodeSize - 1; // 该列内容末尾(闭合标签前)
  } else {
    target = columnListPos + 1;
  }
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target, tr.doc.content.size)), -1));
  } catch {
    // 落点异常忽略
  }
  return safeFinalize(tr);
}

export function buildColumnDropTransaction(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
  side: ColumnDropSide,
): Transaction | null {
  const target = resolveBlockAtPos(state, targetPos);
  if (!target) return null;
  return target.parentType === "column"
    ? appendColumnToList(state, sourcePos, targetPos, side)
    : buildColumnList(state, sourcePos, targetPos, side);
}

function getRectForViewBlock(view: EditorView, block: MovableBlock): RectLike | null {
  const dom = view.nodeDOM(block.pos);
  if (!(dom instanceof HTMLElement)) return null;
  return dom.getBoundingClientRect();
}

function resolveActiveDragSource(view: EditorView): MovableBlock | null {
  const dragging = (view as DraggingView).dragging;
  if (!dragging?.slice) return null;
  const selection = view.state.selection instanceof NodeSelection ? view.state.selection : dragging.node;
  if (!(selection instanceof NodeSelection)) return null;
  return resolveBlockAtPos(view.state, selection.from);
}

function setColumnDropTarget(view: EditorView, target: MovableBlock, side: ColumnDropSide) {
  const current = columnDndKey.getState(view.state)?.target;
  view.dom.classList.add("pm-column-dnd-active");
  if (current?.pos === target.pos && current.side === side) return;
  view.dispatch(
    view.state.tr.setMeta(columnDndKey, {
      kind: "set",
      pos: target.pos,
      to: target.pos + target.node.nodeSize,
      side,
    } satisfies ColumnDnDMeta),
  );
}

function clearColumnDropTarget(view: EditorView) {
  view.dom.classList.remove("pm-column-dnd-active");
  const current = columnDndKey.getState(view.state)?.target;
  if (!current) return;
  view.dispatch(view.state.tr.setMeta(columnDndKey, { kind: "clear" } satisfies ColumnDnDMeta));
}

function clearColumnDropClassOnly(view: EditorView) {
  view.dom.classList.remove("pm-column-dnd-active");
}

function eventCoords(event: DragEvent): { left: number; top: number } {
  return { left: event.clientX, top: event.clientY };
}

function resolveIntentFromEvent(view: EditorView, event: DragEvent): DropIntent {
  return resolveDropIntent({
    state: view.state,
    source: resolveActiveDragSource(view),
    coords: eventCoords(event),
    posAtCoords: (coords) => view.posAtCoords(coords),
    getRect: (block) => getRectForViewBlock(view, block),
  });
}

function applyColumnDrop(view: EditorView, source: MovableBlock, target: MovableBlock, side: ColumnDropSide): boolean {
  const tr = buildColumnDropTransaction(view.state, source.pos, target.pos, side);
  if (!tr) return false;
  clearColumnDropClassOnly(view);
  tr.setMeta(columnDndKey, { kind: "clear" } satisfies ColumnDnDMeta);
  view.dispatch(tr);
  return true;
}

function flattenColumnListBlocks(list: PmNode): PmNode[] {
  const blocks: PmNode[] = [];
  for (let i = 0; i < list.childCount; i++) {
    const column = list.child(i);
    for (let j = 0; j < column.childCount; j++) blocks.push(column.child(j));
  }
  return blocks;
}

function normalizeColumnListForGuard(doc: PmNode, list: PmNode): PmNode | Fragment | null {
  const columns = columnsFromList(list);
  const kept = columns.filter((column) => column.blocks.length > 0);
  if (kept.length <= 0) return Fragment.empty;
  if (kept.length === 1) return Fragment.fromArray(kept[0]!.blocks);
  const normalized = normalizeColumnDropRatios(kept.map((column) => column.attrs.widthRatio));
  let changed = kept.length !== columns.length;
  const nextColumns = kept.map((column, index) => {
    const current = typeof column.attrs.widthRatio === "number" ? column.attrs.widthRatio : null;
    if (current == null || Math.abs(current - normalized[index]!) > RATIO_EPSILON) changed = true;
    return { attrs: { ...column.attrs, widthRatio: normalized[index] }, blocks: column.blocks };
  });
  if (!changed) return null;
  return makeColumnListNodeFromDoc(doc, list.attrs, nextColumns);
}

function appendColumnGuardTransaction(state: EditorState): Transaction | null {
  const targets: Array<{ pos: number; node: PmNode; parentType: string }> = [];
  state.doc.descendants((node, pos, parent) => {
    if (node.type.name === "columnList") {
      targets.push({ pos, node, parentType: parent?.type.name ?? "doc" });
    }
    return true;
  });
  if (targets.length === 0) return null;

  const tr = state.tr;
  let changed = false;
  for (const target of targets.sort((a, b) => b.pos - a.pos)) {
    const node = tr.doc.nodeAt(target.pos);
    if (!node || node.type.name !== "columnList") continue;
    if (target.parentType === "column") {
      const blocks = flattenColumnListBlocks(node);
      tr.replaceWith(target.pos, target.pos + node.nodeSize, Fragment.fromArray(blocks));
      changed = true;
      continue;
    }
    const replacement = normalizeColumnListForGuard(tr.doc, node);
    if (!replacement) continue;
    tr.replaceWith(target.pos, target.pos + node.nodeSize, replacement);
    changed = true;
  }
  if (!changed) return null;
  ensureNonEmptyDocInTransaction(tr);
  try {
    tr.doc.check();
  } catch {
    return null;
  }
  return tr.setMeta(COLUMN_DND_META, "guard");
}

export function createColumnDndPlugin(): Plugin {
  return new Plugin<ColumnDnDState>({
    key: columnDndKey,
    state: {
      init: (_, state) => ({ decorations: DecorationSet.empty, target: null }),
      apply(tr, value) {
        const meta = tr.getMeta(columnDndKey) as ColumnDnDMeta | undefined;
        if (meta?.kind === "set") {
          const deco = Decoration.node(meta.pos, meta.to, {
            class: `pm-column-drop-target--${meta.side}`,
          });
          return {
            decorations: DecorationSet.create(tr.doc, [deco]),
            target: { pos: meta.pos, side: meta.side },
          };
        }
        if (meta?.kind === "clear") return { decorations: DecorationSet.empty, target: null };
        return {
          decorations: value.decorations.map(tr.mapping, tr.doc),
          target: value.target ? { pos: tr.mapping.map(value.target.pos, -1), side: value.target.side } : null,
        };
      },
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      return appendColumnGuardTransaction(newState);
    },
    props: {
      decorations(state) {
        return columnDndKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        dragover(view, event) {
          const intent = resolveIntentFromEvent(view, event);
          if (intent.kind === "columnEdge") {
            event.preventDefault();
            setColumnDropTarget(view, intent.target, intent.side);
            return true;
          }
          clearColumnDropTarget(view);
          return false;
        },
        dragleave(view) {
          clearColumnDropTarget(view);
          return false;
        },
        dragend(view) {
          clearColumnDropTarget(view);
          return false;
        },
        drop(view) {
          clearColumnDropClassOnly(view);
          return false;
        },
      },
      handleDrop(view, event, _slice, moved) {
        if (!moved) {
          clearColumnDropTarget(view);
          return false;
        }
        const intent = resolveIntentFromEvent(view, event);
        if (intent.kind !== "columnEdge") {
          clearColumnDropTarget(view);
          return false;
        }
        const applied = applyColumnDrop(view, intent.source, intent.target, intent.side);
        if (!applied) {
          // 意图本是建栏却没建成(如目标列表已满/事务校验失败):吞掉这次 drop,
          // 不让 PM 原生 drop 把块乱插到落点(误导高亮后又做错事)。块保持原位。
          clearColumnDropTarget(view);
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        return true;
      },
    },
  });
}
