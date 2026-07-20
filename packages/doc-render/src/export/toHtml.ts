import type { LegacySection } from "@qingagent/contract-ts";
import type {
  PmBlockNode,
  PmDoc,
  PmInlineNode,
  PmListItemNode,
  PmMark,
  PmTableCellNode,
  PmTaskItemNode,
  PmThemeColor,
} from "@qingagent/pm-schema";
import {
  PM_THEME_HIGHLIGHT_COLOR_VALUES,
  PM_THEME_TEXT_COLOR_VALUES,
  decodeSvgDataUrl,
  isAllowedThemeColor,
} from "@qingagent/pm-schema";
import { hardenInlineSvg } from "../browser/svgSanitize.js";
import { DOCUMENT_EXPORT_CSS } from "./documentStyles.js";
import { highlightCodeHtml, katexCssEmbedded, renderMathHtml } from "./exportAssets.js";
import {
  documentLeadsWithTitle,
  isPmDocDocument,
  isRenderableSvg,
  MAX_EXPORT_SVG_BYTES,
  readLocalUploadBuffer,
  readLocalUploadText,
  sectionText,
  stripFormatting,
  svgExceedsExportByteLimit,
  type ExportDocument,
  type ExportOptions,
} from "./shared.js";

/**
 * 把文档(PmDoc 或 Legacy 段)序列化成一份「自包含的独立 HTML 文档」,内嵌导出打印样式
 * (documentStyles.ts)。HTML 结构镜像前端 .wf-doc 文档纸,配套 CSS 复刻奶白纸暖墨观感,
 * 供 htmlToPdf.ts 用 headless Chromium 打印成高保真 PDF。
 *
 * 纯函数、无浏览器依赖,便于单测;图片内嵌为 data URI、图表内联缓存 SVG,确保渲染不依赖网络。
 */
// 单次 toHtml 调用内,记录是否渲染过公式——是则在 <head> 注入 KaTeX 自包含 CSS(含 base64 字体)。
// toHtml 全程同步执行,模块级标志在入口重置即可,无并发问题。
let mathUsedInRender = false;

export function toHtml(document: ExportDocument, options: ExportOptions = {}): string {
  mathUsedInRender = false;
  const body = isPmDocDocument(document)
    ? document.content.map(pmBlockToHtml).join("\n")
    : document.map(legacySectionToHtml).join("\n");
  const title = options.title?.trim();
  // 正文开头已是同名标题就不再加一遍(去重),否则补一个文档标题
  const titleHtml = title && !documentLeadsWithTitle(document, title)
    ? `<h1 class="doc-title">${escapeHtml(title)}</h1>\n`
    : "";
  return buildDocumentHtml(`${titleHtml}${body}`, title, mathUsedInRender);
}

function buildDocumentHtml(bodyHtml: string, title: string | undefined, mathUsed: boolean): string {
  const headTitle = title ? escapeHtml(title) : "青简导出";
  // 和前端 index.html 一致的 Google Fonts:让在浏览器里打开的 HTML 导出命中真实字体
  // (Noto Sans/Serif SC + JetBrains Mono)。PDF 渲染时 htmlToPdf 会拦截这条外部请求,
  // 改用 VPS 系统装的 Noto Sans/Serif CJK,二者同源、观感一致;字体栈均有系统兜底。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${headTitle}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Noto+Sans+SC:wght@300;400;500;600;700&family=Noto+Serif+SC:wght@400;500;600&display=swap" rel="stylesheet">
${mathUsed ? `<style>${katexCssEmbedded()}</style>\n` : ""}<style>${DOCUMENT_EXPORT_CSS}</style>
</head>
<body>
<table class="wf-page">
<thead><tr><td class="wf-page-pad"></td></tr></thead>
<tfoot><tr><td class="wf-page-pad"></td></tr></tfoot>
<tbody><tr><td class="wf-page-cell">
<article class="wf-doc">
${bodyHtml}
</article>
</td></tr></tbody>
</table>
</body>
</html>`;
}

// ============ PmDoc 块序列化 ============

function pmBlockToHtml(node: PmBlockNode): string {
  switch (node.type) {
    case "heading": {
      const level = node.attrs.level;
      return `<h${level}${alignAttr(node.attrs.textAlign)}>${pmInlineToHtml(node.content ?? [])}</h${level}>`;
    }
    case "paragraph":
      return `<p${alignAttr(node.attrs.textAlign)}>${pmInlineToHtml(node.content ?? [])}</p>`;
    case "penNote":
      return `<aside class="pm-pen-note">${pmInlineToHtml(node.content ?? [])}</aside>`;
    case "blockquote":
      return `<blockquote>${node.content.map(pmBlockToHtml).join("")}</blockquote>`;
    case "bulletList":
      return `<ul>${node.content.map(pmListItemToHtml).join("")}</ul>`;
    case "orderedList": {
      const start = node.attrs.start && node.attrs.start !== 1 ? ` start="${node.attrs.start}"` : "";
      const listStyle = orderedListStyleAttr(node.attrs.listStyle);
      return `<ol${start}${listStyle}>${node.content.map(pmListItemToHtml).join("")}</ol>`;
    }
    case "horizontalRule":
      return "<hr>";
    case "codeBlock": {
      const code = pmInlineText(node.content ?? []);
      const highlighted = highlightCodeHtml(code, node.attrs.language);
      const inner = highlighted ?? escapeHtml(code);
      // 把语言透传到 pre/code(data-language + language-<lang> class),与编辑器视图一致;
      // 否则导出 HTML 丢失语言信息,代码块语言/高亮上下文无从还原(e2e R32-R36 反复确认)。
      const lang = node.attrs.language ? String(node.attrs.language).toLowerCase() : null;
      const langAttr = lang ? ` data-language="${escapeHtml(lang)}"` : "";
      const codeClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre class="code-block hljs"${langAttr}><code${codeClass}>${inner}</code></pre>`;
    }
    case "table":
      return tableToHtml(node.content);
    case "taskList":
      return `<ul class="pm-task-list">${node.content.map(pmTaskItemToHtml).join("")}</ul>`;
    case "callout": {
      const tone = node.attrs.tone ?? "neutral";
      const emoji = node.attrs.emoji ?? "💡";
      const inner = node.content.map((p) => `<p>${pmInlineToHtml(p.content ?? [])}</p>`).join("");
      return `<div class="pm-callout pm-callout--${escapeAttr(tone)}"><span class="pm-callout-emoji">${escapeHtml(emoji)}</span><div class="pm-callout-body">${inner}</div></div>`;
    }
    case "columnList":
      return `<div class="pm-column-list">${node.content
        .map((col) => {
          const ratio = typeof col.attrs.widthRatio === "number" && col.attrs.widthRatio > 0 ? col.attrs.widthRatio : 1;
          return `<div class="pm-column" style="flex-grow:${ratio}">${col.content.map(pmBlockToHtml).join("")}</div>`;
        })
        .join("")}</div>`;
    case "diagram":
      return diagramToHtml(node.attrs.source, node.attrs.svg);
    case "image":
      return imageToHtml({
        src: node.attrs.src,
        alt: node.attrs.alt ?? "",
        caption: node.attrs.caption ?? null,
        align: node.attrs.align ?? null,
      });
    case "fileAttachment":
      return `<div class="doc-file-attach">📎 ${escapeHtml(node.attrs.filename)}</div>`;
    case "blockMath": {
      const math = renderMathHtml(node.attrs.latex, true);
      if (math) {
        mathUsedInRender = true;
        return `<div class="block-math">${math}</div>`;
      }
      return `<div class="block-math">${escapeHtml(node.attrs.latex)}</div>`;
    }
  }
}

function orderedListStyleAttr(value: string | null | undefined): string {
  if (!value || value === "decimal") return "";
  if (!/^(?:lower-alpha|upper-alpha|lower-roman|upper-roman)$/.test(value)) return "";
  return ` style="list-style-type:${value}" data-list-style="${escapeAttr(value)}"`;
}

function pmListItemToHtml(item: PmListItemNode): string {
  return `<li>${item.content.map(pmBlockToHtml).join("")}</li>`;
}

function pmTaskItemToHtml(item: PmTaskItemNode): string {
  const checked = item.attrs.checked;
  const cls = checked ? "is-checked" : "";
  return `<li class="${cls}"><span class="pm-task-checkbox"></span><div class="pm-task-body">${item.content
    .map(pmBlockToHtml)
    .join("")}</div></li>`;
}

function tableToHtml(rows: { content: PmTableCellNode[] }[]): string {
  const body = rows
    .map((row) => `<tr>${row.content.map(pmTableCellToHtml).join("")}</tr>`)
    .join("");
  return `<table><tbody>${body}</tbody></table>`;
}

function pmTableCellToHtml(cell: PmTableCellNode): string {
  const tag = cell.type === "tableHeader" ? "th" : "td";
  const colspan = cell.attrs?.colspan && cell.attrs.colspan > 1 ? ` colspan="${cell.attrs.colspan}"` : "";
  const rowspan = cell.attrs?.rowspan && cell.attrs.rowspan > 1 ? ` rowspan="${cell.attrs.rowspan}"` : "";
  // 单元格背景色:此前导出丢失(回归 table-cell-color)。参照 clipboard 金标准,内联 style 不依赖导出 CSS。
  const bg = cell.attrs?.backgroundColor;
  const bgAttr =
    bg && isAllowedThemeColor(bg)
      ? ` data-bg-color="${escapeAttr(bg)}" style="background-color:${PM_THEME_HIGHLIGHT_COLOR_VALUES[bg as PmThemeColor]}"`
      : "";
  const inner = cell.content.map(pmBlockToHtml).join("") || "<p></p>";
  return `<${tag}${colspan}${rowspan}${bgAttr}>${inner}</${tag}>`;
}

// ============ 行内序列化 ============

export function pmInlineToHtml(content: readonly PmInlineNode[] = []): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "<br>";
      if (node.type === "inlineMath") {
        const math = renderMathHtml(node.attrs.latex, false);
        if (math) {
          mathUsedInRender = true;
          return `<span class="inline-math">${math}</span>`;
        }
        return `<span class="inline-math">${escapeHtml(node.attrs.latex)}</span>`;
      }
      return pmTextNodeToHtml(node.text, node.marks ?? []);
    })
    .join("");
}

function pmTextNodeToHtml(text: string, marks: readonly PmMark[]): string {
  let html = escapeHtml(text);
  // 由内向外逐层包裹:行内代码最内,链接最外。
  let link: Extract<PmMark, { type: "link" }> | null = null;
  let highlight: Extract<PmMark, { type: "highlight" }> | null = null;
  let textColor: Extract<PmMark, { type: "textColor" }> | null = null;
  for (const mark of marks) {
    switch (mark.type) {
      case "code":
        html = `<code class="inline-code">${html}</code>`;
        break;
      case "bold":
        html = `<strong>${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "underline":
        html = `<u>${html}</u>`;
        break;
      case "strike":
        html = `<s>${html}</s>`;
        break;
      case "highlight":
        highlight = mark;
        break;
      case "textColor":
        textColor = mark;
        break;
      case "link":
        link = mark;
        break;
    }
  }
  // 文字色:此前导出丢失(回归 table-cell-color/文字色)。内联 style,不依赖导出 CSS。
  if (textColor && isAllowedThemeColor(textColor.attrs.color)) {
    const c = textColor.attrs.color as PmThemeColor;
    html = `<span data-text-color="${escapeAttr(c)}" style="color:${PM_THEME_TEXT_COLOR_VALUES[c]}">${html}</span>`;
  }
  if (highlight) {
    html = `<mark data-color="${escapeAttr(highlight.attrs.color)}">${html}</mark>`;
  }
  if (link && /^https?:\/\//i.test(link.attrs.href)) {
    html = `<a href="${escapeAttr(link.attrs.href)}">${html}</a>`;
  }
  return html;
}

function pmInlineText(content: readonly { type: string; text?: string }[]): string {
  return content.map((node) => (node.type === "hardBreak" ? "\n" : node.text ?? "")).join("");
}

// ============ 图表 / 图片 ============

function diagramToHtml(source: string, svg: string | null): string {
  if (svg && svgExceedsExportByteLimit(svg)) {
    return `<div class="pm-diagram"><div class="doc-file-attach">[图过大未导出]</div></div><pre class="code-block"><code>${escapeHtml(source)}</code></pre>`;
  }
  // 缓存 mermaid SVG 内联前必须加固:剔除 <script>/on*/外链等可执行面(导出 HTML 可能被人打开)。
  // 加固后仍是可信 SVG,直接内联不转义;加固失败(解析坏/含 XXE)则回退源码。
  const safe = isRenderableSvg(svg) ? hardenInlineSvg(svg, { maxBytes: MAX_EXPORT_SVG_BYTES }) : null;
  if (safe) {
    return `<div class="pm-diagram">${safe}</div>`;
  }
  // 无缓存 / 坏 SVG → 回退源码代码块,绝不让一张图毁掉整篇导出。
  return `<pre class="code-block"><code>${escapeHtml(source)}</code></pre>`;
}

function imageToHtml(opts: { src: string; alt: string; caption: string | null; align: "left" | "center" | "right" | null }): string {
  const { src, alt, caption, align } = opts;
  const alignClass = align === "left" ? " align-left" : align === "right" ? " align-right" : "";
  const captionHtml = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";

  // SVG:仅从 data:image/svg+xml 或本地 .svg 取;内联前加固(data:image/svg+xml 完全可控,
  // 是主要注入面)。加固失败 → 落到下方栅格/占位回退。绝不把栅格图当文本读。
  const isSvgSrc = /^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#].*)?$/i.test(src);
  const rawSvg = isSvgSrc ? (decodeSvgDataUrl(src) ?? readLocalUploadText(src)) : null;
  if (rawSvg && svgExceedsExportByteLimit(rawSvg)) {
    return `<figure class="doc-image${alignClass}"><div class="doc-file-attach">[图过大未导出：${escapeHtml(alt)}]</div>${captionHtml}</figure>`;
  }
  const safeSvg = isRenderableSvg(rawSvg) ? hardenInlineSvg(rawSvg, { maxBytes: MAX_EXPORT_SVG_BYTES }) : null;
  if (safeSvg) {
    return `<figure class="doc-image${alignClass}">${safeSvg}${captionHtml}</figure>`;
  }

  // 栅格图:data URL(png/jpeg)直接用;本地上传读 buffer 转 base64 内嵌。
  let dataImage = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src) ? src : null;
  if (!dataImage) {
    const ext = src.match(/\.(png|jpe?g|gif|webp)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
    const buf = ext ? readLocalUploadBuffer(src) : null;
    if (buf && ext) {
      const mime = ext === "jpg" ? "jpeg" : ext;
      dataImage = `data:image/${mime};base64,${buf.toString("base64")}`;
    }
  }
  if (dataImage) {
    return `<figure class="doc-image${alignClass}"><img src="${escapeAttr(dataImage)}" alt="${escapeAttr(alt)}">${captionHtml}</figure>`;
  }
  return `<figure class="doc-image${alignClass}"><div class="doc-file-attach">[图片：${escapeHtml(alt)}]</div>${captionHtml}</figure>`;
}

// ============ Legacy 段序列化 ============

function legacySectionToHtml(section: LegacySection): string {
  switch (section.kind) {
    case "h1":
      return `<h1>${escapeHtml(sectionText(section))}</h1>`;
    case "h2":
      return `<h2>${escapeHtml(sectionText(section))}</h2>`;
    case "p":
      return `<p>${escapeHtml(stripFormatting(section.data.text))}</p>`;
    case "penNote":
      return `<aside class="pm-pen-note">${escapeHtml(stripFormatting(section.data.text))}</aside>`;
    case "quote":
      return `<blockquote><p>${escapeHtml(stripFormatting(section.data.text))}</p></blockquote>`;
    case "hr":
      return "<hr>";
    case "code":
      return `<pre class="code-block"><code>${escapeHtml(section.data.body.trim())}</code></pre>`;
    case "list":
      return section.data.ordered
        ? `<ol>${section.data.items.map((i) => `<li>${escapeHtml(stripFormatting(i))}</li>`).join("")}</ol>`
        : `<ul>${section.data.items.map((i) => `<li>${escapeHtml(stripFormatting(i))}</li>`).join("")}</ul>`;
    case "table":
      return `<table><tbody><tr>${section.data.head
        .map((cell) => `<th>${escapeHtml(stripFormatting(cell))}</th>`)
        .join("")}</tr>${section.data.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(stripFormatting(cell))}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "diagram":
      return diagramToHtml(section.data.source, section.data.svg);
    case "image":
      return imageToHtml({
        src: section.data.src,
        alt: section.data.alt,
        caption: section.data.caption,
        align: section.data.align ?? null,
      });
  }
}

// ============ 工具 ============

function alignAttr(align: string | null | undefined): string {
  if (align === "center" || align === "right" || align === "justify") {
    return ` style="text-align:${align}"`;
  }
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
