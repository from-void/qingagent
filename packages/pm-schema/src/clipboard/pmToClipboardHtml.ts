// F3 剪切板:把 PmDoc(或选区子文档)序列化为干净的语义 HTML。
// 目标:粘贴到飞书/Word/邮件等支持 HTML 的应用时保留表格/标题/列表/粗斜体/链接;
// 不支持 HTML 的目标自动降级到 text/plain(pmToPlainText,表格为 TSV)。
// 不用 ProseMirror 默认 DOM 序列化:它会带 data-* 属性与自定义标签(penNote 的
// aside 等),外部应用兼容性差。这里只输出白名单语义标签。

import type { PmDoc, PmInlineNode, PmMark, PmNode, PmThemeColor } from "../types";
import { PM_IMAGE_ALIGN_VALUES, PM_THEME_HIGHLIGHT_COLOR_VALUES, PM_THEME_TEXT_COLOR_VALUES } from "../spec";
import { isAllowedImageSrc, isAllowedLinkHref, isAllowedThemeColor } from "../validators";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stringAttr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveIntAttr(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function themeColorAttr(value: unknown): PmThemeColor | null {
  return isAllowedThemeColor(value) ? (value as PmThemeColor) : null;
}

type ImageAlign = (typeof PM_IMAGE_ALIGN_VALUES)[number];

function imageAlignAttr(value: unknown): ImageAlign {
  return PM_IMAGE_ALIGN_VALUES.includes(value as ImageAlign) ? (value as ImageAlign) : "center";
}

function imageStyle(width: number | null, align: ImageAlign): string {
  const parts = ["max-width:100%", "height:auto", "display:block"];
  if (width) parts.push(`width:${width}px`);
  if (align === "center") parts.push("margin-left:auto", "margin-right:auto");
  if (align === "left") parts.push("margin-right:auto");
  if (align === "right") parts.push("margin-left:auto");
  return parts.join("; ");
}

function tableCellAttrsToHtml(node: PmNode): string {
  const attrs = (node as { attrs?: { colspan?: unknown; rowspan?: unknown; backgroundColor?: unknown } }).attrs;
  const parts: string[] = [];
  const colspan = positiveIntAttr(attrs?.colspan);
  const rowspan = positiveIntAttr(attrs?.rowspan);
  const backgroundColor = themeColorAttr(attrs?.backgroundColor);
  if (colspan && colspan > 1) parts.push(`colspan="${colspan}"`);
  if (rowspan && rowspan > 1) parts.push(`rowspan="${rowspan}"`);
  if (backgroundColor) {
    parts.push(`data-bg-color="${backgroundColor}"`);
    parts.push(`style="background-color:${PM_THEME_HIGHLIGHT_COLOR_VALUES[backgroundColor]}"`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function attr(name: string, value: unknown): string {
  const stringValue = stringAttr(value);
  return stringValue ? ` ${name}="${escapeHtml(stringValue)}"` : "";
}

function boolAttr(name: string, value: boolean | undefined): string {
  return value ? ` ${name}="true"` : ` ${name}="false"`;
}

function markToTag(mark: PmMark): { open: string; close: string } | null {
  switch (mark.type) {
    case "bold":
      return { open: "<strong>", close: "</strong>" };
    case "italic":
      return { open: "<em>", close: "</em>" };
    case "underline":
      return { open: "<u>", close: "</u>" };
    case "strike":
      return { open: "<s>", close: "</s>" };
    case "code":
      return { open: "<code>", close: "</code>" };
    case "textColor": {
      const color = themeColorAttr((mark as { attrs?: { color?: unknown } }).attrs?.color);
      if (!color) return null;
      return {
        open: `<span data-text-color="${color}" style="color:${PM_THEME_TEXT_COLOR_VALUES[color]}">`,
        close: "</span>",
      };
    }
    case "highlight": {
      const color = themeColorAttr((mark as { attrs?: { color?: unknown } }).attrs?.color);
      if (!color) return { open: "<mark>", close: "</mark>" };
      return {
        open: `<mark data-color="${color}" style="background-color:${PM_THEME_HIGHLIGHT_COLOR_VALUES[color]}">`,
        close: "</mark>",
      };
    }
    case "link": {
      const href = stringAttr((mark as { attrs?: { href?: unknown } }).attrs?.href).trim();
      // 非白名单协议的 href 不输出链接,只留文字(防 javascript: 等)。
      if (!href || !isAllowedLinkHref(href)) return null;
      return { open: `<a href="${escapeHtml(href)}">`, close: "</a>" };
    }
    default:
      return null;
  }
}

function inlineToHtml(node: PmInlineNode): string {
  if (node.type === "hardBreak") return "<br/>";
  if (node.type === "inlineMath") {
    const latex = stringAttr(node.attrs?.latex);
    const escaped = escapeHtml(latex);
    return `<span data-type="inline-math" data-latex="${escaped}">$${escaped}$</span>`;
  }
  if (node.type !== "text") return "";
  let html = escapeHtml(stringAttr(node.text));
  const marks = (node as { marks?: PmMark[] }).marks ?? [];
  // 由内向外包裹,顺序稳定。
  for (const mark of [...marks].reverse()) {
    const tag = markToTag(mark);
    if (tag) html = `${tag.open}${html}${tag.close}`;
  }
  return html;
}

function inlinesToHtml(content: PmInlineNode[] | undefined): string {
  return (content ?? []).map(inlineToHtml).join("");
}

function nodeToHtml(node: PmNode): string {
  switch (node.type) {
    case "paragraph":
      return `<p>${inlinesToHtml(node.content as PmInlineNode[])}</p>`;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number((node as { attrs?: { level?: number } }).attrs?.level ?? 1)));
      return `<h${level}>${inlinesToHtml(node.content as PmInlineNode[])}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${(node.content ?? []).map(nodeToHtml).join("")}</blockquote>`;
    case "bulletList":
      return `<ul>${(node.content ?? []).map(nodeToHtml).join("")}</ul>`;
    case "orderedList":
      return `<ol>${(node.content ?? []).map(nodeToHtml).join("")}</ol>`;
    case "listItem":
      return `<li>${(node.content ?? []).map(nodeToHtml).join("")}</li>`;
    case "codeBlock": {
      const text = ((node.content ?? []) as PmInlineNode[])
        .map((c) => (c.type === "text" ? c.text : "\n"))
        .join("");
      const language = stringAttr((node as { attrs?: { language?: unknown } }).attrs?.language) || "plaintext";
      return `<pre data-language="${escapeHtml(language)}"><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr/>";
    case "table":
      return `<table>${(node.content ?? []).map(nodeToHtml).join("")}</table>`;
    case "tableRow":
      return `<tr>${(node.content ?? []).map(nodeToHtml).join("")}</tr>`;
    case "tableHeader":
      return `<th${tableCellAttrsToHtml(node)}>${(node.content ?? []).map(nodeToHtml).join("")}</th>`;
    case "tableCell":
      return `<td${tableCellAttrsToHtml(node)}>${(node.content ?? []).map(nodeToHtml).join("")}</td>`;
    case "penNote":
      // 笔记块降级为普通段落(外部应用没有对应概念)。
      return `<p>${inlinesToHtml(node.content as PmInlineNode[])}</p>`;
	    case "image": {
	      const attrs = (node as { attrs?: { src?: unknown; alt?: unknown; caption?: unknown; width?: unknown; height?: unknown; align?: unknown } }).attrs;
	      const label = stringAttr(attrs?.caption) || stringAttr(attrs?.alt);
	      const src = stringAttr(attrs?.src);
	      if (!src || !isAllowedImageSrc(src)) {
	        return label ? `<p>[图: ${escapeHtml(label)}]</p>` : "<p>[图]</p>";
	      }
	      const width = positiveIntAttr(attrs?.width);
	      const height = positiveIntAttr(attrs?.height);
	      const align = imageAlignAttr(attrs?.align);
	      const caption = stringAttr(attrs?.caption);
	      const imgAttrs = [
	        `src="${escapeHtml(src)}"`,
	        `alt="${escapeHtml(stringAttr(attrs?.alt))}"`,
	        `data-align="${align}"`,
	        caption ? `data-caption="${escapeHtml(caption)}"` : "",
	        width ? `width="${width}"` : "",
	        height ? `height="${height}"` : "",
	        `style="${escapeHtml(imageStyle(width, align))}"`,
	      ].filter(Boolean).join(" ");
	      const figcaption = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
	      return `<figure data-pm-node="image" data-align="${align}" style="margin:16px 0"><img ${imgAttrs}/>${figcaption}</figure>`;
	    }
    case "fileAttachment": {
      const filename = stringAttr((node as { attrs?: { filename?: unknown } }).attrs?.filename);
      return filename ? `<p>[附件: ${escapeHtml(filename)}]</p>` : "";
    }
    case "diagram": {
      // 图表降级为源码代码块(外部应用无 mermaid 渲染);至少别让 text/html 为空导致粘空。
      const src = stringAttr((node as { attrs?: { source?: unknown } }).attrs?.source);
      return src ? `<pre data-language="mermaid"><code class="language-mermaid">${escapeHtml(src)}</code></pre>` : "";
    }
    case "blockMath": {
      const latex = stringAttr((node as { attrs?: { latex?: unknown } }).attrs?.latex);
      const escaped = escapeHtml(latex);
      return `<div data-type="block-math" data-latex="${escaped}">$$${escaped}$$</div>`;
    }
    case "taskList":
      return `<ul data-type="taskList">${(node.content ?? []).map(nodeToHtml).join("")}</ul>`;
    case "taskItem": {
      const checked = Boolean((node as { attrs?: { checked?: unknown } }).attrs?.checked);
      return `<li data-type="taskItem"${boolAttr("data-checked", checked)}>${(node.content ?? []).map(nodeToHtml).join("")}</li>`;
    }
    case "callout": {
      const attrs = (node as { attrs?: { emoji?: unknown; tone?: unknown } }).attrs;
      return [
        `<div data-pm-node="callout"${attr("data-emoji", attrs?.emoji)}${attr("data-tone", attrs?.tone)}>`,
        `<span class="pm-callout-emoji" contenteditable="false">${escapeHtml(stringAttr(attrs?.emoji) || "💡")}</span>`,
        `<div class="pm-callout-body">${(node.content ?? []).map(nodeToHtml).join("")}</div>`,
        "</div>",
      ].join("");
    }
    case "columnList":
      // 分栏:整块拷出为 data-pm-node 容器,供编辑器内粘贴往返还原(tiptap parseHTML 认这套结构)。
      return `<div data-pm-node="columnList">${(node.content ?? []).map(nodeToHtml).join("")}</div>`;
    case "column": {
      const widthRatio = (node as { attrs?: { widthRatio?: unknown } }).attrs?.widthRatio;
      const ratioStr = typeof widthRatio === "number" && Number.isFinite(widthRatio) ? String(widthRatio) : undefined;
      return `<div data-pm-node="column"${attr("data-width-ratio", ratioStr)}>${(node.content ?? []).map(nodeToHtml).join("")}</div>`;
    }
    default:
      return "";
  }
}

/** 整篇或选区子文档 → 语义 HTML(白名单标签,无 data-* 噪音)。 */
export function pmToClipboardHtml(doc: PmDoc): string {
  return doc.content.map(nodeToHtml).filter(Boolean).join("");
}
