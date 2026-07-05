/**
 * 导出窗口(printToPDF)的请求放行判定。独立成无 Electron 依赖的纯模块,便于单测。
 *
 * 放行口径:
 * - file: / data: / about: → 放行(自包含 HTML 自身与内联资源)
 * - http(s) 且 host 命中 Google Fonts → 放行(联网取中文字体「思源黑/宋」)
 * - 其余一律拦截(防 SSRF、避免外部资源拖慢/卡住打印)
 */

const ALLOWED_FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

export function isAllowedExportRequest(url: string): boolean {
  if (url.startsWith("file:") || url.startsWith("data:") || url.startsWith("about:")) {
    return true;
  }
  try {
    const u = new URL(url);
    if ((u.protocol === "https:" || u.protocol === "http:") && ALLOWED_FONT_HOSTS.has(u.hostname)) {
      return true;
    }
  } catch {
    // URL 解析失败按拦截处理。
  }
  return false;
}
