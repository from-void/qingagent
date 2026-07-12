import type { Editor } from "@tiptap/react";
import { Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
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
  editor: Pick<Editor, "state" | "chain">,
  blockPos: number,
  node: Record<string, unknown>,
): boolean {
  const current = editor.state.doc.nodeAt(blockPos);
  if (!current) return false;
  const after = blockPos + current.nodeSize;
  return editor.chain().focus().insertContentAt(after, node).run();
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
