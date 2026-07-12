import { z } from "zod";
import type { SvgTemplate } from "./types.js";
import { accentSchemaValues, paletteFor, safeTitle, svgText, truncateByWidth, type Accent } from "./shared.js";

const sideSchema = z.object({
  title: z.string().min(1).max(12),
  items: z.array(z.string().min(1).max(30)).min(1).max(6),
});

export const compareCardParamsSchema = z.object({
  title: z.string().max(24).optional(),
  left: sideSchema,
  right: sideSchema,
  accent: z.enum(accentSchemaValues).optional(),
});

type CompareCardParams = z.infer<typeof compareCardParamsSchema>;

function renderSide(params: CompareCardParams["left"], opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  palette: ReturnType<typeof paletteFor>;
  side: "left" | "right";
}): string {
  const titleFont = 21;
  const itemFont = params.items.length >= 6 ? 15 : 16;
  const itemGap = Math.max(32, Math.min(42, (opts.height - 92) / Math.max(1, params.items.length)));
  const textX = opts.x + 42;
  const maxTextWidth = opts.width - 66;
  const title = truncateByWidth(params.title, opts.width - 44, titleFont);
  const headerFill = opts.side === "left" ? opts.palette.accentSoft : opts.palette.panelAlt;
  const body: string[] = [
    `<rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="${opts.height}" fill="${opts.palette.panel}" stroke="${opts.palette.line}" stroke-width="2"/>`,
    `<rect x="${opts.x}" y="${opts.y}" width="${opts.width}" height="58" fill="${headerFill}"/>`,
    svgText(title, opts.x + 22, opts.y + 37, titleFont, opts.palette.text, `font-weight="700"`),
  ];

  params.items.forEach((item, index) => {
    const y = opts.y + 90 + index * itemGap;
    const text = truncateByWidth(item, maxTextWidth, itemFont);
    body.push(`<circle cx="${opts.x + 22}" cy="${y - 5}" r="5" fill="${opts.palette.accent}"/>`);
    body.push(svgText(text, textX, y, itemFont, opts.palette.text));
  });

  return body.join("");
}

export const compareCardTemplate: SvgTemplate<CompareCardParams> = {
  id: "compare-card",
  label: "双栏对比卡，用于左右两组要点的稳定对比展示",
  paramsSchema: compareCardParamsSchema,
  render(params, opts) {
    const palette = paletteFor(params.accent as Accent | undefined);
    const margin = 44;
    const title = safeTitle(params.title, opts.width - margin * 2);
    const titleY = params.title ? 58 : 52;
    const top = params.title ? 90 : 62;
    const gap = 28;
    const colWidth = Math.floor((opts.width - margin * 2 - gap) / 2);
    const panelHeight = Math.max(240, opts.height - top - margin);
    const rightX = margin + colWidth + gap;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}">`,
      `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${palette.paper}"/>`,
      svgText(title, margin, titleY, 28, palette.text, `font-weight="700"`),
      renderSide(params.left, { x: margin, y: top, width: colWidth, height: panelHeight, palette, side: "left" }),
      renderSide(params.right, { x: rightX, y: top, width: colWidth, height: panelHeight, palette, side: "right" }),
      `<line x1="${opts.width / 2}" y1="${top + 18}" x2="${opts.width / 2}" y2="${top + panelHeight - 18}" stroke="${palette.line}" stroke-width="2"/>`,
      `</svg>`,
    ].join("");
  },
};
