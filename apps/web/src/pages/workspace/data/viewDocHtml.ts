import {
  flattenNestedTablesInCells,
  getDeterministicId,
  normalizePmDoc,
  pmToClipboardHtml,
  upgradeMermaidCodeBlocksToDiagram,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmParagraphNode,
  type PmTableCellNode,
  type PmTableNode,
  type PmTableRowNode,
  type PmTextAlign,
} from "@qingagent/pm-schema";
import { normalizeImageAlign } from "./imageAlign";
import { viewDocSpanText } from "./protocol";
import type { ViewBlock, ViewDocSpan, ViewDocumentSnapshot } from "./protocol";

export function viewDocToPm(doc: ViewDocumentSnapshot): PmDoc {
  // 装载侧安全网:把任何"伪装成代码块的 Mermaid/drawio"升级回 diagram 块,避免图表退化为死代码。
  // (用户报的「Mermaid 退回代码格式」)。命中 0 处时为结构等价克隆,不影响正常文档。
  const pmDoc = doc.pmDoc ?? normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: doc.sections.map((section, index) => viewBlockToPmNode(section, index)),
  });
  return flattenNestedTablesInCells(upgradeMermaidCodeBlocksToDiagram(pmDoc));
}

/** 标识同一 Editor 实例当前应承载的 canonical 正文，供异步 setContent 完成通知配对。 */
export function viewDocumentSyncRevision(doc: ViewDocumentSnapshot): string {
  return JSON.stringify(doc.pmDoc ?? doc.sections);
}

export function hasMissingPresentationBlockId(doc: unknown): boolean {
  let missing = false;
  const visit = (node: unknown, trailingScaffold = false) => {
    if (missing || !node || typeof node !== "object") return;
    const record = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (
      !trailingScaffold &&
      (record.type === "paragraph" || record.type === "listItem") &&
      !readNonEmptyBlockId(record.attrs)
    ) {
      missing = true;
      return;
    }
    if (!Array.isArray(record.content)) return;
    for (const [index, child] of record.content.entries()) {
      const childRecord = child && typeof child === "object"
        ? child as { type?: unknown; content?: unknown }
        : null;
      visit(
        child,
        record.type === "doc" &&
          index === record.content.length - 1 &&
          childRecord?.type === "paragraph" &&
          (!Array.isArray(childRecord.content) || childRecord.content.length === 0),
      );
    }
  };

  visit(doc);
  return missing;
}

function readNonEmptyBlockId(attrs: unknown): string | null {
  if (!attrs || typeof attrs !== "object") return null;
  const blockId = (attrs as { blockId?: unknown }).blockId;
  return typeof blockId === "string" && blockId.length > 0 ? blockId : null;
}

/** ViewBlock 的无 PM 文档兜底：直接构造规范块，不再经过第二套正文表示。 */
export function viewBlockToPmNode(section: ViewBlock, index = 0): PmBlockNode {
  switch (section.kind) {
    case "h1": {
      const text = section.spans?.map(spanToTextRaw).join("") ?? section.text;
      const blockId = viewBlockId(section, index, { kind: "h1", data: { text } });
      return heading(blockId, 1, text, undefined, section.textAlign);
    }
    case "h2": {
      const text = section.spans?.map(spanToTextRaw).join("") ?? section.text;
      const anchor = section.anchor ?? null;
      const blockId = viewBlockId(section, index, { kind: "h2", data: { text, anchor } });
      return heading(blockId, 2, text, anchor, section.textAlign);
    }
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = section.spans?.map(spanToTextRaw).join("") ?? section.text;
      const blockId = viewBlockId(section, index, { kind: section.kind, data: { text } });
      return heading(
        blockId,
        Number(section.kind.slice(1)) as 3 | 4 | 5 | 6,
        text,
        undefined,
        section.textAlign,
      );
    }
    case "p": {
      const text = section.spans.map(spanToTextRaw).join("");
      const blockId = viewBlockId(section, index, { kind: "p", data: { text } });
      return paragraph(blockId, text, section.textAlign);
    }
    case "quote": {
      if (section.node) return section.node;
      const blockId = viewBlockId(section, index, { kind: "quote", data: { text: section.text } });
      return {
        type: "blockquote",
        attrs: { blockId },
        content: [paragraph(`${blockId}-p`, section.text)],
      };
    }
    case "list": {
      if (section.node) return section.node;
      const blockId = viewBlockId(section, index, {
        kind: "list",
        data: { ordered: section.ordered, items: section.items },
      });
      const content = section.items.map((text, itemIndex) => {
        const itemBlockId = `${blockId}-item-${itemIndex + 1}`;
        return {
          type: "listItem" as const,
          attrs: { blockId: itemBlockId },
          content: [paragraph(`${itemBlockId}-p`, text)],
        };
      });
      return section.ordered
        ? {
            type: "orderedList",
            attrs: {
              blockId,
              start: section.start ?? 1,
              ...(section.listStyle ? { listStyle: section.listStyle } : {}),
            },
            content,
          }
        : { type: "bulletList", attrs: { blockId }, content };
    }
    case "hr": {
      const blockId = viewBlockId(section, index, { kind: "hr", data: {} });
      return { type: "horizontalRule", attrs: { blockId } };
    }
    case "table": {
      if (section.node) return section.node;
      const blockId = viewBlockId(section, index, {
        kind: "table",
        data: { head: section.head, rows: section.rows },
      });
      return table(blockId, section.head, section.rows);
    }
    case "code": {
      const language = section.language ?? "plaintext";
      const blockId = viewBlockId(section, index, {
        kind: "code",
        data: { body: section.body, language },
      });
      return {
        type: "codeBlock",
        attrs: { blockId, language },
        content: section.body ? [{ type: "text", text: section.body }] : [],
      };
    }
    case "diagram": {
      const blockId = viewBlockId(section, index, {
        kind: "diagram",
        data: { lang: section.lang, source: section.source, svg: section.svg },
      });
      return {
        type: "diagram",
        attrs: {
          blockId,
          lang: section.lang,
          source: section.source,
          svg: null,
          ...(section.overlay ? { overlay: section.overlay } : {}),
        },
      };
    }
    case "penNote": {
      const blockId = viewBlockId(section, index, { kind: "penNote", data: { text: section.text } });
      return {
        type: "penNote",
        attrs: { blockId },
        content: textContent(section.text),
      };
    }
	    case "image": {
        const align = section.align ?? "center";
        const blockId = viewBlockId(section, index, {
          kind: "image",
          data: {
            src: section.src,
            alt: section.alt,
            caption: section.caption,
            width: section.width,
            height: section.height,
            align,
          },
        });
	      return {
          type: "image",
          attrs: {
            blockId,
            src: section.src,
            alt: section.alt,
            caption: section.caption,
            width: section.width,
            height: section.height,
            align,
          },
	      };
    }
    case "fileAttachment": {
      const fallbackText = `附件：${section.filename}`;
      const blockId = viewBlockId(section, index, { kind: "p", data: { text: fallbackText } });
      return {
        type: "fileAttachment",
        attrs: {
          blockId,
          fileId: section.fileId,
          filename: section.filename,
          mimeType: section.mimeType,
          size: section.size,
        },
      };
    }
    // 保真块始终携带原始 PM node，兜底也直接复用，不再拍平成文字。
    case "taskList":
    case "callout":
    case "columnList":
    case "math":
      return section.node;
  }
}

function viewBlockId(section: ViewBlock, index: number, stableSeed: unknown): string {
  if (section.blockId?.trim()) return section.blockId;
  return getDeterministicId("block", { index, section: stableSeed });
}

function heading(
  blockId: string,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  text: string,
  anchor: string | null | undefined,
  textAlign: string | undefined,
): PmBlockNode {
  const normalizedTextAlign = normalizeTextAlign(textAlign);
  return {
    type: "heading",
    attrs: {
      blockId,
      level,
      ...(anchor === undefined ? {} : { anchor }),
      ...(normalizedTextAlign ? { textAlign: normalizedTextAlign } : {}),
    },
    content: textContent(text),
  };
}

function paragraph(blockId: string, text: string, textAlign?: string): PmParagraphNode {
  const normalizedTextAlign = normalizeTextAlign(textAlign);
  return {
    type: "paragraph",
    attrs: { blockId, ...(normalizedTextAlign ? { textAlign: normalizedTextAlign } : {}) },
    content: textContent(text),
  };
}

function textContent(text: string): PmInlineNode[] {
  return text ? [{ type: "text", text }] : [];
}

function normalizeTextAlign(value: string | undefined): PmTextAlign | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify"
    ? value
    : undefined;
}

function table(blockId: string, head: string[], rows: string[][]): PmTableNode {
  const columnCount = Math.max(head.length, ...rows.map((row) => row.length));
  const padRow = (row: string[]) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ""),
  ];
  const normalizedHead = head.length > 0 ? padRow(head) : head;
  const normalizedRows = rows.map(padRow);
  const headerRow: PmTableRowNode | null = normalizedHead.length
    ? {
        type: "tableRow",
        content: normalizedHead.map((cell, cellIndex) =>
          tableCell("tableHeader", `${blockId}-h-${cellIndex + 1}`, cell)),
      }
    : null;
  const bodyRows: PmTableRowNode[] = normalizedRows.map((row, rowIndex) => ({
    type: "tableRow",
    content: row.map((cell, cellIndex) =>
      tableCell("tableCell", `${blockId}-r-${rowIndex + 1}-${cellIndex + 1}`, cell)),
  }));
  return {
    type: "table",
    attrs: { blockId },
    content: headerRow ? [headerRow, ...bodyRows] : bodyRows,
  };
}

function tableCell(
  type: "tableCell" | "tableHeader",
  blockId: string,
  text: string,
): PmTableCellNode {
  return { type, content: [paragraph(`${blockId}-p`, text)] };
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
      if (
        section.node &&
        !section.itemSpans?.some((spans) => hasPatchSpan(spans))
      ) {
        return faithfulNodeToHtml(section.node);
      }
      const tag = section.ordered ? "ol" : "ul";
      const attrs = [
        section.ordered && section.start !== undefined
          ? ` start="${escAttr(String(section.start))}"`
          : "",
        section.ordered && section.listStyle
          ? ` data-list-style="${escAttr(section.listStyle)}" style="list-style-type: ${escAttr(section.listStyle)}"`
          : "",
      ].join("");
      return `<${tag}${attrs}>${section.items.map((item, i) => `<li><p>${section.itemSpans?.[i]?.length ? section.itemSpans[i]!.map(spanToText).join("") : esc(item)}</p></li>`).join("")}</${tag}>`;
    }
    case "hr":
      return "<hr />";
    case "table": {
      if (
        section.node &&
        !section.headSpans?.some((spans) => hasPatchSpan(spans)) &&
        !section.rowSpans?.some((row) =>
          row.some((spans) => hasPatchSpan(spans))
        )
      ) {
        return faithfulNodeToHtml(section.node);
      }
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
	        `data-align="${escAttr(align)}"`,
	        section.caption ? `data-caption="${escAttr(section.caption)}"` : "",
	        width ? `width="${escAttr(String(width))}"` : "",
	        height ? `height="${escAttr(String(height))}"` : "",
	        `style="${escAttr(imageHtmlStyle(width, align))}"`,
	      ].filter(Boolean).join(" ");
	      return `<figure data-pm-node="image" data-align="${escAttr(align)}" style="margin:16px 0"><img ${imgAttrs}/>${caption}</figure>`;
	    }
    case "fileAttachment":
      return [
        `<div data-pm-node="fileAttachment"`,
        section.blockId ? ` data-block-id="${escAttr(section.blockId)}"` : "",
        ` data-file-id="${escAttr(section.fileId)}"`,
        ` data-filename="${escAttr(section.filename)}"`,
        ` data-mime-type="${escAttr(section.mimeType)}"`,
        ` data-size="${escAttr(String(section.size))}">`,
        `<a href="${escAttr(`/api/v1/files/${encodeURIComponent(section.fileId)}`)}" download="${escAttr(section.filename)}">${esc(section.filename)}</a>`,
        "</div>",
      ].join("");
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
  if (
    span.kind === "footnote" ||
    span.kind === "patchInsFootnote" ||
    span.kind === "patchDelFootnote"
  ) {
    return `<sup data-pm-node="footnoteReference" data-footnote-id="${escAttr(span.id)}" data-footnote-note="${escAttr(span.note)}">※</sup>`;
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
    span.kind === "patchDelFootnote" ||
    span.kind === "patchInsFootnote" ||
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
