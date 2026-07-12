export const TABLE_COLUMN_HEADER_SIZE = 8;
export const TABLE_ROW_HEADER_SIZE = 8;
export const TABLE_INSERT_DOT_SIZE = 16;
export const TABLE_INSERT_DOT_HOVER_SIZE = 18;
export const TABLE_INSERT_DOT_GAP = 5;

export interface TableChromeRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * chrome 左/上边界同时容纳头条、圆点间隙和完整圆点；右/下边界仍由 wrapper 决定，
 * 保持宽表横滚时只展示 wrapper 可视区域的裁剪语义。
 */
export function resolveTableChromeViewport(
  tableRect: Pick<DOMRect, "top" | "left">,
  wrapperRect: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
  workspaceRect: Pick<DOMRect, "top" | "right" | "bottom" | "left">,
): TableChromeRect {
  const dotRadius = TABLE_INSERT_DOT_HOVER_SIZE / 2;
  const visibleTop = Math.max(wrapperRect.top, workspaceRect.top);
  const visibleLeft = Math.max(wrapperRect.left, workspaceRect.left);
  const visibleRight = Math.min(wrapperRect.right, workspaceRect.right);
  const visibleBottom = Math.min(wrapperRect.bottom, workspaceRect.bottom);
  const tableTopEdgeVisible = tableRect.top >= visibleTop && tableRect.top <= visibleBottom;
  const tableLeftEdgeVisible = tableRect.left >= visibleLeft && tableRect.left <= visibleRight;
  const top = Math.max(
    workspaceRect.top,
    tableTopEdgeVisible
      ? Math.min(visibleTop, tableRect.top - TABLE_COLUMN_HEADER_SIZE - TABLE_INSERT_DOT_GAP - dotRadius)
      : visibleTop,
  );
  const left = Math.max(
    workspaceRect.left,
    tableLeftEdgeVisible
      ? Math.min(visibleLeft, tableRect.left - TABLE_ROW_HEADER_SIZE - TABLE_INSERT_DOT_GAP - dotRadius)
      : visibleLeft,
  );
  return {
    top,
    left,
    width: Math.max(0, visibleRight - left),
    height: Math.max(0, visibleBottom - top),
  };
}
