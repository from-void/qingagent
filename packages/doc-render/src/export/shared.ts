import type { LegacySection } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { pmToPlainText } from "@qingagent/pm-schema";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { uploadsBaseDir } from "../paths/uploadsDir.js";

export interface ExportOptions {
  title?: string;
  /** Markdown 导出时用于绝对化 `/api/` 图片与附件链接的服务 origin/base URL。 */
  baseUrl?: string;
}

export type ExportDocument = LegacySection[] | PmDoc;

// 仅写入导出克隆，用于区分 draw.io 回退源码是否真的经过归一化。
// 扫描导出文档时会先清除输入中可能存在的同名字段，避免污染或误信持久化数据。
export const DRAWIO_EXPORT_SOURCE_NORMALIZED_ATTR = "__drawioExportSourceNormalized";

export function isDrawioExportSourceNormalized(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>)[DRAWIO_EXPORT_SOURCE_NORMALIZED_ATTR] === true;
}

export function drawioFallbackMessage(oversized: boolean, sourceNormalized: boolean): string {
  if (!sourceNormalized) {
    return oversized
      ? "draw.io 图表过大，以下为图表源码（可复制到 draw.io 查看）"
      : "以下为图表源码（可复制到 draw.io 查看）";
  }
  return oversized
    ? "draw.io 图表过大，以下数据已按安全边界归一化，可能与原图有差异（可复制到 draw.io 查看）"
    : "draw.io 图表数据已按安全边界归一化，可能与原图有差异（未能生成预览，可复制到 draw.io 查看）";
}

export function isPmDocDocument(value: ExportDocument): value is PmDoc {
  return !Array.isArray(value) && value.type === "doc";
}

/**
 * 文档正文首块是否已是与导出标题同文的标题块。
 * 用于去重:导出时若正文开头就是该标题(agent 通常把标题写成首个 H1),就不再额外加一遍
 * options.title,避免出现两个一样的标题(PDF/DOCX 实测重复)。
 */
export function documentLeadsWithTitle(
  document: ExportDocument,
  title: string | undefined,
  // 仅认 H1 标题(默认 false 兼容 toHtml/toDocx 既有口径,它们接受 H1/H2)。
  // toMarkdown 传 true:首块是与 title 同名的 H2 时不算"已含标题",仍补一个 H1,
  // 避免改动既有 Markdown 行为(只修粗体 H1 漏判这一种)。
  options: { requireLevel1?: boolean } = {},
): boolean {
  const target = title?.trim();
  if (!target) return false;
  if (isPmDocDocument(document)) {
    const first = document.content[0];
    if (first?.type !== "heading") return false;
    if (options.requireLevel1 && first.attrs?.level !== 1) return false;
    const text = (first.content ?? [])
      .map((node) => ("text" in node && typeof node.text === "string" ? node.text : ""))
      .join("")
      .trim();
    return text === target;
  }
  const first = document[0];
  if (first && (first.kind === "h1" || (!options.requireLevel1 && first.kind === "h2"))) {
    return stripFormatting(first.data.text).trim() === target;
  }
  return false;
}

export function stripFormatting(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(HTML_TAG, (source, tagName: string) =>
      KNOWN_HTML_TAGS.has(tagName.toLowerCase()) ? "" : source,
    )
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(?:---+|___+|\*\*\*+)$/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/`+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^\w])\*([^*\n]+)\*(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// LegacySection 的 text 是历史富文本字符串，可能混有这些标准 HTML 标签；`<name>`、
// `<你的名字>` 等用户占位符不是已知标签，必须原样保留。标签属性允许引号内出现 `>`，
// 避免退回会误截断属性值的 `<[^>]*>` 一类粗正则。
const KNOWN_HTML_TAGS = new Set(
  (
    "a abbr address area article aside audio b base bdi bdo big blockquote body br button canvas " +
    "caption center cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed " +
    "fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup " +
    "hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav " +
    "nobr noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script " +
    "search section select slot small source span strike strong style sub summary sup table tbody td " +
    "template textarea tfoot th thead time title tr track tt u ul var video wbr"
  ).split(" "),
);
const HTML_TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/g;

export function sectionText(section: LegacySection): string {
  switch (section.kind) {
    case "quote":
      return stripFormatting(section.data.text);
    case "hr":
      return "";
    case "list":
      return section.data.items.map(stripFormatting).join("\n");
    case "h1":
    case "p":
    case "penNote":
      return stripFormatting(section.data.text);
    case "h2":
      return stripFormatting(section.data.text);
    case "code":
      return section.data.body.trim();
    case "table":
      return [
        section.data.head.map(stripFormatting).join("\t"),
        ...section.data.rows.map((row) => row.map(stripFormatting).join("\t")),
      ].join("\n");
    case "image":
      return stripFormatting(section.data.caption ?? section.data.alt);
    case "diagram":
      return section.data.source.trim();
  }
}

export function pmDocToPlainExportText(doc: PmDoc): string {
  // PM 已是结构化节点，pmToPlainText 直接取 textContent；此处再按字符串猜 HTML/Markdown
  // 会把用户手打的 `<name>` 等字面内容误删。
  // 逐个顶层块序列化，只由导出层在块之间补一个空行。不能把整篇文本拆行后 trim，
  // 否则 codeBlock 内的缩进、空行与相邻代码行都会被破坏。
  return doc.content
    .map((node) => pmToPlainText({ ...doc, content: [node] }).replace(/\r\n?/g, "\n"))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// 上传 id 必须是 UUID（generateSvg 用 randomUUID 生成）；文件名只解码最后一个 URL segment，
// 再拒绝路径分隔符、点目录与控制字符，兼容中文/空格同时挡住路径穿越。
const UPLOAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UPLOAD_FILENAME_CONTROL = /[\u0000-\u001f\u007f]/;

export function localUploadPath(src: string): string | null {
  const match = src.match(/^\/api\/v1\/files\/([^/]+)\/([^/?#]+)$/);
  if (!match) return null;
  const id = match[1]!;
  let filename: string;
  try {
    filename = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (!UPLOAD_ID.test(id)) return null;
  if (!filename || filename === "." || filename === "..") return null;
  if (filename.includes("/") || filename.includes("\\") || UPLOAD_FILENAME_CONTROL.test(filename)) return null;
  const uploadsBase = uploadsBaseDir();
  const path = join(uploadsBase, id, filename);
  // 双保险：解析后的绝对路径必须仍在 uploads 根之内
  const resolved = resolve(path);
  if (resolved !== uploadsBase && !resolved.startsWith(uploadsBase + sep)) return null;
  return resolved;
}

/**
 * 判断 diagram 缓存 svg 是否可安全内嵌进导出:必须看起来是 svg 且不超大。
 * 不合法/超大/为空 → 调用方回退到源码代码块。HTML→Chromium 导出里,无尺寸 svg 内联后会塌成
 * 0 高或异常拉伸;docx 导出仍走栅格化也需要尺寸。两条出口共用此门,坏图不毁整篇导出。
 */
export const MAX_EXPORT_SVG_BYTES = 2_000_000; // 2MB:正常 mermaid 图远小于此,超大多半是异常
export function svgExceedsExportByteLimit(svg: string): boolean {
  return svg.length > MAX_EXPORT_SVG_BYTES || Buffer.byteLength(svg, "utf8") > MAX_EXPORT_SVG_BYTES;
}

export function isRenderableSvg(svg: string | null | undefined): svg is string {
  if (!svg) return false;
  if (svgExceedsExportByteLimit(svg)) return false;
  // 必须看起来是 svg
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) return false;
  // 必须带尺寸信息(viewBox 或 width+height),否则内联/栅格化时无参照尺寸。
  // mermaid 正常输出一定带 viewBox(或 width+height)。取根 <svg ...> 标签判断。
  const openTag = svg.slice(0, 2000).match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const hasViewBox = /\bviewBox\s*=/i.test(openTag);
  const hasWH = /\bwidth\s*=/i.test(openTag) && /\bheight\s*=/i.test(openTag);
  return hasViewBox || hasWH;
}

export function readLocalUploadText(src: string): string | null {
  const path = localUploadPath(src);
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function readLocalUploadBuffer(src: string): Buffer | null {
  const path = localUploadPath(src);
  if (!path || !existsSync(path)) return null;
  return readFileSync(path);
}
