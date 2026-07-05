// 图片尺寸兜底：viewBox-only 的 SVG(generateSvg 产出,被 svgSanitize 刻意去掉内禀
// width/height)在缺显式 width 时,fit-content 的 figure 会塌成 0×0 不可见。仅对 SVG 源
// 在无 width 时兜底一个默认正文宽,位图(有内禀像素尺寸)不受影响。
export const DEFAULT_SVG_WIDTH = 560;

export function isSvgSrc(src: string): boolean {
  return /\.svg(?:[?#]|$)/i.test(src) || src.startsWith("data:image/svg");
}

// 用户 resize 过/显式带的 width 优先(?? 链短路);仅当无 width 且是 SVG 源时给默认宽。
export function svgFallbackWidth(src: string, width: number | null): number | null {
  return width ?? (isSvgSrc(src) ? DEFAULT_SVG_WIDTH : null);
}
