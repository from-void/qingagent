/**
 * 把模型在中文语境常误用的弯引号 / 全角引号统一成半角直引号。
 * 只动引号，不动括号；调用方应只在原 Mermaid parse 失败后再兜底使用。
 */
export function normalizeMermaidQuotes(source: string): string {
  return source
    .replace(/[“”„‟〝〞＂«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'");
}
