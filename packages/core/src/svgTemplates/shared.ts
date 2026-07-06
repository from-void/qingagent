import { estimateTextWidth } from "../browser/svgQualityLint.js";

export const accentSchemaValues = ["warm", "cool", "mono"] as const;
export type Accent = typeof accentSchemaValues[number];

export interface Palette {
  paper: string;
  panel: string;
  panelAlt: string;
  accent: string;
  accentSoft: string;
  line: string;
  text: string;
  muted: string;
}

export const PALETTES: Record<Accent, Palette> = {
  warm: {
    paper: "#f7f1e6",
    panel: "#fffaf0",
    panelAlt: "#f2e4c4",
    accent: "#9f6a24",
    accentSoft: "#e4c47c",
    line: "#d0ad65",
    text: "#2b2b2b",
    muted: "#4d463c",
  },
  cool: {
    paper: "#edf3f0",
    panel: "#ffffff",
    panelAlt: "#d8e8e3",
    accent: "#2f6f73",
    accentSoft: "#9fc7c2",
    line: "#78a8a3",
    text: "#2b2b2b",
    muted: "#3f4a49",
  },
  mono: {
    paper: "#f2eee6",
    panel: "#ffffff",
    panelAlt: "#ded9cf",
    accent: "#3f3f3f",
    accentSoft: "#bcb6aa",
    line: "#9b9489",
    text: "#2b2b2b",
    muted: "#484848",
  },
};

export function paletteFor(accent: Accent | undefined): Palette {
  return PALETTES[accent ?? "warm"];
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function truncateByWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = estimateTextWidth(ellipsis, fontSize);
  let out = "";
  for (const ch of text) {
    if (estimateTextWidth(out + ch, fontSize) + ellipsisWidth > maxWidth) break;
    out += ch;
  }
  return out.length > 0 ? `${out}${ellipsis}` : ellipsis;
}

export function wrapText(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const ch of text) {
    if (estimateTextWidth(current + ch, fontSize) <= maxWidth) {
      current += ch;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = ch;
    } else {
      lines.push(ch);
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current.length > 0) lines.push(current);

  if (lines.length > maxLines) lines.length = maxLines;
  if (estimateTextWidth(lines.at(-1) ?? "", fontSize) > maxWidth) {
    lines[lines.length - 1] = truncateByWidth(lines.at(-1) ?? "", maxWidth, fontSize);
  }
  if (text.length > lines.join("").length && lines.length > 0) {
    lines[lines.length - 1] = truncateByWidth(lines.at(-1) ?? "", maxWidth, fontSize);
  }
  return lines.length > 0 ? lines : [""];
}

export function svgText(text: string, x: number, y: number, fontSize: number, fill: string, attrs = ""): string {
  const attrText = attrs ? ` ${attrs}` : "";
  return `<text x="${Math.round(x)}" y="${Math.round(y)}" font-size="${fontSize}" fill="${fill}" font-family="sans-serif"${attrText}>${escapeXmlText(text)}</text>`;
}

export function safeTitle(title: string | undefined, maxWidth: number): string {
  return truncateByWidth(title?.trim() ?? "", maxWidth, 28);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${Number(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Number(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}
