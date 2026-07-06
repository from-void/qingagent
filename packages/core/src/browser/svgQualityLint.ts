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

const DEFAULT_FONT_SIZE = 16;
const DEFAULT_BACKGROUND = "#efe7d6";
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

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
    width += CJK_RE.test(ch) ? fontSize : fontSize * 0.6;
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

function backgroundFill(root: XmlElement, width: number, height: number): string {
  const rects = collectElements(root, new Set(["rect"]));
  for (const rect of rects) {
    const x = firstNumberAttr(rect, "x") ?? 0;
    const y = firstNumberAttr(rect, "y") ?? 0;
    const w = firstNumberAttr(rect, "width");
    const h = firstNumberAttr(rect, "height");
    if (Math.abs(x) <= 1 && Math.abs(y) <= 1 && w !== null && h !== null && w >= width * 0.9 && h >= height * 0.9) {
      return presentationValue(rect, "fill") ?? DEFAULT_BACKGROUND;
    }
  }
  return DEFAULT_BACKGROUND;
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

    const bg = parseHexColor(backgroundFill(root, opts.width, opts.height)) ?? parseHexColor(DEFAULT_BACKGROUND);
    if (bg) {
      for (const box of boxes) {
        const fill = parseHexColor(inheritedValue(box.el, "fill"));
        if (!fill) continue;
        const ratio = contrastRatio(fill, bg);
        if (ratio < 2.5) {
          issues.push({
            rule: "low-contrast",
            detail: `文本"${previewText(box.text)}" 与背景对比度过低(${ratio.toFixed(2)}:1)。`,
          });
        }
      }
    }

    return issues;
  } catch {
    return [];
  }
}
