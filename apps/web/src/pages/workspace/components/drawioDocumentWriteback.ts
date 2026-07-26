import type { Editor } from "@tiptap/react";
import type { DrawioEditorResult } from "./drawioEmbedProtocol";

const DIAGRAM_VISUAL_WRITE_META = "qingagent:diagram-visual-write";

export function createDrawioBlockId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `drawio-${random}`;
}

/** 用创建时固定的 blockId 找回节点，避免编辑期间光标移动后把实时结果写到别处。 */
export function writeDrawioResultByBlockId(
  editor: Pick<Editor, "state" | "view">,
  blockId: string,
  result: DrawioEditorResult,
): boolean {
  let targetPos: number | null = null;
  let targetAttrs: Record<string, unknown> | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "diagram" || node.attrs.blockId !== blockId) return true;
    targetPos = pos;
    targetAttrs = node.attrs;
    return false;
  });
  if (targetPos === null || targetAttrs === null) return false;
  const current = targetAttrs as Record<string, unknown>;
  if (current.source === result.source && current.svg === result.svg) return true;
  const tr = editor.state.tr.setNodeMarkup(targetPos, undefined, {
    ...current,
    source: result.source,
    svg: result.svg,
  });
  tr.setMeta(DIAGRAM_VISUAL_WRITE_META, true);
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}
