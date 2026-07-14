import { flattenNestedTablesInCells, legacySectionsToPm, pmToClipboardHtml, upgradeMermaidCodeBlocksToDiagram, type PmBlockNode, type PmDoc } from "@qingagent/pm-schema";
import { normalizeImageAlign } from "../ImageView";
import { viewDocSpanText } from "../../data/protocol";
import type { ViewBlock, ViewDocSpan, ViewDocumentSnapshot } from "../../data/protocol";

export function viewDocToPm(doc: ViewDocumentSnapshot): PmDoc {
  // 装载侧安全网:把任何"伪装成代码块的 mermaid"升级回 diagram 块,绝不让图表渲染成死代码、丢可视化编辑入口
  // (用户报的「Mermaid 退回代码格式」)。命中 0 处时为结构等价克隆,不影响正常文档。
  if (doc.pmDoc) return flattenNestedTablesInCells(upgradeMermaidCodeBlocksToDiagram(doc.pmDoc));
  return legacySectionsToPm(doc.sections.map(viewSectionToLegacy) as never);
}

export function hasMissingPresentationBlockId(doc: unknown): boolean {
  let missing = false;
  const visit = (node: unknown) => {
    if (missing || !node || typeof node !== "object") return;
    const record = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (
      (record.type === "paragraph" || record.type === "listItem") &&
      !readNonEmptyBlockId(record.attrs)
    ) {
      missing = true;
      return;
    }
    if (!Array.isArray(record.content)) return;
    for (const child of record.content) visit(child);
  };

  visit(doc);
  return missing;
}

function readNonEmptyBlockId(attrs: unknown): string | null {
  if (!attrs || typeof attrs !== "object") return null;
  const blockId = (attrs as { blockId?: unknown }).blockId;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

export function viewSectionToLegacy(section: ViewBlock) {
  switch (section.kind) {
    case "h1":
      return { kind: "h1", data: { text: section.spans?.map(spanToTextRaw).join("") ?? section.text } };
    case "h2":
      return { kind: "h2", data: { text: section.spans?.map(spanToTextRaw).join("") ?? section.text, anchor: section.anchor ?? null } };
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return { kind: section.kind, data: { text: section.spans?.map(spanToTextRaw).join("") ?? section.text } };
    case "p":
      return { kind: "p", data: { text: section.spans.map(spanToTextRaw).join("") } };
    case "quote":
      return { kind: "quote", data: { text: section.text } };
    case "list":
      return { kind: "list", data: { ordered: section.ordered, items: section.items } };
    case "hr":
      return { kind: "hr", data: {} };
    case "table":
      return { kind: "table", data: { head: section.head, rows: section.rows } };
    case "code":
      return { kind: "code", data: { body: section.body, language: section.language ?? "plaintext" } };
    case "diagram":
      return { kind: "diagram", data: { lang: section.lang, source: section.source, svg: section.svg } };
    case "penNote":
      return { kind: "penNote", data: { text: section.text } };
	    case "image":
	      return {
	        kind: "image",
	        data: {
	          src: section.src,
	          alt: section.alt,
	          caption: section.caption,
	          width: section.width,
	          height: section.height,
	          align: section.align ?? "center",
	        },
	      };
    case "fileAttachment":
      return { kind: "p", data: { text: `附件：${section.filename}` } };
    // 保真块仅出现在带 pmDoc 的快照里;getDocAsPm 在 pmDoc 存在时直接返回 pmDoc,
    // 不会走到这里(legacySectionsToPm 仅旧无 pmDoc 文档的兜底)。这里给安全降级保证类型完备。
    case "taskList":
      return { kind: "list", data: { ordered: false, items: section.text.split("\n") } };
    case "callout":
      return { kind: "quote", data: { text: section.text } };
    case "columnList":
      return { kind: "p", data: { text: section.text } };
    case "math":
      return { kind: "code", data: { body: section.latex, language: "latex" } };
  }
}

export function viewSectionsToHtml(sections: readonly ViewBlock[]): string {
  return sections.map(sectionToHtml).join("");
}

function sectionToHtml(section: ViewBlock): string {
  switch (section.kind) {
    case "h1":
      return `<h1>${section.spans ? section.spans.map(spanToText).join("") : esc(section.text)}</h1>`;
    case "h2":
      return `<h2>${section.spans ? section.spans.map(spanToText).join("") : esc(section.text)}</h2>`;
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `<${section.kind}>${section.spans ? section.spans.map(spanToText).join("") : esc(section.text)}</${section.kind}>`;
    case "p":
      return `<p>${section.spans.map(spanToText).join("")}</p>`;
    case "quote":
      if (section.node && !hasPatchSpan(section.spans)) return faithfulNodeToHtml(section.node);
      return `<blockquote><p>${section.spans ? section.spans.map(spanToText).join("") : esc(section.text)}</p></blockquote>`;
    case "list": {
      const tag = section.ordered ? "ol" : "ul";
      const attrs = section.ordered && section.listStyle
        ? ` data-list-style="${escAttr(section.listStyle)}" style="list-style-type: ${escAttr(section.listStyle)}"`
        : "";
      return `<${tag}${attrs}>${section.items.map((item, i) => `<li><p>${section.itemSpans?.[i]?.length ? section.itemSpans[i]!.map(spanToText).join("") : esc(item)}</p></li>`).join("")}</${tag}>`;
    }
    case "hr":
      return "<hr />";
    case "table": {
      const ths = section.head.map((h, i) => `<th>${section.headSpans?.[i]?.length ? section.headSpans[i]!.map(spanToText).join("") : esc(h)}</th>`).join("");
      const trs = section.rows
        .map((r, rowIndex) => `<tr>${r.map((c, cellIndex) => `<td>${section.rowSpans?.[rowIndex]?.[cellIndex]?.length ? section.rowSpans[rowIndex]![cellIndex]!.map(spanToText).join("") : esc(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
    }
    case "code":
      return `<pre data-language="${escAttr(section.language ?? "plaintext")}"><code class="language-${escAttr(section.language ?? "plaintext")}">${esc(section.body)}</code></pre>`;
    case "diagram":
      // 关键:输出 diagram 元素(带 data-source),让 TipTap DiagramCM.parseHTML 重建图表节点,
      // 而不是退化成代码块——这是"生成的图在编辑器里渲染成代码块"那个 bug 的修复点。
      return `<div data-pm-node="diagram" data-lang="${escAttr(section.lang)}" data-source="${escAttr(section.source)}"${section.overlay ? ` data-overlay="${escAttr(JSON.stringify(section.overlay))}"` : ""}></div>`;
    case "penNote":
      return `<aside data-pm-node="penNote" class="pm-pen-note">${section.spans ? section.spans.map(spanToText).join("") : esc(section.text)}</aside>`;
	    case "image": {
	      const align = normalizeImageAlign(section.align);
	      const width = positiveImageSize(section.width);
	      const height = positiveImageSize(section.height);
	      const caption = section.caption ? `<figcaption class="wf-img-cap">${esc(section.caption)}</figcaption>` : "";
	      const imgAttrs = [
	        `src="${escAttr(section.src)}"`,
	        `alt="${escAttr(section.alt)}"`,
	        `data-align="${align}"`,
	        section.caption ? `data-caption="${escAttr(section.caption)}"` : "",
	        width ? `width="${width}"` : "",
	        height ? `height="${height}"` : "",
	        `style="${escAttr(imageHtmlStyle(width, align))}"`,
	      ].filter(Boolean).join(" ");
	      return `<figure data-pm-node="image" data-align="${align}" style="margin:16px 0"><img ${imgAttrs}/>${caption}</figure>`;
	    }
    case "fileAttachment":
      return `<p><a data-pm-node="fileAttachment" href="/api/v1/files/${escAttr(section.fileId)}/${escAttr(section.filename)}">${esc(section.filename)}</a></p>`;
    // 保真块:把原始 pm 节点经 pmToClipboardHtml 序列化成 TipTap 可重解析的 HTML
    // (native diff 动画 seeding 用),与最终态一致。
    case "taskList":
    case "callout":
    case "columnList":
    case "math":
      return faithfulNodeToHtml(section.node);
  }
}

/** 把单个保真 pm 节点包成最小 doc 序列化成 HTML(供 native diff 动画路径重建节点)。 */
function faithfulNodeToHtml(node: PmBlockNode): string {
  return pmToClipboardHtml({ type: "doc", attrs: { schemaVersion: 1 }, content: [node] });
}

function spanToText(span: ViewDocSpan): string {
  if (span.kind === "math" || span.kind === "patchInsMath" || span.kind === "patchDelMath") {
    return inlineMathToHtml(span.latex);
  }
  return esc(span.text);
}

function spanToTextRaw(span: ViewDocSpan): string {
  return viewDocSpanText(span);
}

function hasPatchSpan(spans: readonly ViewDocSpan[] | undefined): boolean {
  return spans?.some((span) =>
    span.kind === "patchDel" ||
    span.kind === "patchIns" ||
    span.kind === "patchDelMath" ||
    span.kind === "patchInsMath" ||
    span.kind === "patchMark",
  ) ?? false;
}

function inlineMathToHtml(latex: string): string {
  const escaped = esc(latex);
  return `<span data-type="inline-math" data-latex="${escAttr(latex)}">$${escaped}$</span>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function positiveImageSize(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function imageHtmlStyle(width: number | null, align: "left" | "center" | "right"): string {
  const parts = ["max-width:100%", "height:auto", "display:block"];
  if (width) parts.push(`width:${width}px`);
  if (align === "center") parts.push("margin-left:auto", "margin-right:auto");
  if (align === "left") parts.push("margin-right:auto");
  if (align === "right") parts.push("margin-left:auto");
  return parts.join("; ");
}
