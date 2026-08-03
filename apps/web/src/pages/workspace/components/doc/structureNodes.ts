import type { Editor } from "@tiptap/react";
import { Slice } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export function createDefaultColumnListNode(): Record<string, unknown> {
  return {
    type: "columnList",
    content: [
      { type: "column", attrs: { widthRatio: 0.5 }, content: [{ type: "paragraph" }] },
      { type: "column", attrs: { widthRatio: 0.5 }, content: [{ type: "paragraph" }] },
    ],
  };
}

export function createDefaultTableNode(rows = 3, cols = 3, withHeaderRow = false): Record<string, unknown> {
  const safeRows = Math.min(10, Math.max(1, Math.floor(rows)));
  const safeCols = Math.min(10, Math.max(1, Math.floor(cols)));
  return {
    type: "table",
    content: Array.from({ length: safeRows }, (_, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: safeCols }, () => ({
        type: withHeaderRow && rowIndex === 0 ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph" }],
      })),
    })),
  };
}

export function insertStructureNodeAfterBlock(
  editor: Pick<Editor, "state" | "chain" | "view">,
  blockPos: number,
  node: Record<string, unknown>,
): boolean {
  const current = editor.state.doc.nodeAt(blockPos);
  if (!current) return false;
  const after = blockPos + current.nodeSize;
  const chain = editor.chain().focus().insertContentAt(after, node);
  if (node.type === "columnList") {
    // columnList(+1) → 第一栏 column(+1) → 首个文本块(+1)，插入后即可直接输入。
    const inserted = chain.setTextSelection(after + 3).run();
    if (inserted) editor.view.focus();
    return inserted;
  }
  return chain.run();
}

/**
 * 从正文工具栏插入结构块：折叠光标只提供“当前顶层块”这个锚点，不允许拆开该块。
 * 空文本块由新结构块原位替换；其余顶层块一律在块后插入。范围选区沿用既有替换语义。
 */
export function insertStructureNodeAtSelection(
  editor: Pick<Editor, "state" | "chain" | "view">,
  node: Record<string, unknown>,
): boolean {
  const { selection } = editor.state;
  let target: number | { from: number; to: number } | null = null;

  if (selection instanceof TextSelection && selection.empty && selection.$from.depth >= 1) {
    const blockPos = selection.$from.before(1);
    const block = editor.state.doc.nodeAt(blockPos);
    if (block) {
      target = block.isTextblock && block.content.size === 0
        ? { from: blockPos, to: blockPos + block.nodeSize }
        : blockPos + block.nodeSize;
    }
  }

  if (target === null) {
    return editor.chain().insertContent(node).run();
  }

  const insertionPos = typeof target === "number" ? target : target.from;
  const chain = editor.chain().insertContentAt(target, node);
  if (node.type === "columnList") {
    // columnList(+1) → 第一栏 column(+1) → 首个文本块(+1)。
    const inserted = chain.setTextSelection(insertionPos + 3).run();
    if (inserted) editor.view.focus();
    return inserted;
  }
  return chain.run();
}

export function createBlockDragPayload(
  view: EditorView,
  blockPos: number,
): {
  selection: NodeSelection;
  dragging: { slice: Slice; move: true; node: NodeSelection };
} {
  const selection = NodeSelection.create(view.state.doc, blockPos);
  const slice = selection.content();
  return {
    selection,
    dragging: { slice, move: true, node: selection },
  };
}
