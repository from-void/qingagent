import type {
  Node as ProseMirrorNode,
  ResolvedPos,
} from "@tiptap/pm/model";
import type { HandleState } from "./blockHandleGeometry";

export function resolveDocumentPositionSafely(
  doc: ProseMirrorNode,
  position: number,
): ResolvedPos | null {
  if (
    !Number.isInteger(position) ||
    position < 0 ||
    position > doc.content.size
  ) {
    return null;
  }
  try {
    return doc.resolve(position);
  } catch {
    return null;
  }
}

/**
 * React 手柄状态可能落后于 ProseMirror transaction。命令执行和 render 投影前必须同时
 * 核对范围、节点类型和 blockId；任何一项不再匹配就放弃旧手柄，等待下一次命中重算。
 */
export function getCurrentHandleNode(
  doc: ProseMirrorNode,
  handle: HandleState,
): ProseMirrorNode | null {
  if (
    !resolveDocumentPositionSafely(doc, handle.blockPos) ||
    !resolveDocumentPositionSafely(doc, handle.insertPos) ||
    handle.blockPos >= doc.content.size
  ) {
    return null;
  }

  let node: ProseMirrorNode | null;
  try {
    node = doc.nodeAt(handle.blockPos);
  } catch {
    return null;
  }
  if (!node || node.type.name !== handle.nodeType) return null;

  if (
    handle.blockId &&
    node.attrs.blockId !== handle.blockId
  ) {
    return null;
  }
  return node;
}
