export interface XhsCoverFontFace {
  family: string;
  sourceUrl: string;
  format: "woff2";
  style: "normal";
  weight: number;
}

export const XHS_COVER_FONT_FACES = {
  poster: {
    family: "Qing Smiley Sans",
    sourceUrl: "/fonts/SmileySans-Oblique.woff2",
    format: "woff2",
    style: "normal",
    weight: 700,
  },
  wenkai: {
    family: "Qing LXGW WenKai",
    sourceUrl: "/fonts/LXGWWenKai-Regular.woff2",
    format: "woff2",
    style: "normal",
    weight: 400,
  },
} as const satisfies Record<string, XhsCoverFontFace>;

export function xhsCoverFontFaceCss(
  font: XhsCoverFontFace,
  sourceUrl = font.sourceUrl,
  fontDisplay: "auto" | "block" | "swap" = "swap",
): string {
  return `@font-face{font-family:"${font.family}";src:url("${sourceUrl}") format("${font.format}");font-style:${font.style};font-weight:${font.weight};font-display:${fontDisplay}}`;
}
