export const GRAPH_LAYOUT_NODE_WIDTH = 160;
export const GRAPH_LAYOUT_NODE_HEIGHT = 72;
export const GRAPH_LAYOUT_NODE_MIN_WIDTH = 96;
export const GRAPH_LAYOUT_NODE_MIN_HEIGHT = 48;
export const GRAPH_LAYOUT_NODE_MAX_WIDTH = 640;
export const GRAPH_LAYOUT_NODE_MAX_HEIGHT = 480;

export function clampNodeWidth(width: number): number {
  return Math.max(GRAPH_LAYOUT_NODE_MIN_WIDTH, Math.min(GRAPH_LAYOUT_NODE_MAX_WIDTH, Math.round(width)));
}

export function clampNodeHeight(height: number): number {
  return Math.max(GRAPH_LAYOUT_NODE_MIN_HEIGHT, Math.min(GRAPH_LAYOUT_NODE_MAX_HEIGHT, Math.round(height)));
}

export function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function sanitizeColor(value: string | undefined): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{3,8}$/.test(value)
    || /^rgba?\([0-9.%+,\s-]+\)$/.test(value)
    ? value
    : null;
}

export function sanitizeDashArray(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\,/g, ",").trim();
  return /^(?:\d+(?:\.\d+)?(?:px)?)(?:[\s,]+(?:\d+(?:\.\d+)?(?:px)?))*$/.test(normalized) ? normalized : null;
}

export function sanitizeCurve(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^(?:basis|bumpX|bumpY|cardinal|catmullRom|linear|monotoneX|monotoneY|natural|step|stepAfter|stepBefore)$/.test(normalized)
    ? normalized
    : null;
}
