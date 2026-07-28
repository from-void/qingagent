import { DOMParser, type Element as XmlElement, type Node as XmlNode } from "@xmldom/xmldom";

export interface SvgLintIssue {
  rule: "text-overflow" | "text-overlap" | "low-contrast";
  detail: string;
}

interface TextBox {
  el: XmlElement;
  ownerText: XmlElement;
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fontSize: number;
}

interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_BACKGROUND = "#efe7d6";
// SVG 模板使用的 CJK 字体中，下列东亚字符通常占一个完整 em。除汉字外必须覆盖
// 日文假名、Hangul 与全角形式，否则临界标签会被按 0.6em 低估而侵入相邻图形。
const EAST_ASIAN_FULLWIDTH_RE =
  /[\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u;

function elementName(el: XmlElement): string {
  return (el.localName || el.tagName || "").toLowerCase();
}

function elementChildren(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes.item(i);
    if (child?.nodeType === 1) out.push(child as XmlElement);
  }
  return out;
}

function collectElements(root: XmlElement, names: Set<string>): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (el: XmlElement) => {
    if (el !== root && elementName(el) === "defs") return;
    if (names.has(elementName(el))) out.push(el);
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);
  return out;
}

function styleValue(el: XmlElement, prop: string): string | null {
  const style = el.getAttribute("style");
  if (!style) return null;
  for (const part of style.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    if (key === prop) return part.slice(idx + 1).trim();
  }
  return null;
}

function presentationValue(el: XmlElement, prop: string): string | null {
  return styleValue(el, prop) ?? el.getAttribute(prop);
}

function inheritedValue(el: XmlElement, prop: string): string | null {
  let cur: XmlNode | null = el;
  while (cur?.nodeType === 1) {
    const value = presentationValue(cur as XmlElement, prop);
    if (value) return value;
    cur = cur.parentNode;
  }
  return null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const match = /-?(?:\d+\.?\d*|\.\d+)/.exec(value);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function parseOpacity(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, trimmed.endsWith("%") ? parsed / 100 : parsed));
}

function firstNumberAttr(el: XmlElement, attrName: string): number | null {
  return parseNumber(el.getAttribute(attrName));
}

function inheritedNumber(el: XmlElement, prop: string, fallback: number | null = null): number | null {
  const value = inheritedValue(el, prop);
  return parseNumber(value) ?? fallback;
}

function nearestTextAncestor(el: XmlElement): XmlElement | null {
  let cur: XmlNode | null = el;
  while (cur?.nodeType === 1) {
    const curEl = cur as XmlElement;
    if (elementName(curEl) === "text") return curEl;
    cur = cur.parentNode;
  }
  return null;
}

function hasTransformInChain(el: XmlElement): boolean {
  let cur: XmlNode | null = el;
  while (cur?.nodeType === 1) {
    const curEl = cur as XmlElement;
    if (curEl.getAttribute("transform")) return true;
    if (elementName(curEl) === "svg") break;
    cur = cur.parentNode;
  }
  return false;
}

function previewText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 20);
}

export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += EAST_ASIAN_FULLWIDTH_RE.test(ch) ? fontSize : fontSize * 0.6;
  }
  return width;
}

function textPosition(el: XmlElement): { x: number; y: number } | null {
  const owner = nearestTextAncestor(el);
  const x = firstNumberAttr(el, "x") ?? (owner && owner !== el ? firstNumberAttr(owner, "x") : null);
  const y = firstNumberAttr(el, "y") ?? (owner && owner !== el ? firstNumberAttr(owner, "y") : null);
  if (x === null || y === null) return null;
  return { x, y };
}

function textBox(el: XmlElement): TextBox | null {
  if (hasTransformInChain(el)) return null;
  const text = el.textContent?.trim() ?? "";
  if (!text) return null;
  const pos = textPosition(el);
  if (!pos) return null;

  const fontSize = inheritedNumber(el, "font-size", DEFAULT_FONT_SIZE) ?? DEFAULT_FONT_SIZE;
  const width = estimateTextWidth(text, fontSize);
  const anchor = (inheritedValue(el, "text-anchor") ?? "start").trim().toLowerCase();
  const x0 = anchor === "middle" ? pos.x - width / 2 : anchor === "end" ? pos.x - width : pos.x;
  const ownerText = nearestTextAncestor(el) ?? el;

  return {
    el,
    ownerText,
    text,
    x0,
    x1: x0 + width,
    y0: pos.y - fontSize,
    y1: pos.y + fontSize * 0.4,
    fontSize,
  };
}

function collectTextBoxes(root: XmlElement): TextBox[] {
  const texts = collectElements(root, new Set(["text"]));
  const boxes: TextBox[] = [];
  for (const textEl of texts) {
    const tspans = collectElements(textEl, new Set(["tspan"]));
    if (tspans.length > 0) {
      for (const tspan of tspans) {
        const box = textBox(tspan);
        if (box) boxes.push(box);
      }
    } else {
      const box = textBox(textEl);
      if (box) boxes.push(box);
    }
  }
  return boxes;
}

function parseHexColor(value: string | null): [number, number, number] | null {
  const color = value?.trim();
  if (!color) return null;
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  if (short?.[1]) {
    return [...short[1]].map((ch) => Number.parseInt(ch + ch, 16)) as [number, number, number];
  }
  const long = /^#([0-9a-f]{6})$/i.exec(color);
  if (!long?.[1]) return null;
  return [
    Number.parseInt(long[1].slice(0, 2), 16),
    Number.parseInt(long[1].slice(2, 4), 16),
    Number.parseInt(long[1].slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const convert = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

function collectPaintOrder(root: XmlElement): XmlElement[] {
  const elements: XmlElement[] = [];
  const visit = (el: XmlElement) => {
    if (el !== root && elementName(el) === "defs") return;
    elements.push(el);
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);
  return elements;
}

function rectBounds(el: XmlElement): Bounds | null {
  if (hasTransformInChain(el)) return null;
  const x = firstNumberAttr(el, "x") ?? 0;
  const y = firstNumberAttr(el, "y") ?? 0;
  const width = firstNumberAttr(el, "width");
  const height = firstNumberAttr(el, "height");
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { x0: x, x1: x + width, y0: y, y1: y + height };
}

function elementBounds(el: XmlElement): Bounds | null {
  const name = elementName(el);
  if (name === "rect") return rectBounds(el);
  if (hasTransformInChain(el)) return null;
  if (name === "circle") {
    const cx = firstNumberAttr(el, "cx") ?? 0;
    const cy = firstNumberAttr(el, "cy") ?? 0;
    const r = firstNumberAttr(el, "r");
    return r !== null && r > 0
      ? { x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r }
      : null;
  }
  if (name === "ellipse") {
    const cx = firstNumberAttr(el, "cx") ?? 0;
    const cy = firstNumberAttr(el, "cy") ?? 0;
    const rx = firstNumberAttr(el, "rx");
    const ry = firstNumberAttr(el, "ry");
    return rx !== null && ry !== null && rx > 0 && ry > 0
      ? { x0: cx - rx, x1: cx + rx, y0: cy - ry, y1: cy + ry }
      : null;
  }
  if (name === "line") {
    const x1 = firstNumberAttr(el, "x1") ?? 0;
    const y1 = firstNumberAttr(el, "y1") ?? 0;
    const x2 = firstNumberAttr(el, "x2") ?? 0;
    const y2 = firstNumberAttr(el, "y2") ?? 0;
    const halfStroke = Math.max(0.5, inheritedNumber(el, "stroke-width", 1) ?? 1) / 2;
    return {
      x0: Math.min(x1, x2) - halfStroke,
      x1: Math.max(x1, x2) + halfStroke,
      y0: Math.min(y1, y2) - halfStroke,
      y1: Math.max(y1, y2) + halfStroke,
    };
  }
  if (name === "polyline" || name === "polygon") {
    const values = ((el.getAttribute("points") ?? "").match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? [])
      .map(Number)
      .filter(Number.isFinite);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + 1 < values.length; i += 2) {
      xs.push(values[i]!);
      ys.push(values[i + 1]!);
    }
    if (xs.length === 0) return null;
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  return null;
}

function contains(outer: Bounds, inner: Bounds): boolean {
  return outer.x0 <= inner.x0 && outer.x1 >= inner.x1 && outer.y0 <= inner.y0 && outer.y1 >= inner.y1;
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function isFullyOpaque(el: XmlElement): boolean {
  let cur: XmlNode | null = el;
  while (cur?.nodeType === 1) {
    const curEl = cur as XmlElement;
    const display = presentationValue(curEl, "display")?.trim().toLowerCase();
    const visibility = presentationValue(curEl, "visibility")?.trim().toLowerCase();
    const opacity = parseOpacity(presentationValue(curEl, "opacity"), 1);
    if (display === "none" || visibility === "hidden" || visibility === "collapse" || opacity < 1) {
      return false;
    }
    cur = cur.parentNode;
  }
  return parseOpacity(inheritedValue(el, "fill-opacity"), 1) >= 1;
}

function solidOpaqueFill(el: XmlElement): string | null {
  if (!isFullyOpaque(el)) return null;
  const fill = inheritedValue(el, "fill") ?? "#000000";
  return parseHexColor(fill) ? fill : null;
}

function localBackgroundFill(
  elements: readonly XmlElement[],
  elementIndexes: ReadonlyMap<XmlElement, number>,
  box: TextBox,
): string | null {
  const textIndex = elementIndexes.get(box.ownerText) ?? -1;
  if (textIndex < 0) return null;

  let candidateIndex = -1;
  let candidateFill = DEFAULT_BACKGROUND;
  for (let i = 0; i < textIndex; i++) {
    const el = elements[i]!;
    if (elementName(el) !== "rect") continue;
    const bounds = rectBounds(el);
    const fill = solidOpaqueFill(el);
    if (bounds && fill && contains(bounds, box)) {
      candidateIndex = i;
      candidateFill = fill;
    }
  }

  const paintedShapes = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
  for (let i = candidateIndex + 1; i < textIndex; i++) {
    const el = elements[i]!;
    if (!paintedShapes.has(elementName(el))) continue;
    const bounds = elementBounds(el);
    // path、transform 或畸形几何无法可靠定位；保守跳过这段文字的对比度判定。
    if (!bounds || intersects(bounds, box)) return null;
  }

  return candidateFill;
}

function overlapRatio(a: TextBox, b: TextBox): number {
  const x = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const y = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = x * y;
  if (area <= 0) return 0;
  const areaA = Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const areaB = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  const smaller = Math.min(areaA, areaB);
  return smaller > 0 ? area / smaller : 0;
}

export function lintSvg(svg: string, opts: { width: number; height: number }): SvgLintIssue[] {
  try {
    let parseFailed = false;
    const doc = new DOMParser({
      onError: (level) => {
        if (level !== "warning") parseFailed = true;
      },
    }).parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement as XmlElement | null;
    if (parseFailed || !root || elementName(root) !== "svg" || doc.getElementsByTagName("parsererror").length > 0) {
      return [];
    }

    const issues: SvgLintIssue[] = [];
    const boxes = collectTextBoxes(root);
    const paintOrder = collectPaintOrder(root);
    const paintIndexes = new Map(
      paintOrder.map((element, index) => [element, index] as const),
    );

    for (const box of boxes) {
      if (box.x0 < -8 || box.x1 > opts.width + 8) {
        issues.push({
          rule: "text-overflow",
          detail: `文本"${previewText(box.text)}" 横向溢出画布或容器，x=${Math.round(box.x0)}，估宽=${Math.round(box.x1 - box.x0)}。`,
        });
      }
    }

    if (boxes.length <= 200) {
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        if (!a) continue;
        for (let j = i + 1; j < boxes.length; j++) {
          const b = boxes[j];
          if (!b || a.ownerText === b.ownerText) continue;
          if (overlapRatio(a, b) > 0.3) {
            issues.push({
              rule: "text-overlap",
              detail: `文本"${previewText(a.text)}" 与"${previewText(b.text)}" 的估算包围盒重叠。`,
            });
          }
        }
      }
    }

    for (const box of boxes) {
      const fill = parseHexColor(inheritedValue(box.el, "fill"));
      const bg = parseHexColor(
        localBackgroundFill(paintOrder, paintIndexes, box),
      );
      if (!fill || !bg) continue;
      const ratio = contrastRatio(fill, bg);
      if (ratio < 2.5) {
        issues.push({
          rule: "low-contrast",
          detail: `文本"${previewText(box.text)}" 与背景对比度过低(${ratio.toFixed(2)}:1)。`,
        });
      }
    }

    return issues;
  } catch {
    return [];
  }
}
