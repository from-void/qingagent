import type { Editor } from "@tiptap/core";
import { CellSelection, setCellAttr } from "@tiptap/pm/tables";

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
