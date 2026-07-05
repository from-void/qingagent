export interface FloatingAnchorRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

export interface FloatingPosition {
  top: number;
  left: number;
  /** 浮层最终落在锚点的上方还是下方——供调用方翻转 caret 朝向(下方弹出时 caret 应朝上指向锚点)。 */
  placement: "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

export function resolveCenteredFloatingPosition(
  anchor: FloatingAnchorRect,
  size: FloatingSize,
  viewport: FloatingViewport,
  options: { margin?: number; gap?: number } = {},
): FloatingPosition {
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 10;
  const height = Math.max(1, size.height);
  const width = Math.max(1, size.width);

  // 默认放锚点上方;上方空间不够则翻到下方。placement 记录最终朝向供 caret 翻转。
  let top = anchor.top - height - gap;
  let placement: "above" | "below" = "above";
  if (top < margin) {
    top = anchor.bottom + gap;
    placement = "below";
  }
  top = clamp(top, margin, viewport.height - height - margin);

  const half = width / 2;
  const left = clamp(
    anchor.left + anchor.width / 2,
    half + margin,
    viewport.width - half - margin,
  );

  return { top, left, placement };
}

export function resolveAnchoredBubblePosition(
  anchor: FloatingAnchorRect,
  size: FloatingSize,
  viewport: FloatingViewport,
  options: { margin?: number; gap?: number } = {},
): FloatingPosition {
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 8;
  const height = Math.max(1, size.height);
  const width = Math.max(1, size.width);

  // 默认放锚点下方;下方空间不够则翻到上方。placement 记录最终朝向供 caret 翻转。
  let top = anchor.bottom + gap;
  let placement: "above" | "below" = "below";
  if (top + height + margin > viewport.height) {
    top = anchor.top - height - gap;
    placement = "above";
  }
  top = clamp(top, margin, viewport.height - height - margin);

  const left = clamp(anchor.left, margin, viewport.width - width - margin);
  return { top, left, placement };
}

export function shouldFlipDropdownUp(
  triggerBottom: number,
  menuHeight: number,
  viewportHeight: number,
  gap = 6,
): boolean {
  return triggerBottom + menuHeight + gap > viewportHeight;
}
