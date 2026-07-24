/**
 * 导出窗口(printToPDF)的请求放行判定。独立成无 Electron 依赖的纯模块,便于单测。
 *
 * 放行口径:
 * - file: → 只放行当前导出私有临时目录
 * - data: / about: → 放行(内联资源与空白页)
 * - http(s) 且 host 命中 Google Fonts → 放行(联网取中文字体「思源黑/宋」)
 * - 其余一律拦截(防 SSRF、避免外部资源拖慢/卡住打印)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function normalizedForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFileInsideExportDirectory(url: URL, exportDirectory: string): boolean {
  try {
    const root = normalizedForComparison(exportDirectory);
    const target = normalizedForComparison(fileURLToPath(url));
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

export function isAllowedExportRequest(url: string, exportDirectory: string): boolean {
  if (url.startsWith("data:") || url.startsWith("about:")) {
    return true;
  }
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return isFileInsideExportDirectory(u, exportDirectory);
    if ((u.protocol === "https:" || u.protocol === "http:") && ALLOWED_FONT_HOSTS.has(u.hostname)) {
      return true;
    }
  } catch {
    // URL 解析失败按拦截处理。
  }
  return false;
}
