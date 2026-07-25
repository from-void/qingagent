import { htmlToPdf } from "./htmlToPdf.js";
import { withRenderedDiagrams } from "./mermaidServer.js";
import { toHtml } from "./toHtml.js";
import type { ExportDocument, ExportOptions } from "./shared.js";

/**
 * 导出 PDF:先补齐可服务端渲染的 Mermaid SVG；drawio 使用已有客户端安全缓存，
 * 再把文档序列化成与前端「文档纸」一致的自包含 HTML(toHtml),最后用 headless Chromium 高保真
 * 打印成 PDF。字体(宋体)、奶白纸、mermaid 图表、callout、代码块、分页留白等都复用前端渲染观感。
 */
export async function toPdf(document: ExportDocument, options: ExportOptions = {}): Promise<Buffer> {
  const prepared = await withRenderedDiagrams(document);
  const html = toHtml(prepared, options);
  return htmlToPdf(html);
}
