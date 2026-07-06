import { z } from "zod";
import type { SvgTemplate } from "./types.js";
import { accentSchemaValues, paletteFor, safeTitle, svgText, truncateByWidth, type Accent } from "./shared.js";

export const pointsCardParamsSchema = z.object({
  title: z.string().max(24).optional(),
  points: z.array(z.object({
    label: z.string().min(1).max(10),
    desc: z.string().max(40).optional(),
  })).min(1).max(6),
  accent: z.enum(accentSchemaValues).optional(),
});

type PointsCardParams = z.infer<typeof pointsCardParamsSchema>;

export const pointsCardTemplate: SvgTemplate<PointsCardParams> = {
  id: "points-card",
  label: "要点卡，用于 1-6 条核心观点的稳定排版",
  paramsSchema: pointsCardParamsSchema,
  render(params, opts) {
    const palette = paletteFor(params.accent as Accent | undefined);
    const margin = 44;
    const title = safeTitle(params.title, opts.width - margin * 2);
    const top = params.title ? 90 : 56;
    const availableHeight = opts.height - top - margin;
    const rowGap = Math.max(52, availableHeight / params.points.length);
    const labelX = margin + 66;
    const maxLabelWidth = opts.width - labelX - margin;
    const maxDescWidth = opts.width - labelX - margin - 10;
    const body: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}">`,
      `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${palette.paper}"/>`,
      svgText(title, margin, params.title ? 58 : 50, 28, palette.text, `font-weight="700"`),
      `<rect x="${margin}" y="${top - 18}" width="${opts.width - margin * 2}" height="${availableHeight + 22}" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>`,
    ];

    params.points.forEach((point, index) => {
      const rowTop = top + index * rowGap;
      const yLabel = rowTop + 22;
      const yDesc = rowTop + 50;
      const marker = String(index + 1).padStart(2, "0");
      body.push(`<rect x="${margin + 22}" y="${rowTop + 4}" width="28" height="28" fill="${palette.accentSoft}"/>`);
      body.push(svgText(marker, margin + 36, rowTop + 25, 13, palette.text, `text-anchor="middle" font-weight="700"`));
      body.push(svgText(truncateByWidth(point.label, maxLabelWidth, 18), labelX, yLabel, 18, palette.text, `font-weight="700"`));
      if (point.desc) {
        body.push(svgText(truncateByWidth(point.desc, maxDescWidth, 14), labelX, yDesc, 14, palette.muted));
      }
      if (index < params.points.length - 1) {
        body.push(`<line x1="${margin + 22}" y1="${rowTop + rowGap - 5}" x2="${opts.width - margin - 22}" y2="${rowTop + rowGap - 5}" stroke="${palette.line}" stroke-width="1" opacity="0.75"/>`);
      }
    });

    body.push(`</svg>`);
    return body.join("");
  },
};
