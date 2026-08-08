import type { PmDoc } from "@qingagent/pm-schema";
import { pmToPlainText } from "@qingagent/pm-schema";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { uploadsBaseDir } from "../paths/uploadsDir.js";

export interface ExportOptions {
  title?: string;
  /** Markdown 导出时用于绝对化 `/api/` 图片与附件链接的服务 origin/base URL。 */
  baseUrl?: string;
  /** 由实际执行降级的导出器上报；调用方负责聚合并传给客户端。 */
  onDegradation?: (degradation: ExportDegradation) => void;
}

export type ExportDocument = PmDoc;

export type ExportDegradationKind =
  | "markdown-columns-flattened"
  | "docx-columns-flattened"
  | "svg-rasterized"
  | "specialized-diagram-overlay";

export interface ExportDegradation {
  kind: ExportDegradationKind;
  description: string;
}

const EXPORT_DEGRADATIONS: Record<ExportDegradationKind, ExportDegradation> = {
  "markdown-columns-flattened": {
    kind: "markdown-columns-flattened",
    description: "分栏已拍平为纵向；需保留并排版式请导出 HTML 或 PDF",
  },
  "docx-columns-flattened": {
    kind: "docx-columns-flattened",
    description: "分栏已拍平为纵向，原并排版式无法保留",
  },
  "svg-rasterized": {
    kind: "svg-rasterized",
    description: "SVG 已转为位图，放大会模糊",
  },
  "specialized-diagram-overlay": {
    kind: "specialized-diagram-overlay",
    description: "专有图表已保留完整语义，画布布局未应用",
  },
};

export function exportDegradation(kind: ExportDegradationKind): ExportDegradation {
  return EXPORT_DEGRADATIONS[kind];
}

export function createExportDegradationReporter(
  onDegradation: ExportOptions["onDegradation"],
): (kind: ExportDegradationKind) => void {
  const reported = new Set<ExportDegradationKind>();
  return (kind) => {
    if (!onDegradation || reported.has(kind)) return;
    reported.add(kind);
    onDegradation(exportDegradation(kind));
  };
}

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
  const first = document.content[0];
  if (first?.type !== "heading") return false;
  if (options.requireLevel1 && first.attrs?.level !== 1) return false;
  const text = (first.content ?? [])
    .map((node) => ("text" in node && typeof node.text === "string" ? node.text : ""))
    .join("")
    .trim();
  return text === target;
}

export function pmDocToPlainExportText(doc: PmDoc): string {
  // PM 已是结构化节点，pmToPlainText 直接取 textContent；此处再按字符串猜 HTML/Markdown
  // 会把用户手打的 `<name>` 等字面内容误删。
  // 逐个顶层块序列化，只由导出层在块之间补一个空行。不能把整篇文本拆行后 trim，
  // 否则 codeBlock 内的缩进、空行与相邻代码行都会被破坏。
  const blocks = doc.content
    .map((node) => pmToPlainText({ ...doc, content: [node] }).replace(/\r\n?/g, "\n"))
    .filter((text) => text.length > 0);
  return blocks.reduce(
    (output, text) =>
      output.length === 0
        ? text
        : `${output}${output.endsWith("\n") ? "\n" : "\n\n"}${text}`,
    "",
  );
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
