import type { LegacySection } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { pmToPlainText } from "@qingagent/pm-schema";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { uploadsBaseDir } from "../workspace/uploadsDir.js";

export interface ExportOptions {
  title?: string;
}

export type ExportDocument = LegacySection[] | PmDoc;

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
    .replace(/<[^>]*>/g, "")
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
  return pmToPlainText(doc)
    .split("\n")
    .map(stripFormatting)
    .filter(Boolean)
    .join("\n\n");
}

const UPLOADS_BASE = uploadsBaseDir();
// 上传 id 必须是 UUID（generateSvg 用 randomUUID 生成）；文件名限定安全字符。
// 这样可挡住 `..`、URL 编码注入等路径穿越（/api/v1/files/../package.json/...）。
const UPLOAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UPLOAD_FILENAME = /^[A-Za-z0-9._-]+$/;

export function localUploadPath(src: string): string | null {
  const match = src.match(/^\/api\/v1\/files\/([^/]+)\/([^/?#]+)$/);
  if (!match) return null;
  const id = match[1]!;
  const filename = match[2]!;
  // 严格白名单 + 显式拒绝 . / ..，防止路径穿越
  if (!UPLOAD_ID.test(id)) return null;
  if (!UPLOAD_FILENAME.test(filename) || filename === "." || filename === "..") return null;
  const path = join(UPLOADS_BASE, id, filename);
  // 双保险：解析后的绝对路径必须仍在 UPLOADS_BASE 之内
  const resolved = resolve(path);
  if (resolved !== UPLOADS_BASE && !resolved.startsWith(UPLOADS_BASE + sep)) return null;
  return resolved;
}

/**
 * 判断 diagram 缓存 svg 是否可安全内嵌进导出:必须看起来是 svg 且不超大。
 * 不合法/超大/为空 → 调用方回退到源码代码块。HTML→Chromium 导出里,无尺寸 svg 内联后会塌成
 * 0 高或异常拉伸;docx 导出仍走栅格化也需要尺寸。两条出口共用此门,坏图不毁整篇导出。
 */
const MAX_EXPORT_SVG_BYTES = 2_000_000; // 2MB:正常 mermaid 图远小于此,超大多半是异常
export function isRenderableSvg(svg: string | null | undefined): svg is string {
  if (!svg) return false;
  if (svg.length > MAX_EXPORT_SVG_BYTES) return false;
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
