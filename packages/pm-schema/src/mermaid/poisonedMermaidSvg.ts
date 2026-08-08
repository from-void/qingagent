/**
 * 判断 Mermaid SVG 是否为 W11 之前遗留的“无文字毒缓存”。
 *
 * 旧版 Mermaid 用 foreignObject 承载标签，hardenInlineSvg 会为安全删除它，
 * 最终缓存只剩图形而没有任何 <text>。Mermaid 源码非空时必有需要展示的文字；
 * drawio 有独立的文字 fallback，调用方不得对 drawio 使用此判定。
 */
export function isPoisonedMermaidSvg(
  svg: string | null | undefined,
  source: string | null | undefined,
): boolean {
  return Boolean(svg?.trim() && source?.trim() && !/<text\b/i.test(svg));
}
