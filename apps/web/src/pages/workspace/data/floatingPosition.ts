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

export interface SideFloatingPosition {
  top: number;
  left: number;
  placement: "left" | "right";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

export function resolveCenteredFloatingPosition(
  anchor: FloatingAnchorRect,
  size: FloatingSize,
  viewport: FloatingViewport,
  options: { margin?: number; gap?: number; horizontalBounds?: { left: number; right: number } } = {},
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
  const horizontalLeft = options.horizontalBounds
    ? Math.max(margin, options.horizontalBounds.left + margin)
    : margin;
  const horizontalRight = options.horizontalBounds
    ? Math.min(viewport.width - margin, options.horizontalBounds.right - margin)
    : viewport.width - margin;
  const left = clamp(
    anchor.left + anchor.width / 2,
    horizontalLeft + half,
    horizontalRight - half,
  );

  return { top, left, placement };
}

export function intersectFloatingAnchor(
  anchor: FloatingAnchorRect,
  bounds: { top: number; right: number; bottom: number; left: number },
): FloatingAnchorRect {
  const anchorRight = anchor.left + anchor.width;
  const left = Math.max(anchor.left, bounds.left);
  const right = Math.min(anchorRight, bounds.right);
  const top = Math.max(anchor.top, bounds.top);
  const bottom = Math.min(anchor.bottom, bounds.bottom);
  const fallbackX = clamp(anchor.left + anchor.width / 2, bounds.left, bounds.right);
  const fallbackY = clamp((anchor.top + anchor.bottom) / 2, bounds.top, bounds.bottom);
  return {
    left: right >= left ? left : fallbackX,
    width: right >= left ? right - left : 0,
    top: bottom >= top ? top : fallbackY,
    bottom: bottom >= top ? bottom : fallbackY,
  };
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

export function resolveSideFloatingPosition(
  anchor: FloatingAnchorRect,
  size: FloatingSize,
  viewport: FloatingViewport,
  options: { margin?: number; gap?: number } = {},
): SideFloatingPosition {
  const margin = options.margin ?? 8;
  const gap = options.gap ?? 6;
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const right = anchor.left + anchor.width + gap;
  const fitsRight = right + width + margin <= viewport.width;
  const leftCandidate = anchor.left - width - gap;
  const placement = fitsRight || leftCandidate < margin ? "right" : "left";
  const left = placement === "right" ? right : leftCandidate;
  const top = clamp(anchor.top, margin, viewport.height - height - margin);
  return {
    top: Math.round(top),
    left: Math.round(clamp(left, margin, viewport.width - width - margin)),
    placement,
  };
}

export function shouldFlipDropdownUp(
  triggerBottom: number,
  menuHeight: number,
  viewportHeight: number,
  gap = 6,
): boolean {
  return triggerBottom + menuHeight + gap > viewportHeight;
}
