import { z } from "zod";
import type { SvgTemplate } from "./types.js";
import { accentSchemaValues, formatNumber, paletteFor, safeTitle, svgText, truncateByWidth, type Accent } from "./shared.js";

export const barCardParamsSchema = z.object({
  title: z.string().max(24).optional(),
  unit: z.string().max(8).optional(),
  bars: z.array(z.object({
    label: z.string().min(1).max(10),
    value: z.number().min(0),
  })).min(1).max(8),
  accent: z.enum(accentSchemaValues).optional(),
});

type BarCardParams = z.infer<typeof barCardParamsSchema>;

export const barCardTemplate: SvgTemplate<BarCardParams> = {
  id: "bar-card",
  label: "数据条形示意卡，用于 1-8 组非负数值的横向条形展示",
  paramsSchema: barCardParamsSchema,
  render(params, opts) {
    const palette = paletteFor(params.accent as Accent | undefined);
    const margin = 44;
    const title = safeTitle(params.title, opts.width - margin * 2);
    const top = params.title ? 98 : 62;
    const availableHeight = opts.height - top - margin;
    const rowGap = Math.max(34, availableHeight / params.bars.length);
    const labelX = margin + 6;
    const barX = margin + 118;
    const valueWidth = 76;
    const barWidth = Math.max(180, opts.width - barX - margin - valueWidth - 18);
    const maxValue = Math.max(...params.bars.map((bar) => bar.value), 0);
    const unit = params.unit ?? "";
    const body: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}">`,
      `<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${palette.paper}"/>`,
      svgText(title, margin, params.title ? 58 : 50, 28, palette.text, `font-weight="700"`),
      `<rect x="${margin}" y="${top - 22}" width="${opts.width - margin * 2}" height="${availableHeight + 28}" fill="${palette.panel}" stroke="${palette.line}" stroke-width="2"/>`,
    ];

    params.bars.forEach((bar, index) => {
      const rowTop = top + index * rowGap;
      const y = rowTop + 22;
      const filled = maxValue > 0 && bar.value > 0
        ? Math.max(4, (bar.value / maxValue) * barWidth)
        : 0;
      const valueText = truncateByWidth(`${formatNumber(bar.value)}${unit}`, valueWidth, 14);
      body.push(svgText(truncateByWidth(bar.label, 88, 14), labelX, y, 14, palette.text, `font-weight="700"`));
      body.push(`<rect x="${barX}" y="${rowTop + 7}" width="${barWidth}" height="18" fill="${palette.panelAlt}"/>`);
      if (filled > 0) {
        body.push(`<rect x="${barX}" y="${rowTop + 7}" width="${filled.toFixed(1)}" height="18" fill="${palette.accent}"/>`);
      }
      body.push(svgText(valueText, barX + barWidth + 16, y, 14, palette.text));
    });

    body.push(`</svg>`);
    return body.join("");
  },
};
