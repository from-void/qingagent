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
 * 把手柄的「块内位置」归一成真正的行内位置（父节点 inlineContent 的位置）。
 *
 * 转换/插入命令（setNode / wrapIn / setTextSelection）只在行内位置上成立，而 HandleState
 * 的 insertPos 有两条路径会给出块边界：
 * 1. posAtCoords 命中左侧 gutter / NodeView chrome 时返回块之前的位置（空文档里把手柄
 *    悬在留白上就是这种）；
 * 2. 矩形兜底与末尾留白路径统一用 `blockPos + 1`，对 callout/引用/表格这类容器块只是
 *    容器内边界，不是行内位置。
 * 这两种位置直接喂给命令会让整条 chain 返回 false，用户只看到一句「无法执行」。
 *
 * 返回 null = 该块（分隔线/图片/图表等叶子块）压根没有可落光标的正文，转换本就不成立。
 */
export function resolveInlineInsertPos(
  doc: ProseMirrorNode,
  blockPos: number,
  requestedPos: number,
): number | null {
  const $requested = resolveDocumentPositionSafely(doc, requestedPos);
  if ($requested?.parent.inlineContent) return requestedPos;

  let block: ProseMirrorNode | null;
  try {
    block = doc.nodeAt(blockPos);
  } catch {
    return null;
  }
  if (!block) return null;
  if (block.isTextblock) return blockPos + 1;

  let inlinePos: number | null = null;
  block.descendants((child, offset) => {
    if (inlinePos !== null) return false;
    if (child.isTextblock) {
      // offset 是相对块内容起点的偏移；+1 进入该 textblock 的行内位置。
      inlinePos = blockPos + 1 + offset + 1;
      return false;
    }
    return true;
  });
  return inlinePos !== null && resolveDocumentPositionSafely(doc, inlinePos)?.parent.inlineContent
    ? inlinePos
    : null;
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
