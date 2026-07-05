// 0603 — 拟人鼠标 overlay 的纯几何计算(可单测,把"坐标对齐/越界"从纯视觉降维成可断言数值)。

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CursorAnchor {
  /** 视口内的目标屏幕坐标(锚在目标元素左上/起始处) */
  x: number;
  y: number;
  /** 是否在滚动视口可视范围内 */
  visible: boolean;
  /** 越界方向:在视口上方 / 下方 / 未越界 */
  edge: "none" | "top" | "bottom";
}

/**
 * 锚点:目标元素 rect 相对滚动视口 rect。元素纵向在视口内→visible;在上方→edge=top、
 * 在下方→edge=bottom(用于边缘气泡)。锚 y 取元素顶(起始处),x 取元素左侧偏内一点。
 */
export function computeCursorAnchor(target: RectLike, viewport: RectLike): CursorAnchor {
  const x = target.left + Math.min(8, target.width / 2);
  const y = target.top;
  const vTop = viewport.top;
  const vBottom = viewport.top + viewport.height;
  if (y < vTop) return { x, y: vTop, visible: false, edge: "top" };
  if (y > vBottom) return { x, y: vBottom, visible: false, edge: "bottom" };
  return { x, y, visible: true, edge: "none" };
}

/**
 * 平滑趋近:当前值朝目标移动 follow 比例(每帧调用 → 指数平滑跟随)。
 * follow=1 直达,0 不动;越界自动夹到 [0,1]。用于鼠标按 lane 平滑"滑向"当前编辑处。
 */
export function approach(current: number, target: number, follow: number): number {
  const f = Math.min(1, Math.max(0, follow));
  return current + (target - current) * f;
}

/**
 * 边缘气泡横坐标:多个同方向越界鼠标沿边缘居中并排。
 */
export function edgeBubbleX(index: number, total: number, viewport: RectLike, gap = 30): number {
  const safeTotal = Math.max(1, total);
  const totalW = safeTotal * gap;
  const start = viewport.left + viewport.width / 2 - totalW / 2 + gap / 2;
  return start + index * gap;
}
