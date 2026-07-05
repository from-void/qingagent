import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

let generatedHeadingIdSeq = 0;
function generateHeadingBlockId(): string {
  const rand =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${++generatedHeadingIdSeq}`;
  return `block-heading-${rand}`;
}

/**
 * 已折叠标题末尾回车:在折叠区之后插入一个同级标题新行,且原标题保持折叠不展开。
 * 默认回车会在标题紧后(折叠区内、被隐藏处)拆出新块,体验错乱;这里拦截该特例。
 * 返回 true 表示已处理(阻止默认),false 走默认。
 */
function handleCollapsedHeadingEnter(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const $from = selection.$from;
  const heading = $from.parent;
  if (heading.type.name !== "heading") return false;
  if ($from.parentOffset !== heading.content.size) return false; // 必须在标题末尾
  const depth = $from.depth;
  const headingPos = $from.before(depth);
  const parent = $from.node(depth - 1);
  if (!canFoldHeadingWithin(parent)) return false;
  const index = $from.index(depth - 1);
  const level = headingLevel(heading);
  const blockId = blockIdOf(heading);
  if (!blockId) return false;
  const collapsed = qingagentCollapseKey.getState(state)?.collapsed;
  if (!collapsed || !collapsed.has(blockId)) return false;
  if (!hasHeadingFoldBody(parent, index, level)) return false;

  const headingEnd = headingPos + heading.nodeSize;
  const ranges = headingFoldRanges(parent, index, headingEnd, level);
  const insertPos = ranges.length > 0 ? ranges[ranges.length - 1]!.to : headingEnd;

  const headingType = state.schema.nodes.heading;
  if (!headingType) return false;
  const newHeading = headingType.create({ level, blockId: generateHeadingBlockId() });
  const tr = state.tr.insert(insertPos, newHeading);
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1)).scrollIntoView();
  editor.view.dispatch(tr);
  return true;
}

interface BlockCollapseOptions {
  docId?: string | null;
  forceExpanded?: boolean;
}

interface BlockCollapseState {
  collapsed: ReadonlySet<string>;
  decorations: DecorationSet;
  docId: string | null;
  forceExpanded: boolean;
}

export type BlockCollapseMeta =
  | { kind: "toggle"; blockId: string }
  | { kind: "collapse"; blockId: string }
  | { kind: "expand"; blockId: string }
  | { kind: "setDocId"; docId: string | null }
  | { kind: "setForceExpanded"; forceExpanded: boolean };

export interface BlockCollapseInfo {
  canToggle: boolean;
  blockId: string;
  collapsed: boolean;
  kind: "heading" | "listItem";
}

const STORAGE_PREFIX = "qingagent:block-collapse:";
const SKIP_TRAILING_NODE_META = "skipTrailingNode";

export const qingagentCollapseKey = new PluginKey<BlockCollapseState>("qingagentBlockCollapse");

export const BlockCollapseExtension = Extension.create<BlockCollapseOptions>({
  name: "qingagentBlockCollapse",
  priority: 1000, // 让折叠相关 keymap(Enter)先于默认拆块处理运行

  addOptions() {
    return {
      docId: null,
      forceExpanded: false,
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => (this.editor ? handleCollapsedHeadingEnter(this.editor) : false),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockCollapseState>({
        key: qingagentCollapseKey,
        state: {
          init: (_, state) => {
            const docId = normalizeDocId(this.options.docId ?? null);
            const collapsed = readCollapsedSet(docId);
            const forceExpanded = Boolean(this.options.forceExpanded);
            return {
              collapsed,
              decorations: forceExpanded ? DecorationSet.empty : buildCollapseDecorations(state.doc, collapsed),
              docId,
              forceExpanded,
            };
          },
          apply: (tr, value) => {
            const meta = tr.getMeta(qingagentCollapseKey) as BlockCollapseMeta | undefined;
            let collapsed = value.collapsed;
            let docId = value.docId;
            let forceExpanded = value.forceExpanded;
            let collapsedChanged = false;
            let forceChanged = false;

            if (meta?.kind === "setDocId") {
              const nextDocId = normalizeDocId(meta.docId);
              if (nextDocId !== docId) {
                docId = nextDocId;
                collapsed = readCollapsedSet(docId);
                collapsedChanged = true;
              }
            } else if (meta?.kind === "setForceExpanded") {
              const nextForceExpanded = Boolean(meta.forceExpanded);
              if (nextForceExpanded !== forceExpanded) {
                forceExpanded = nextForceExpanded;
                forceChanged = true;
              }
            } else if (meta?.kind === "toggle" || meta?.kind === "collapse" || meta?.kind === "expand") {
              const next = new Set(collapsed);
              const has = next.has(meta.blockId);
              if (meta.kind === "toggle") {
                if (has) next.delete(meta.blockId);
                else next.add(meta.blockId);
              } else if (meta.kind === "collapse") {
                next.add(meta.blockId);
              } else {
                next.delete(meta.blockId);
              }
              if (!setsEqual(collapsed, next)) {
                collapsed = next;
                collapsedChanged = true;
                persistCollapsedSet(docId, collapsed);
              }
            }

            if (forceExpanded) {
              return {
                collapsed,
                decorations: DecorationSet.empty,
                docId,
                forceExpanded,
              };
            }

            if (collapsedChanged || forceChanged || tr.docChanged) {
              return {
                collapsed,
                decorations: buildCollapseDecorations(tr.doc, collapsed),
                docId,
                forceExpanded,
              };
            }

            return {
              collapsed,
              decorations: value.decorations.map(tr.mapping, tr.doc),
              docId,
              forceExpanded,
            };
          },
        },
        props: {
          decorations(state) {
            return qingagentCollapseKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function getCollapsedBlockIds(state: EditorState): ReadonlySet<string> {
  return qingagentCollapseKey.getState(state)?.collapsed ?? new Set<string>();
}

export function getBlockCollapseInfo(state: EditorState, pos: number): BlockCollapseInfo | null {
  const located = locateNodeAtPos(state.doc, pos);
  if (!located) return null;
  const { node, parent, index } = located;
  const blockId = blockIdOf(node);
  if (!blockId) return null;

  if (node.type.name === "listItem") {
    const parentType = parent?.type.name ?? "";
    if (!isSupportedPlainList(parentType)) return null;
    if (!hasManagedChildList(node, parentType, "listItem")) return null;
    return {
      canToggle: true,
      blockId,
      collapsed: getCollapsedBlockIds(state).has(blockId),
      kind: "listItem",
    };
  }

  if (node.type.name === "taskItem") return null;

  if (node.type.name === "heading") {
    const level = headingLevel(node);
    if (!parent || !canFoldHeadingWithin(parent) || !hasHeadingFoldBody(parent, index, level)) return null;
    return {
      canToggle: true,
      blockId,
      collapsed: getCollapsedBlockIds(state).has(blockId),
      kind: "heading",
    };
  }

  return null;
}

export function toggleBlockCollapse(editor: Editor, blockId: string): void {
  dispatchCollapseMeta(editor, { kind: "toggle", blockId });
}

export function expandBlockCollapse(editor: Editor, blockId: string): void {
  dispatchCollapseMeta(editor, { kind: "expand", blockId });
}

export function createExpandBlockCollapseMeta(blockId: string): BlockCollapseMeta {
  return { kind: "expand", blockId };
}

export function setBlockCollapseDocId(editor: Editor, docId: string | null): void {
  dispatchCollapseMeta(editor, { kind: "setDocId", docId });
}

export function setBlockCollapseForceExpanded(editor: Editor, forceExpanded: boolean): void {
  dispatchCollapseMeta(editor, { kind: "setForceExpanded", forceExpanded });
}

function dispatchCollapseMeta(editor: Editor, meta: BlockCollapseMeta): void {
  if (editor.isDestroyed) return;
  const tr = editor.state.tr
    .setMeta(qingagentCollapseKey, meta)
    .setMeta(SKIP_TRAILING_NODE_META, true)
    .setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  // 折叠/展开是纯装饰事务(docChanged=false),不触发重排。被折叠区里若含表格
  // (.tableWrapper overflow + 列宽手柄,易被浏览器提升为独立合成层),display:none 后
  // 没有重绘信号,Chromium 会把旧合成层留在原处=残影,要等滚动 repaint 才清(回归
  // fold-heading-table-ghost)。折叠态变化后做一次极轻量重绘 nudge 强制丢弃旧合成层:
  // 同一帧内临时 translateZ(0) 再恢复 + 读 offsetHeight 强制 reflow。常驻三角悬浮层是
  // body 级 fixed、不在 editor.view.dom 子树,不受此 transform 影响。
  if (meta.kind === "toggle" || meta.kind === "expand" || meta.kind === "setForceExpanded") {
    const dom = editor.view.dom as HTMLElement;
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      const prev = dom.style.transform;
      dom.style.transform = "translateZ(0)";
      void dom.offsetHeight;
      dom.style.transform = prev;
    });
  }
}

function buildCollapseDecorations(doc: PmNode, collapsed: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos, parent, index) => {
    const blockId = blockIdOf(node);
    if (!blockId || !collapsed.has(blockId)) return true;

    if (node.type.name === "listItem") {
      const parentType = parent?.type.name ?? "";
      if (!isSupportedPlainList(parentType)) return true;
      const childRanges = managedChildListRanges(node, parentType, "listItem");
      if (childRanges.length === 0) return true;
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-folded-head" }));
      for (const range of childRanges) {
        decorations.push(Decoration.node(pos + range.from, pos + range.to, { class: "is-folded-hidden" }));
      }
      return false;
    }

    if (node.type.name === "heading" && parent && canFoldHeadingWithin(parent)) {
      const ranges = headingFoldRanges(parent, index, pos + node.nodeSize, headingLevel(node));
      if (ranges.length === 0) return true;
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-folded-head" }));
      for (const range of ranges) {
        decorations.push(Decoration.node(range.from, range.to, { class: "is-folded-hidden" }));
      }
    }

    return true;
  });

  return DecorationSet.create(doc, decorations);
}

function locateNodeAtPos(doc: PmNode, pos: number): { node: PmNode; parent: PmNode | null; index: number } | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const $pos = doc.resolve(pos);
  return { node, parent: $pos.parent, index: $pos.index() };
}

function blockIdOf(node: PmNode): string | null {
  const blockId = node.attrs.blockId;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

function headingLevel(node: PmNode): number {
  const level = Number(node.attrs.level);
  return Number.isFinite(level) ? level : 1;
}

function canFoldHeadingWithin(parent: PmNode): boolean {
  return parent.type.name === "doc" || parent.type.name === "column";
}

function hasHeadingFoldBody(parent: PmNode, headingIndex: number, level: number): boolean {
  // 紧邻下一个兄弟若已是同级/更高级标题(或本就没有后续块),说明该标题节下为空,无可折叠 body;
  // 否则(任意正文/列表/更深标题)都算作该标题的可折叠区间(范围由 headingFoldRanges 收集到下个 level<=n 标题前)。
  const next = headingIndex + 1 < parent.childCount ? parent.child(headingIndex + 1) : null;
  if (!next) return false;
  if (next.type.name === "heading" && headingLevel(next) <= level) return false;
  return true;
}

function headingFoldRanges(
  parent: PmNode,
  headingIndex: number,
  firstSiblingPos: number,
  level: number,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let pos = firstSiblingPos;
  for (let i = headingIndex + 1; i < parent.childCount; i += 1) {
    const sibling = parent.child(i);
    if (sibling.type.name === "heading" && headingLevel(sibling) <= level) break;
    ranges.push({ from: pos, to: pos + sibling.nodeSize });
    pos += sibling.nodeSize;
  }
  return ranges;
}

function isSupportedPlainList(type: string): type is "bulletList" | "orderedList" {
  return type === "bulletList" || type === "orderedList";
}

function hasManagedChildList(node: PmNode, listType: string, itemType: "listItem"): boolean {
  return managedChildListRanges(node, listType, itemType).length > 0;
}

function managedChildListRanges(
  node: PmNode,
  listType: string,
  itemType: "listItem",
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let offset = 1;
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (isManagedChildList(child, listType, itemType)) {
      ranges.push({ from: offset, to: offset + child.nodeSize });
    }
    offset += child.nodeSize;
  }
  return ranges;
}

function isManagedChildList(node: PmNode, listType: string, itemType: "listItem"): boolean {
  if (node.type.name !== listType) return false;
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index).type.name !== itemType) return false;
  }
  return true;
}

function normalizeDocId(docId: string | null | undefined): string | null {
  const value = typeof docId === "string" ? docId.trim() : "";
  return value ? value : null;
}

function storageKey(docId: string | null): string | null {
  return docId ? `${STORAGE_PREFIX}${docId}` : null;
}

function readCollapsedSet(docId: string | null): ReadonlySet<string> {
  const key = storageKey(docId);
  if (!key || typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0));
  } catch {
    return new Set();
  }
}

function persistCollapsedSet(docId: string | null, collapsed: ReadonlySet<string>): void {
  const key = storageKey(docId);
  if (!key || typeof localStorage === "undefined") return;
  try {
    const values = [...collapsed].sort();
    if (values.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* localStorage 失败只影响软持久化,不影响编辑器视图态。 */
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}
