import { Extension } from "@tiptap/core";
import { Fragment, type Node as PmNode, type ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { getDeterministicId } from "@qingagent/pm-schema";

export const LIST_ITEM_DND_MIME = "application/x-qingagent-list-item-dnd";
const SKIP_TRAILING_NODE_META = "skipTrailingNode";
const LIST_ITEM_DND_TRAILING_UNDO_META = "qingagentListItemDndTrailingUndo";
const LIST_ITEM_DND_ACTIVE_CLASS = "pm-listitem-dnd-active";
const LIST_ITEM_DND_ACTIVE_SCOPE_CLASS = "pm-listitem-dnd-active-scope";
const MIN_MARKER_BAND_PX = 18;
const DEFAULT_INDENT_STEP_PX = 24;
const HYSTERESIS_STEP_RATIO = 0.35;
const LEFT_BIAS_STEP_RATIO = 0.25;

export type ListItemDropPlacement = "before" | "after";
export type ListItemDropRegion = "R1" | "R2" | "R3";

export interface DraggableListItem {
  itemPos: number;
  itemNode: PmNode;
  itemType: "listItem" | "taskItem";
  listPos: number;
  listNode: PmNode;
  listType: "bulletList" | "orderedList" | "taskList";
  itemIndex: number;
  blockId: string | null;
}

export type ListItemDropIntent =
  | { kind: "native" }
  | { kind: "invalid"; source: DraggableListItem }
  | {
      kind: "noop";
      source: DraggableListItem;
      target: DraggableListItem;
      placement: ListItemDropPlacement;
      targetDepth: number;
      region: ListItemDropRegion;
    }
  | {
      kind: "reorder";
      source: DraggableListItem;
      target: DraggableListItem;
      placement: ListItemDropPlacement;
      targetDepth: number;
      region: ListItemDropRegion;
    };

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ListItemRowMetrics {
  rowRect: RectLike;
  itemRect: RectLike;
  contentRect: RectLike;
  contentElement: HTMLElement;
  itemLeft: number;
  markerLeft: number;
  contentLeft: number;
  contentRight: number;
  handleLeft: number;
  parentListPaddingLeft: number;
}

export interface ListItemDndLastZone {
  region: ListItemDropRegion;
  targetDepth: number;
  targetItemPos: number;
}

export interface ResolveListItemDropIntentInput {
  state: EditorState;
  source: DraggableListItem | null;
  coords: { left: number; top: number };
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null;
  getRect: (item: DraggableListItem) => RectLike | null;
  getRowMetrics?: (item: DraggableListItem) => ListItemRowMetrics | null;
  lastZone?: ListItemDndLastZone | null;
}

interface ListItemDndState {
  decorations: DecorationSet;
  target: { pos: number; placement: ListItemDropPlacement; region: ListItemDropRegion; targetDepth: number } | null;
  lastZone: ListItemDndLastZone | null;
  suppressTrailingAfterUndo: boolean;
}

type ListItemDndMeta =
  | {
      kind: "set";
      pos: number;
      to: number;
      placement: ListItemDropPlacement;
      region: ListItemDropRegion;
      targetDepth: number;
      lineTopPx: number;
      lineLeftPx: number;
      lineRightPx: number;
      scopeFrom: number | null;
      scopeTo: number | null;
    }
  | { kind: "clear" };

type DraggingView = EditorView & {
  dragging?: {
    node?: NodeSelection;
    slice?: unknown;
  } | null;
};

const listItemDndKey = new PluginKey<ListItemDndState>("qingagentListItemDnd");

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isSupportedItemParent(itemType: string, listType: string): itemType is "listItem" | "taskItem" {
  if (itemType === "listItem") return listType === "bulletList" || listType === "orderedList";
  if (itemType === "taskItem") return listType === "taskList";
  return false;
}

function isSupportedListType(type: string): type is DraggableListItem["listType"] {
  return type === "bulletList" || type === "orderedList" || type === "taskList";
}

function blockIdOf(node: PmNode): string | null {
  const blockId = node.attrs.blockId;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

interface RootListInfo {
  rootListPos: number;
  rootListNode: PmNode;
  listType: DraggableListItem["listType"];
  itemType: DraggableListItem["itemType"];
}

interface ParsedListItem {
  itemPos: number;
  itemNode: PmNode;
  itemType: DraggableListItem["itemType"];
  listPos: number;
  listNode: PmNode;
  listType: DraggableListItem["listType"];
  itemIndex: number;
  blockId: string | null;
  content: ParsedListItemContent[];
  parentList: ParsedList;
}

interface ParsedList {
  listNode: PmNode;
  listPos: number;
  items: ParsedListItem[];
  parentItem: ParsedListItem | null;
  isNew: boolean;
}

interface ParsedListTree {
  rootListPos: number;
  rootListNode: PmNode;
  listType: DraggableListItem["listType"];
  itemType: DraggableListItem["itemType"];
  rootList: ParsedList;
}

interface FlattenedListRow {
  rootListPos: number;
  depth: number;
  itemPos: number;
  blockId: string | null;
  item: ParsedListItem;
  parentList: ParsedList;
}

type ParsedListItemContent =
  | { kind: "node"; node: PmNode }
  | { kind: "list"; list: ParsedList };

function itemFromBoundary($pos: ResolvedPos): DraggableListItem | null {
  const itemNode = $pos.nodeAfter;
  const listNode = $pos.parent;
  if (!itemNode) return null;
  const itemType = itemNode.type.name;
  const listType = listNode.type.name;
  if (!isSupportedItemParent(itemType, listType) || !isSupportedListType(listType)) return null;
  if ($pos.depth < 1) return null;
  return {
    itemPos: $pos.pos,
    itemNode,
    itemType,
    listPos: $pos.before($pos.depth),
    listNode,
    listType,
    itemIndex: $pos.index(),
    blockId: blockIdOf(itemNode),
  };
}

export function findDraggableListItem($pos: ResolvedPos): DraggableListItem | null {
  const boundary = itemFromBoundary($pos);
  if (boundary) return boundary;

  for (let depth = $pos.depth; depth >= 1; depth--) {
    const itemNode = $pos.node(depth);
    const listNode = $pos.node(depth - 1);
    const itemType = itemNode.type.name;
    const listType = listNode.type.name;
    if (!isSupportedItemParent(itemType, listType) || !isSupportedListType(listType)) continue;
    return {
      itemPos: $pos.before(depth),
      itemNode,
      itemType,
      listPos: $pos.before(depth - 1),
      listNode,
      listType,
      itemIndex: $pos.index(depth - 1),
      blockId: blockIdOf(itemNode),
    };
  }
  return null;
}

export function resolveListItemAtPos(doc: PmNode, pos: number): DraggableListItem | null {
  if (pos < 0 || pos > doc.content.size) return null;
  return itemFromBoundary(doc.resolve(pos));
}

function resolveListItemAroundPos(doc: PmNode, pos: number): DraggableListItem | null {
  const bounded = clamp(pos, 0, doc.content.size);
  return resolveListItemAtPos(doc, bounded) ?? findDraggableListItem(doc.resolve(bounded));
}

export function resolveListItemByBlockId(state: EditorState, blockId: string): DraggableListItem | null {
  let found: DraggableListItem | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if ((node.type.name === "listItem" || node.type.name === "taskItem") && node.attrs.blockId === blockId) {
      found = resolveListItemAtPos(state.doc, pos);
      return false;
    }
    return true;
  });
  return found;
}

function resolveListItemAtCoords(
  state: EditorState,
  coords: { left: number; top: number },
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null,
  getRect?: (item: DraggableListItem) => RectLike | null,
): DraggableListItem | null {
  const hit = posAtCoords(coords);
  if (hit) {
    const byPos = resolveListItemAroundPos(state.doc, hit.pos);
    if (byPos) return byPos;
  }

  if (!getRect) return null;
  let best: DraggableListItem | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "listItem" && node.type.name !== "taskItem") return true;
    const item = resolveListItemAtPos(state.doc, pos);
    if (!item) return true;
    const rect = getRect(item);
    if (!rect) return true;
    const verticallyInside = coords.top >= rect.top && coords.top <= rect.bottom;
    if (!verticallyInside) return true;
    const xDistance = coords.left < rect.left ? rect.left - coords.left : coords.left > rect.right ? coords.left - rect.right : 0;
    const area = Math.max(1, rect.width * rect.height);
    const score = xDistance * 100000 + area;
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
    return true;
  });
  return best;
}

function containsPos(item: DraggableListItem, pos: number): boolean {
  return pos > item.itemPos && pos < item.itemPos + item.itemNode.nodeSize;
}

function docEndsWithSupportedList(doc: PmNode): boolean {
  const lastNode = doc.lastChild;
  return Boolean(lastNode && isSupportedListType(lastNode.type.name));
}

function rootListReachesDocEnd(doc: PmNode, root: RootListInfo): boolean {
  return root.rootListPos + root.rootListNode.nodeSize === doc.content.size;
}

function resolveRootListInfo(doc: PmNode, item: DraggableListItem): RootListInfo | null {
  const $pos = doc.resolve(item.itemPos);
  if ($pos.depth < 1) return null;
  let listDepth = $pos.depth;
  if ($pos.node(listDepth).type.name !== item.listType) return null;

  while (listDepth >= 2) {
    const parentItem = $pos.node(listDepth - 1);
    const parentList = $pos.node(listDepth - 2);
    if (!isSupportedItemParent(parentItem.type.name, parentList.type.name)) break;
    if (!isSupportedListType(parentList.type.name)) break;
    listDepth -= 2;
  }

  const rootListNode = $pos.node(listDepth);
  const listType = rootListNode.type.name;
  if (!isSupportedListType(listType)) return null;
  const itemType = listType === "taskList" ? "taskItem" : "listItem";
  return {
    rootListPos: $pos.before(listDepth),
    rootListNode,
    listType,
    itemType,
  };
}

function isSameRootListTree(source: DraggableListItem, target: DraggableListItem, doc: PmNode): boolean {
  if (source.itemType !== target.itemType || source.listType !== target.listType) return false;
  const sourceRoot = resolveRootListInfo(doc, source);
  const targetRoot = resolveRootListInfo(doc, target);
  return Boolean(
    sourceRoot &&
      targetRoot &&
      sourceRoot.rootListPos === targetRoot.rootListPos &&
      sourceRoot.listType === targetRoot.listType &&
      sourceRoot.itemType === targetRoot.itemType,
  );
}

function isSameParentList(source: DraggableListItem, target: DraggableListItem): boolean {
  return (
    source.listPos === target.listPos &&
    source.itemType === target.itemType &&
    source.listType === target.listType
  );
}

function isManagedChildList(
  node: PmNode,
  listType: DraggableListItem["listType"],
  itemType: DraggableListItem["itemType"],
): boolean {
  if (node.type.name !== listType) return false;
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index).type.name !== itemType) return false;
  }
  return true;
}

function parseList(
  listNode: PmNode,
  listPos: number,
  listType: DraggableListItem["listType"],
  itemType: DraggableListItem["itemType"],
  parentItem: ParsedListItem | null,
): ParsedList | null {
  const parsedList: ParsedList = {
    listNode,
    listPos,
    items: [],
    parentItem,
    isNew: false,
  };
  let itemPos = listPos + 1;

  for (let itemIndex = 0; itemIndex < listNode.childCount; itemIndex += 1) {
    const itemNode = listNode.child(itemIndex);
    if (itemNode.type.name !== itemType) return null;
    if (itemNode.childCount <= 0 || itemNode.child(0).type.name !== "paragraph") return null;

    const item: ParsedListItem = {
      itemPos,
      itemNode,
      itemType,
      listPos,
      listNode,
      listType,
      itemIndex,
      blockId: blockIdOf(itemNode),
      content: [],
      parentList: parsedList,
    };
    let childPos = itemPos + 1;

    for (let childIndex = 0; childIndex < itemNode.childCount; childIndex += 1) {
      const child = itemNode.child(childIndex);
      if (isManagedChildList(child, listType, itemType)) {
        const parsedChildList = parseList(
          child,
          childPos,
          listType,
          itemType,
          item,
        );
        if (!parsedChildList) return null;
        item.content.push({ kind: "list", list: parsedChildList });
      } else {
        item.content.push({ kind: "node", node: child });
      }
      childPos += child.nodeSize;
    }

    parsedList.items.push(item);
    itemPos += itemNode.nodeSize;
  }

  return parsedList;
}

function parseRootListTree(root: RootListInfo): ParsedListTree | null {
  const rootList = parseList(
    root.rootListNode,
    root.rootListPos,
    root.listType,
    root.itemType,
    null,
  );
  if (!rootList) return null;
  return {
    rootListPos: root.rootListPos,
    rootListNode: root.rootListNode,
    listType: root.listType,
    itemType: root.itemType,
    rootList,
  };
}

function flattenParsedListTree(tree: ParsedListTree): FlattenedListRow[] {
  const rows: FlattenedListRow[] = [];
  const visit = (list: ParsedList, depth: number) => {
    list.items.forEach((item) => {
      rows.push({
        rootListPos: tree.rootListPos,
        depth,
        itemPos: item.itemPos,
        blockId: item.blockId,
        item,
        parentList: list,
      });
      for (const part of item.content) {
        if (part.kind === "list") visit(part.list, depth + 1);
      }
    });
  };
  visit(tree.rootList, 1);
  return rows;
}

function parsedRowToDraggable(row: FlattenedListRow): DraggableListItem {
  return {
    itemPos: row.item.itemPos,
    itemNode: row.item.itemNode,
    itemType: row.item.itemType,
    listPos: row.item.listPos,
    listNode: row.item.listNode,
    listType: row.item.listType,
    itemIndex: row.item.itemIndex,
    blockId: row.item.blockId,
  };
}

function removeParsedItem(tree: ParsedListTree, row: FlattenedListRow): ParsedListItem | null {
  const parentList = row.item.parentList;
  const index = parentList.items.indexOf(row.item);
  if (index < 0) return null;
  const [removed] = parentList.items.splice(index, 1);
  if (parentList.items.length === 0 && parentList !== tree.rootList) {
    const parentItem = parentList.parentItem;
    if (!parentItem) return null;
    const partIndex = parentItem.content.findIndex(
      (part) => part.kind === "list" && part.list === parentList,
    );
    if (partIndex < 0) return null;
    parentItem.content.splice(partIndex, 1);
  }
  return removed ?? null;
}

function insertParsedItem(
  destination: { list: ParsedList; index: number },
  item: ParsedListItem,
): boolean {
  if (
    destination.index < 0 ||
    destination.index > destination.list.items.length
  ) {
    return false;
  }
  item.parentList = destination.list;
  destination.list.items.splice(destination.index, 0, item);
  return true;
}

function collectReservedBlockIds(doc: PmNode): Set<string> {
  const reserved = new Set<string>();
  doc.descendants((node) => {
    const blockId = blockIdOf(node);
    if (blockId) reserved.add(blockId);
    return true;
  });
  return reserved;
}

function allocateWrapperListBlockId(
  reserved: Set<string>,
  context: { listType: DraggableListItem["listType"]; parentBlockId: string | null; occurrence: number },
): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = getDeterministicId("list-dnd", { ...context, attempt });
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
  const fallback = `list-dnd-${Date.now().toString(36)}`;
  reserved.add(fallback);
  return fallback;
}

function listAttrsWithBlockId(
  attrs: PmNode["attrs"],
  reserved: Set<string>,
  context: { listType: DraggableListItem["listType"]; parentBlockId: string | null; occurrence: number },
): PmNode["attrs"] {
  const blockId = typeof attrs.blockId === "string" && attrs.blockId.length > 0 ? attrs.blockId : null;
  if (blockId) return attrs;
  return { ...attrs, blockId: allocateWrapperListBlockId(reserved, context) };
}

function buildListNode(
  listTemplateNode: PmNode,
  listType: DraggableListItem["listType"],
  itemType: DraggableListItem["itemType"],
  list: ParsedList,
  reserved: Set<string>,
  context: { parentBlockId: string | null },
): PmNode | null {
  if (list.items.length === 0) return null;
  const listNodeType = listTemplateNode.type.schema.nodes[listType];
  const itemNodeType = listTemplateNode.type.schema.nodes[itemType];
  if (!listNodeType || !itemNodeType) return null;

  let generatedChildListCount = 0;
  const buildItem = (item: ParsedListItem): PmNode | null => {
    const content: PmNode[] = [];
    for (const part of item.content) {
      if (part.kind === "node") {
        content.push(part.node);
        continue;
      }
      const childList = buildListNode(
        listTemplateNode,
        listType,
        itemType,
        part.list,
        reserved,
        { parentBlockId: item.blockId },
      );
      if (!childList) return null;
      content.push(childList);
      generatedChildListCount += 1;
    }
    if (content.length === 0 || content[0]?.type.name !== "paragraph") return null;
    return itemNodeType.createChecked(item.itemNode.attrs, Fragment.fromArray(content), item.itemNode.marks);
  };

  const itemNodes: PmNode[] = [];
  for (const item of list.items) {
    const nextItem = buildItem(item);
    if (!nextItem) return null;
    itemNodes.push(nextItem);
  }

  const attrsWithId = listAttrsWithBlockId(list.isNew ? {} : list.listNode.attrs, reserved, {
    listType,
    parentBlockId: context.parentBlockId,
    occurrence: generatedChildListCount,
  });
  return listNodeType.createChecked(
    attrsWithId,
    Fragment.fromArray(itemNodes),
    list.isNew ? [] : list.listNode.marks,
  );
}

function insertionIndexAfterRemoval(
  sourceIndex: number,
  targetIndex: number,
  placement: ListItemDropPlacement,
): number {
  let insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  if (sourceIndex < insertIndex) insertIndex -= 1;
  return insertIndex;
}

function isNoopDrop(
  source: DraggableListItem,
  target: DraggableListItem,
  placement: ListItemDropPlacement,
): boolean {
  return insertionIndexAfterRemoval(source.itemIndex, target.itemIndex, placement) === source.itemIndex;
}

function isFiniteDropCoords(coords: { left: number; top: number }): boolean {
  return Number.isFinite(coords.left) && Number.isFinite(coords.top) && coords.top >= 0;
}

function prepareListTreeMove(
  state: EditorState,
  source: DraggableListItem,
  target: DraggableListItem,
): {
  root: RootListInfo;
  tree: ParsedListTree;
  sourceRow: FlattenedListRow;
  targetRow: FlattenedListRow;
} | null {
  const sourceRoot = resolveRootListInfo(state.doc, source);
  const targetRoot = resolveRootListInfo(state.doc, target);
  if (!sourceRoot || !targetRoot) return null;
  if (
    sourceRoot.rootListPos !== targetRoot.rootListPos ||
    sourceRoot.listType !== targetRoot.listType ||
    sourceRoot.itemType !== targetRoot.itemType ||
    source.itemType !== target.itemType ||
    source.listType !== target.listType
  ) {
    return null;
  }

  const tree = parseRootListTree(sourceRoot);
  if (!tree) return null;
  const rows = flattenParsedListTree(tree);
  const sourceRow = rows.find((row) => row.itemPos === source.itemPos);
  const targetRow = rows.find((row) => row.itemPos === target.itemPos);
  if (!sourceRow || !targetRow) return null;
  return { root: sourceRoot, tree, sourceRow, targetRow };
}

function metricsFromRect(rect: RectLike): ListItemRowMetrics {
  const fallbackElement =
    typeof document !== "undefined" ? document.createElement("div") : ({} as HTMLElement);
  return {
    rowRect: rect,
    itemRect: rect,
    contentRect: rect,
    contentElement: fallbackElement,
    itemLeft: rect.left,
    markerLeft: rect.left,
    contentLeft: rect.left,
    contentRight: rect.right,
    handleLeft: rect.left,
    parentListPaddingLeft: DEFAULT_INDENT_STEP_PX,
  };
}

function getRowMetricsForItem(
  item: DraggableListItem,
  getRect: (item: DraggableListItem) => RectLike | null,
  getRowMetrics?: (item: DraggableListItem) => ListItemRowMetrics | null,
): ListItemRowMetrics | null {
  const metrics = getRowMetrics?.(item);
  if (metrics) return metrics;
  const rect = getRect(item);
  return rect ? metricsFromRect(rect) : null;
}

function estimateIndentStep(
  rows: readonly FlattenedListRow[],
  getMetrics: (item: DraggableListItem) => ListItemRowMetrics | null,
): number {
  const byItem = new Map(rows.map((row) => [row.item, row]));
  let best: number | null = null;
  for (const row of rows) {
    if (row.depth <= 1) continue;
    const parentItem = row.parentList.parentItem;
    const parent = parentItem ? byItem.get(parentItem) : null;
    if (!parent) continue;
    const rowMetrics = getMetrics(parsedRowToDraggable(row));
    const parentMetrics = getMetrics(parsedRowToDraggable(parent));
    if (!rowMetrics || !parentMetrics) continue;
    const diff = rowMetrics.itemLeft - parentMetrics.itemLeft;
    if (!Number.isFinite(diff) || diff <= 4) continue;
    best = best == null ? diff : Math.min(best, diff);
  }
  return best ?? DEFAULT_INDENT_STEP_PX;
}

function clampDepthForP1(requestedDepth: number, _sourceDepth: number, prevDepth: number | null): number | null {
  const minDepth = 1;
  const maxDepth = prevDepth == null ? 1 : prevDepth + 1;
  if (maxDepth < minDepth) return null;
  return clamp(Math.round(requestedDepth), minDepth, maxDepth);
}

function resolveRowsAfterSourceRemoval(
  tree: ParsedListTree,
  sourceRow: FlattenedListRow,
  targetRow: FlattenedListRow,
  placement: ListItemDropPlacement,
): { rowsAfterRemoval: FlattenedListRow[]; insertFlatIndex: number } | null {
  const removed = removeParsedItem(tree, sourceRow);
  if (!removed) return null;
  const rowsAfterRemoval = flattenParsedListTree(tree);
  const targetIndex = rowsAfterRemoval.findIndex((row) => row.item === targetRow.item);
  if (targetIndex < 0) return null;
  return {
    rowsAfterRemoval,
    insertFlatIndex: placement === "before" ? targetIndex : targetIndex + 1,
  };
}

interface ZonedDropTarget {
  region: ListItemDropRegion;
  targetDepth: number;
  placement: ListItemDropPlacement;
}

function placementFromY(coordsTop: number, rect: RectLike): ListItemDropPlacement {
  return coordsTop >= rect.top + rect.height / 2 ? "after" : "before";
}

function isLastZoneUsable(lastZone: ListItemDndLastZone | null | undefined, target: DraggableListItem): lastZone is ListItemDndLastZone {
  return Boolean(lastZone && lastZone.targetItemPos === target.itemPos);
}

function keepLastZone(
  lastZone: ListItemDndLastZone,
  coordsTop: number,
  rect: RectLike,
): ZonedDropTarget {
  return {
    region: lastZone.region,
    targetDepth: lastZone.targetDepth,
    placement: lastZone.region === "R1" ? placementFromY(coordsTop, rect) : "after",
  };
}

function isValidZoneForTarget(zone: ZonedDropTarget, targetDepth: number): boolean {
  if (zone.region === "R2") return zone.targetDepth === targetDepth + 1;
  if (zone.region === "R1") return zone.targetDepth === targetDepth;
  return zone.targetDepth >= 1 && zone.targetDepth < targetDepth;
}

function applyZoneHysteresis(
  raw: ZonedDropTarget,
  lastZone: ListItemDndLastZone | null | undefined,
  target: DraggableListItem,
  targetDepth: number,
  coords: { left: number; top: number },
  rect: RectLike,
  boundaries: { r1Left: number; contentLeft: number; itemLeft: number; indentStep: number },
): ZonedDropTarget {
  if (!isLastZoneUsable(lastZone, target)) return raw;
  const lastCandidate = keepLastZone(lastZone, coords.top, rect);
  if (!isValidZoneForTarget(lastCandidate, targetDepth)) return raw;
  if (raw.region === lastCandidate.region && raw.targetDepth === lastCandidate.targetDepth) return raw;

  const hyst = HYSTERESIS_STEP_RATIO * boundaries.indentStep;
  const leftSwitchHyst = Math.max(0, hyst - LEFT_BIAS_STEP_RATIO * boundaries.indentStep);
  const x = coords.left;

  if (lastCandidate.region === "R1" && raw.region === "R2" && x < boundaries.contentLeft + hyst) {
    return lastCandidate;
  }
  if (lastCandidate.region === "R2" && raw.region === "R1" && x >= boundaries.contentLeft - leftSwitchHyst) {
    return lastCandidate;
  }
  if (lastCandidate.region === "R1" && raw.region === "R3" && x > boundaries.r1Left - leftSwitchHyst) {
    return lastCandidate;
  }
  if (lastCandidate.region === "R3" && raw.region === "R1" && x <= boundaries.r1Left + hyst) {
    return lastCandidate;
  }
  if (lastCandidate.region === "R3" && raw.region === "R3") {
    const movingLeft = raw.targetDepth < lastCandidate.targetDepth;
    const boundaryDepth = Math.max(raw.targetDepth, lastCandidate.targetDepth);
    const boundary = boundaries.itemLeft - (targetDepth - boundaryDepth) * boundaries.indentStep;
    if (movingLeft && x >= boundary - leftSwitchHyst) return lastCandidate;
    if (!movingLeft && x <= boundary + hyst) return lastCandidate;
  }

  return raw;
}

function resolveRawZone(
  targetRowDepth: number,
  metrics: ListItemRowMetrics,
  indentStep: number,
  coords: { left: number; top: number },
): { zone: ZonedDropTarget; boundaries: { r1Left: number; contentLeft: number; itemLeft: number; indentStep: number } } {
  const itemLeft = Number.isFinite(metrics.itemLeft) ? metrics.itemLeft : metrics.rowRect.left;
  const contentLeft = Number.isFinite(metrics.contentLeft) ? metrics.contentLeft : metrics.rowRect.left;
  const r1Left = Math.min(itemLeft, contentLeft - MIN_MARKER_BAND_PX);
  const minX = itemLeft - Math.max(2, targetRowDepth + 2) * indentStep;
  const maxX = Math.max(metrics.contentRight, metrics.rowRect.right, contentLeft) + indentStep;
  const x = clamp(coords.left, minX, maxX);
  const boundaries = { r1Left, contentLeft, itemLeft, indentStep };

  if (x >= contentLeft) {
    return {
      zone: { region: "R2", targetDepth: targetRowDepth + 1, placement: "after" },
      boundaries,
    };
  }

  if (x >= r1Left || targetRowDepth <= 1) {
    return {
      zone: { region: "R1", targetDepth: targetRowDepth, placement: placementFromY(coords.top, metrics.rowRect) },
      boundaries,
    };
  }

  const levelsUp = Math.max(1, Math.ceil((itemLeft - x) / indentStep));
  return {
    zone: {
      region: "R3",
      targetDepth: clamp(targetRowDepth - levelsUp, 1, targetRowDepth - 1),
      placement: "after",
    },
    boundaries,
  };
}

function resolveZonedDropIntent(
  state: EditorState,
  source: DraggableListItem,
  target: DraggableListItem,
  coords: { left: number; top: number },
  getRect: (item: DraggableListItem) => RectLike | null,
  getRowMetrics?: (item: DraggableListItem) => ListItemRowMetrics | null,
  lastZone?: ListItemDndLastZone | null,
): ZonedDropTarget | null {
  const prepared = prepareListTreeMove(state, source, target);
  if (!prepared) return null;
  const rowsBeforeRemoval = flattenParsedListTree(prepared.tree);
  const getMetrics = (item: DraggableListItem) => getRowMetricsForItem(item, getRect, getRowMetrics);
  const targetMetrics = getMetrics(target);
  if (!targetMetrics || targetMetrics.rowRect.width <= 0 || targetMetrics.rowRect.height <= 0) return null;
  const indentStep = estimateIndentStep(rowsBeforeRemoval, getMetrics);
  const raw = resolveRawZone(prepared.targetRow.depth, targetMetrics, indentStep, coords);
  const zoned = applyZoneHysteresis(
    raw.zone,
    lastZone,
    target,
    prepared.targetRow.depth,
    coords,
    targetMetrics.rowRect,
    raw.boundaries,
  );
  const after = resolveRowsAfterSourceRemoval(prepared.tree, prepared.sourceRow, prepared.targetRow, zoned.placement);
  if (!after) return null;
  const prev = after.rowsAfterRemoval[after.insertFlatIndex - 1] ?? null;
  const targetDepth = clampDepthForP1(zoned.targetDepth, prepared.sourceRow.depth, prev?.depth ?? null);
  if (targetDepth == null) return null;
  return { ...zoned, targetDepth };
}

export function resolveListItemDropIntent(input: ResolveListItemDropIntentInput): ListItemDropIntent {
  const { source, state, coords, posAtCoords, getRect, getRowMetrics, lastZone } = input;
  if (!source) return { kind: "native" };
  if (!isFiniteDropCoords(coords)) return { kind: "native" };
  const target = resolveListItemAtCoords(state, coords, posAtCoords, getRect);
  if (!target) return { kind: "invalid", source };
  const metrics = getRowMetricsForItem(target, getRect, getRowMetrics);
  if (source.itemPos === target.itemPos) {
    return {
      kind: "noop",
      source,
      target,
      placement: metrics ? placementFromY(coords.top, metrics.rowRect) : "before",
      targetDepth: 1,
      region: "R1",
    };
  }
  if (containsPos(source, target.itemPos)) return { kind: "invalid", source };
  if (!isSameRootListTree(source, target, state.doc)) return { kind: "invalid", source };
  if (!metrics || metrics.rowRect.width <= 0 || metrics.rowRect.height <= 0) return { kind: "invalid", source };
  const zoned = resolveZonedDropIntent(state, source, target, coords, getRect, getRowMetrics, lastZone);
  if (!zoned) return { kind: "invalid", source };
  const sourceRoot = resolveRootListInfo(state.doc, source);
  const tree = sourceRoot ? parseRootListTree(sourceRoot) : null;
  const sourceDepth = tree
    ? flattenParsedListTree(tree).find((row) => row.itemPos === source.itemPos)?.depth
    : null;
  if (
    sourceDepth != null &&
    zoned.targetDepth === sourceDepth &&
    isSameParentList(source, target) &&
    isNoopDrop(source, target, zoned.placement)
  ) {
    return { kind: "noop", source, target, placement: zoned.placement, targetDepth: zoned.targetDepth, region: zoned.region };
  }
  return { kind: "reorder", source, target, placement: zoned.placement, targetDepth: zoned.targetDepth, region: zoned.region };
}

export function buildListItemReorderTransaction(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
  placement: ListItemDropPlacement,
  targetDepth?: number,
): Transaction | null {
  const source = resolveListItemAroundPos(state.doc, sourcePos);
  const target = resolveListItemAroundPos(state.doc, targetPos);
  if (!source || !target) return null;
  if (source.itemPos === target.itemPos || containsPos(source, target.itemPos)) {
    return null;
  }
  if (!isSameRootListTree(source, target, state.doc)) return null;

  const prepared = prepareListTreeMove(state, source, target);
  if (!prepared) return null;
  const requestedDepth = Number.isFinite(targetDepth) ? Number(targetDepth) : prepared.sourceRow.depth;
  const after = resolveRowsAfterSourceRemoval(prepared.tree, prepared.sourceRow, prepared.targetRow, placement);
  if (!after) return null;
  const prev = after.rowsAfterRemoval[after.insertFlatIndex - 1] ?? null;
  const nextDepth = clampDepthForP1(requestedDepth, prepared.sourceRow.depth, prev?.depth ?? null);
  if (nextDepth == null) return null;

  if (isSameParentList(source, target) && nextDepth === prepared.sourceRow.depth) {
    const tr = buildSameParentListItemReorderTransaction(state, source, target, placement);
    if (tr && rootListReachesDocEnd(state.doc, prepared.root)) {
      tr.setMeta(LIST_ITEM_DND_TRAILING_UNDO_META, "remember");
    }
    return tr;
  }

  const destination = resolveTreeDestination(
    prepared.tree,
    after.rowsAfterRemoval,
    after.insertFlatIndex,
    nextDepth,
    prepared.targetRow,
    placement,
  );
  if (!destination) return null;
  if (!insertParsedItem(destination, prepared.sourceRow.item)) return null;

  const reserved = collectReservedBlockIds(state.doc);
  let nextRoot: PmNode | null = null;
  try {
    nextRoot = buildListNode(
      prepared.root.rootListNode,
      prepared.root.listType,
      prepared.root.itemType,
      prepared.tree.rootList,
      reserved,
      { parentBlockId: null },
    );
  } catch {
    return null;
  }
  if (!nextRoot || nextRoot.eq(prepared.root.rootListNode)) return null;

  const tr = state.tr;
  try {
    tr.setMeta(SKIP_TRAILING_NODE_META, true);
    if (rootListReachesDocEnd(state.doc, prepared.root)) {
      tr.setMeta(LIST_ITEM_DND_TRAILING_UNDO_META, "remember");
    }
    tr.replaceWith(
      prepared.root.rootListPos,
      prepared.root.rootListPos + prepared.root.rootListNode.nodeSize,
      nextRoot,
    );
    tr.doc.check();
  } catch {
    return null;
  }
  return tr.scrollIntoView();
}

function buildSameParentListItemReorderTransaction(
  state: EditorState,
  source: DraggableListItem,
  target: DraggableListItem,
  placement: ListItemDropPlacement,
): Transaction | null {
  if (!isSameParentList(source, target)) return null;
  const listNode = state.doc.nodeAt(source.listPos);
  if (!listNode || listNode !== source.listNode || listNode.childCount <= 0) return null;

  const insertIndex = insertionIndexAfterRemoval(source.itemIndex, target.itemIndex, placement);
  if (insertIndex === source.itemIndex) return null;
  if (insertIndex < 0 || insertIndex > listNode.childCount - 1) return null;

  const items: PmNode[] = [];
  for (let i = 0; i < listNode.childCount; i++) items.push(listNode.child(i));
  const [sourceItem] = items.splice(source.itemIndex, 1);
  if (!sourceItem) return null;
  items.splice(insertIndex, 0, sourceItem);

  const tr = state.tr;
  try {
    tr.setMeta(SKIP_TRAILING_NODE_META, true);
    const nextList = listNode.type.createChecked(listNode.attrs, Fragment.fromArray(items), listNode.marks);
    tr.replaceWith(source.listPos, source.listPos + listNode.nodeSize, nextList);
    tr.doc.check();
  } catch {
    return null;
  }
  return tr.scrollIntoView();
}

function resolveTreeDestination(
  tree: ParsedListTree,
  rowsAfterRemoval: readonly FlattenedListRow[],
  insertFlatIndex: number,
  targetDepth: number,
  targetRow: FlattenedListRow,
  placement: ListItemDropPlacement,
): { list: ParsedList; index: number } | null {
  if (targetDepth < 1) return null;
  const targetList = targetRow.item.parentList;
  const targetIndex = targetList.items.indexOf(targetRow.item);
  if (targetIndex < 0) return null;
  if (targetDepth === targetRow.depth) {
    return {
      list: targetList,
      index: targetIndex + (placement === "after" ? 1 : 0),
    };
  }
  if (targetDepth === targetRow.depth + 1) {
    const childList = firstParsedChildList(targetRow.item) ??
      appendParsedChildList(tree, targetRow.item);
    return childList ? { list: childList, index: 0 } : null;
  }

  for (let index = insertFlatIndex; index < rowsAfterRemoval.length; index += 1) {
    const next = rowsAfterRemoval[index]!;
    if (next.depth < targetDepth) break;
    if (next.depth !== targetDepth) continue;
    const nextIndex = next.item.parentList.items.indexOf(next.item);
    return nextIndex < 0
      ? null
      : { list: next.item.parentList, index: nextIndex };
  }

  const prev = rowsAfterRemoval[insertFlatIndex - 1] ?? null;
  if (!prev) {
    return targetDepth === 1 ? { list: tree.rootList, index: 0 } : null;
  }
  if (targetDepth > prev.depth + 1) return null;
  if (targetDepth === prev.depth + 1) {
    const childList = firstParsedChildList(prev.item) ??
      appendParsedChildList(tree, prev.item);
    return childList ? { list: childList, index: 0 } : null;
  }

  for (let index = insertFlatIndex - 1; index >= 0; index -= 1) {
    const previous = rowsAfterRemoval[index]!;
    if (previous.depth < targetDepth) break;
    if (previous.depth !== targetDepth) continue;
    const previousIndex = previous.item.parentList.items.indexOf(previous.item);
    return previousIndex < 0
      ? null
      : { list: previous.item.parentList, index: previousIndex + 1 };
  }
  return null;
}

function firstParsedChildList(item: ParsedListItem): ParsedList | null {
  for (const part of item.content) {
    if (part.kind === "list") return part.list;
  }
  return null;
}

function appendParsedChildList(
  tree: ParsedListTree,
  parentItem: ParsedListItem,
): ParsedList {
  const list: ParsedList = {
    listNode: tree.rootList.listNode,
    listPos: -1,
    items: [],
    parentItem,
    isNew: true,
  };
  parentItem.content.push({ kind: "list", list });
  return list;
}

function listItemDropLineDecoration(meta: Extract<ListItemDndMeta, { kind: "set" }>): Decoration {
  const linePos = meta.placement === "before" ? meta.pos : meta.to;
  return Decoration.widget(
    linePos,
    () => {
      const el = document.createElement("div");
      el.className = `pm-listitem-drop-line pm-listitem-drop-line--${meta.region.toLowerCase()}`;
      el.setAttribute("data-qingagent-list-drop-target", meta.placement);
      el.style.top = `${meta.lineTopPx}px`;
      el.style.left = `${meta.lineLeftPx}px`;
      el.style.width = `${Math.max(12, meta.lineRightPx - meta.lineLeftPx)}px`;
      return el;
    },
    {
      key: `list-item-drop-line-${meta.pos}-${meta.placement}-${meta.region}-${meta.targetDepth}-${Math.round(meta.lineLeftPx)}`,
      side: meta.placement === "before" ? -1 : 1,
      ignoreSelection: true,
    },
  );
}

const LIST_ITEM_DROP_SCOPE_CLASS = "pm-listitem-drop-scope";

/**
 * 飞书式拖拽选区高亮:高亮"当前落点所属的那一层容器 listItem",暗示用户正在哪一层做排序/嵌入。
 * 容器层级 = targetDepth-1(R2 嵌入下级→容器是 target 自己;R1 同级→target 的父项;R3 升级→更上层祖先)。
 * 容器层级 < 1(落点在根级列表/最外层文档区)时返回 null——不出选区高亮。
 */
function resolveDropScopeRange(
  doc: PmNode,
  target: DraggableListItem,
  targetDepth: number,
): { from: number; to: number } | null {
  const containerListDepth = targetDepth - 1;
  if (containerListDepth < 1) return null;
  const $pos = doc.resolve(Math.min(target.itemPos + 1, doc.content.size));
  const ancestors: Array<{ pos: number; size: number }> = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      ancestors.push({ pos: $pos.before(depth), size: node.nodeSize });
    }
  }
  // ancestors 按列表深度升序:index 0 = 列表深度 1 ... 末项 = target 自身(列表深度 D)。
  const container = ancestors[containerListDepth - 1];
  if (!container) return null;
  return { from: container.pos, to: container.pos + container.size };
}

function listItemDropScopeDecoration(meta: Extract<ListItemDndMeta, { kind: "set" }>): Decoration | null {
  if (meta.scopeFrom == null || meta.scopeTo == null || meta.scopeTo <= meta.scopeFrom) return null;
  return Decoration.node(meta.scopeFrom, meta.scopeTo, { class: LIST_ITEM_DROP_SCOPE_CLASS });
}

function isListDomElement(el: Element | null): el is HTMLUListElement | HTMLOListElement {
  const tag = el?.tagName.toLowerCase();
  return tag === "ul" || tag === "ol";
}

function px(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parentListPaddingLeft(itemDom: HTMLElement): number {
  const parent = itemDom.parentElement;
  if (!isListDomElement(parent)) return 0;
  return Math.max(0, px(getComputedStyle(parent).paddingLeft));
}

function firstListItemContentElement(itemDom: HTMLElement, itemType: DraggableListItem["itemType"]): HTMLElement {
  const directChildren = Array.from(itemDom.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  if (itemType === "taskItem") {
    const body = directChildren.find((child) => child.tagName.toLowerCase() !== "label" && !isListDomElement(child));
    if (!body) return itemDom;
    return (
      Array.from(body.children).find((child): child is HTMLElement => child instanceof HTMLElement && !isListDomElement(child)) ??
      body
    );
  }
  return directChildren.find((child) => !isListDomElement(child)) ?? itemDom;
}

function rectFromDomRect(rect: DOMRect | RectLike): RectLike {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function getListItemRowMetrics(
  itemDom: HTMLElement,
  itemType: DraggableListItem["itemType"],
): ListItemRowMetrics {
  const itemRect = rectFromDomRect(itemDom.getBoundingClientRect());
  const contentElement = firstListItemContentElement(itemDom, itemType);
  const contentRect = rectFromDomRect(contentElement.getBoundingClientRect());
  const parentPadding = parentListPaddingLeft(itemDom);
  const contentLeft = Number.isFinite(contentRect.left) ? contentRect.left : itemRect.left;
  const contentRight = Number.isFinite(contentRect.right) && contentRect.right > contentLeft ? contentRect.right : itemRect.right;
  const markerLeft =
    itemType === "taskItem"
      ? itemRect.left
      : Math.min(itemRect.left, contentLeft - parentPadding);
  const handleLeft =
    itemType === "taskItem"
      ? contentLeft - Math.max(0, contentLeft - itemRect.left)
      : contentLeft - parentPadding;
  const rowTop = Number.isFinite(contentRect.top) ? contentRect.top : itemRect.top;
  const rowBottom =
    Number.isFinite(contentRect.bottom) && contentRect.bottom > rowTop
      ? contentRect.bottom
      : itemRect.bottom;
  const rowRect = {
    left: itemRect.left,
    right: itemRect.right,
    top: rowTop,
    bottom: rowBottom,
    width: itemRect.width,
    height: Math.max(0, rowBottom - rowTop),
  };
  return {
    rowRect,
    itemRect,
    contentRect,
    contentElement,
    itemLeft: Number.isFinite(markerLeft) ? markerLeft : itemRect.left,
    markerLeft,
    contentLeft,
    contentRight,
    handleLeft: Number.isFinite(handleLeft) ? handleLeft : itemRect.left,
    parentListPaddingLeft: parentPadding,
  };
}

export function getListItemRowRect(
  itemDom: HTMLElement,
  itemType: DraggableListItem["itemType"],
): RectLike {
  const metrics = getListItemRowMetrics(itemDom, itemType);
  return {
    left: metrics.rowRect.left,
    right: metrics.rowRect.right,
    top: metrics.rowRect.top,
    bottom: metrics.rowRect.bottom,
    width: metrics.rowRect.width,
    height: metrics.rowRect.height,
  };
}

function getRectForViewItem(view: EditorView, item: DraggableListItem): RectLike | null {
  const dom = view.nodeDOM(item.itemPos);
  if (!(dom instanceof HTMLElement)) return null;
  return getListItemRowRect(dom, item.itemType);
}

function getMetricsForViewItem(view: EditorView, item: DraggableListItem): ListItemRowMetrics | null {
  const dom = view.nodeDOM(item.itemPos);
  if (!(dom instanceof HTMLElement)) return null;
  return getListItemRowMetrics(dom, item.itemType);
}

function eventCoords(event: DragEvent): { left: number; top: number } {
  return { left: event.clientX, top: event.clientY };
}

function resolveActiveListItemSource(view: EditorView): DraggableListItem | null {
  const dragging = (view as DraggingView).dragging;
  if (!dragging?.slice) return null;
  const selection = view.state.selection instanceof NodeSelection ? view.state.selection : dragging.node;
  if (!(selection instanceof NodeSelection)) return null;
  return resolveListItemAtPos(view.state.doc, selection.from);
}

function resolveIntentFromEvent(view: EditorView, event: DragEvent): ListItemDropIntent {
  const source = resolveActiveListItemSource(view);
  const pluginState = listItemDndKey.getState(view.state);
  return resolveListItemDropIntent({
    state: view.state,
    source,
    coords: eventCoords(event),
    posAtCoords: (coords) => view.posAtCoords(coords),
    getRect: (item) => getRectForViewItem(view, item),
    getRowMetrics: (item) => getMetricsForViewItem(view, item),
    lastZone: pluginState?.lastZone ?? null,
  });
}

function resolveDropLineBounds(
  view: EditorView,
  intent: Extract<ListItemDropIntent, { kind: "reorder" }>,
): { lineTopPx: number; lineLeftPx: number; lineRightPx: number } | null {
  const metrics = getMetricsForViewItem(view, intent.target);
  if (!metrics) return null;
  const prepared = prepareListTreeMove(view.state, intent.source, intent.target);
  if (!prepared) return null;
  const rows = flattenParsedListTree(prepared.tree);
  const indentStep = estimateIndentStep(rows, (item) => getMetricsForViewItem(view, item));
  const rawLeft = metrics.itemLeft + (intent.targetDepth - prepared.targetRow.depth) * indentStep;
  const lineRight = Math.max(metrics.contentRight, metrics.rowRect.right, metrics.itemRect.right);
  const editorRect = view.dom.getBoundingClientRect();
  const lineLeft = clamp(rawLeft, editorRect.left, Math.max(editorRect.left, lineRight - 12));
  return {
    lineTopPx: intent.placement === "before" ? metrics.rowRect.top : metrics.rowRect.bottom,
    lineLeftPx: lineLeft,
    lineRightPx: Math.max(lineLeft + 12, lineRight),
  };
}

function setListItemDndActive(view: EditorView) {
  view.dom.classList.add(LIST_ITEM_DND_ACTIVE_CLASS);
  if (typeof document !== "undefined") {
    document.body.classList.add(LIST_ITEM_DND_ACTIVE_SCOPE_CLASS);
  }
}

function clearListItemDndActive(view: EditorView) {
  view.dom.classList.remove(LIST_ITEM_DND_ACTIVE_CLASS);
  if (typeof document !== "undefined") {
    document.body.classList.remove(LIST_ITEM_DND_ACTIVE_SCOPE_CLASS);
  }
}

function setListItemDropTarget(view: EditorView, intent: Extract<ListItemDropIntent, { kind: "reorder" }>) {
  const line = resolveDropLineBounds(view, intent);
  if (!line) {
    clearListItemDropTarget(view, { keepActive: true });
    return;
  }
  setListItemDndActive(view);
  const current = listItemDndKey.getState(view.state)?.target;
  if (
    current?.pos === intent.target.itemPos &&
    current.placement === intent.placement &&
    current.region === intent.region &&
    current.targetDepth === intent.targetDepth
  ) {
    return;
  }
  const scope = resolveDropScopeRange(view.state.doc, intent.target, intent.targetDepth);
  view.dispatch(
    view.state.tr.setMeta(listItemDndKey, {
      kind: "set",
      pos: intent.target.itemPos,
      to: intent.target.itemPos + intent.target.itemNode.nodeSize,
      placement: intent.placement,
      region: intent.region,
      targetDepth: intent.targetDepth,
      scopeFrom: scope?.from ?? null,
      scopeTo: scope?.to ?? null,
      ...line,
    } satisfies ListItemDndMeta),
  );
}

function clearListItemDropTarget(view: EditorView, options: { keepActive?: boolean } = {}) {
  if (!options.keepActive) clearListItemDndActive(view);
  const state = listItemDndKey.getState(view.state);
  if (!state?.target && !state?.lastZone) return;
  view.dispatch(view.state.tr.setMeta(listItemDndKey, { kind: "clear" } satisfies ListItemDndMeta));
}

function applyListItemDrop(
  view: EditorView,
  source: DraggableListItem,
  target: DraggableListItem,
  placement: ListItemDropPlacement,
  targetDepth: number,
): boolean {
  const tr = buildListItemReorderTransaction(view.state, source.itemPos, target.itemPos, placement, targetDepth);
  if (!tr) return false;
  clearListItemDndActive(view);
  tr.setMeta(listItemDndKey, { kind: "clear" } satisfies ListItemDndMeta);
  view.dispatch(tr);
  return true;
}

export function createListItemDndPlugin(): Plugin {
  return new Plugin<ListItemDndState>({
    key: listItemDndKey,
    state: {
      init: () => ({ decorations: DecorationSet.empty, target: null, lastZone: null, suppressTrailingAfterUndo: false }),
      apply(tr, value) {
        const meta = tr.getMeta(listItemDndKey) as ListItemDndMeta | undefined;
        const trailingMeta = tr.getMeta(LIST_ITEM_DND_TRAILING_UNDO_META) as "remember" | "consume" | undefined;
        const suppressTrailingAfterUndo =
          trailingMeta === "remember"
            ? true
            : trailingMeta === "consume"
              ? false
              : value.suppressTrailingAfterUndo;
        if (meta?.kind === "set") {
          const lastZone = { region: meta.region, targetDepth: meta.targetDepth, targetItemPos: meta.pos };
          const decos: Decoration[] = [listItemDropLineDecoration(meta)];
          const scopeDeco = listItemDropScopeDecoration(meta);
          if (scopeDeco) decos.push(scopeDeco);
          return {
            decorations: DecorationSet.create(tr.doc, decos),
            target: { pos: meta.pos, placement: meta.placement, region: meta.region, targetDepth: meta.targetDepth },
            lastZone,
            suppressTrailingAfterUndo,
          };
        }
        if (meta?.kind === "clear") {
          return { decorations: DecorationSet.empty, target: null, lastZone: null, suppressTrailingAfterUndo };
        }
        return {
          decorations: value.decorations.map(tr.mapping, tr.doc),
          target: value.target
            ? {
                pos: tr.mapping.map(value.target.pos, -1),
                placement: value.target.placement,
                region: value.target.region,
                targetDepth: value.target.targetDepth,
              }
            : null,
          lastZone: value.lastZone
            ? { ...value.lastZone, targetItemPos: tr.mapping.map(value.lastZone.targetItemPos, -1) }
            : null,
          suppressTrailingAfterUndo,
        };
      },
    },
    appendTransaction(transactions, oldState, newState) {
      const oldPluginState = listItemDndKey.getState(oldState);
      if (!oldPluginState?.suppressTrailingAfterUndo) return null;
      if (!transactions.some((tr) => tr.docChanged)) return null;
      if (transactions.some((tr) => tr.getMeta(LIST_ITEM_DND_TRAILING_UNDO_META) === "consume")) return null;
      const tr = newState.tr
        .setMeta(SKIP_TRAILING_NODE_META, true)
        .setMeta(LIST_ITEM_DND_TRAILING_UNDO_META, "consume");
      if (!docEndsWithSupportedList(newState.doc)) return tr;
      return tr;
    },
    view(view) {
      return {
        destroy() {
          clearListItemDndActive(view);
        },
      };
    },
    props: {
      decorations(state) {
        return listItemDndKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      handleDOMEvents: {
        dragover(view, event) {
          const source = resolveActiveListItemSource(view);
          if (!source) return false;
          setListItemDndActive(view);
          const intent = resolveIntentFromEvent(view, event);
          if (intent.kind === "native") {
            clearListItemDropTarget(view);
            return false;
          }
          event.preventDefault();
          if (intent.kind === "reorder") {
            setListItemDropTarget(view, intent);
          } else {
            clearListItemDropTarget(view, { keepActive: true });
          }
          return true;
        },
        dragleave(view, event) {
          // 真机 HTML5 拖拽中,鼠标在文字/marker/padding 等子元素边界间移动(尤其往左移做 R3 升级)
          // 会频繁触发 dragleave,且 Chrome 此时 relatedTarget 常为 null。旧逻辑"relatedTarget 非
          // view.dom 内即清线"会把这种子边界抖动误判为离开编辑器→落点线一移就消失、R3 根本走不了。
          // 改用坐标判定:只有指针真的落到编辑器矩形外(留一点容差)才清线;子边界抖动交给下一个
          // dragover 刷新,彻底离开由 dragend/drop 兜底清理。
          const drag = event as DragEvent;
          const relatedTarget = drag.relatedTarget;
          if (relatedTarget instanceof Node && view.dom.contains(relatedTarget)) return false;
          const rect = view.dom.getBoundingClientRect();
          const x = drag.clientX;
          const y = drag.clientY;
          const hasCoords = Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0);
          if (hasCoords) {
            const margin = 4;
            const inside =
              x >= rect.left - margin &&
              x <= rect.right + margin &&
              y >= rect.top - margin &&
              y <= rect.bottom + margin;
            if (inside) return false; // 指针仍在编辑器内,只是跨了子元素边界,不清线
          }
          clearListItemDropTarget(view);
          return false;
        },
        dragend(view) {
          clearListItemDropTarget(view);
          return false;
        },
        drop(view) {
          clearListItemDropTarget(view);
          return false;
        },
      },
      handleDrop(view, event) {
        const source = resolveActiveListItemSource(view);
        if (!source) {
          clearListItemDropTarget(view);
          return false;
        }
        const intent = resolveIntentFromEvent(view, event);
        if (intent.kind === "native") {
          clearListItemDropTarget(view);
          return false;
        }
        event.preventDefault();
        if (intent.kind === "reorder") {
          if (!applyListItemDrop(view, intent.source, intent.target, intent.placement, intent.targetDepth)) {
            clearListItemDropTarget(view);
          }
          return true;
        }
        clearListItemDropTarget(view);
        return true;
      },
    },
  });
}

export const ListItemDnDExtension = Extension.create({
  name: "qingagentListItemDnd",
  priority: 250,
  addProseMirrorPlugins() {
    return [createListItemDndPlugin()];
  },
});
