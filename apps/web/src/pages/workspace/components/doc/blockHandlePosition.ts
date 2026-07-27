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

/**
 * 异步命令恢复时按稳定 blockId 重新定位。若 ID 重复则无法唯一确认用户原先操作的块，
 * 必须安全放弃，不能猜一个位置继续删除。
 */
export function resolveHandleRangeByStableId(
  doc: ProseMirrorNode,
  handle: HandleState,
): { from: number; to: number } | null {
  if (!handle.blockId) return null;
  let match: { from: number; to: number } | null = null;
  let ambiguous = false;
  doc.descendants((node, pos) => {
    if (
      node.type.name !== handle.nodeType ||
      node.attrs.blockId !== handle.blockId
    ) {
      return true;
    }
    if (match) {
      ambiguous = true;
      return true;
    }
    match = { from: pos, to: pos + node.nodeSize };
    return true;
  });
  return ambiguous ? null : match;
}
