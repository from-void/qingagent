import { pmToPlainText } from "../pmToPlainText";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark } from "../types";
import { pmTableToHtml } from "../clipboard/pmToClipboardHtml";

export interface PmToMarkdownOptions {
  /** 导出文件中把 `/api/` 媒体地址解析成可离线访问的绝对 URL；不传则保持内部往返的相对地址。 */
  baseUrl?: string;
}

export function pmToMarkdown(doc: PmDoc, options: PmToMarkdownOptions = {}): string {
  return doc.content.map((node) => blockToMarkdown(node, options)).filter(Boolean).join("\n\n");
}

function blockToMarkdown(node: PmBlockNode, options: PmToMarkdownOptions): string {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${inlineText(node.content ?? [])}`;
    case "paragraph":
      return inlineText(node.content ?? []);
    case "blockquote":
      return node.content
        .map((child) =>
          blockToMarkdown(child, options)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        )
        .join("\n");
    case "bulletList":
      return listToMarkdown(node, 0, options);
    case "orderedList":
      return listToMarkdown(node, 0, options);
    case "horizontalRule":
      return "---";
    case "codeBlock":
      return fencedCodeBlock(node.attrs.language ?? "plaintext", inlineText(node.content ?? []));
    case "table":
      return tableToMarkdown(node);
    case "image":
      return `![${node.attrs.alt ?? ""}](${resolveExportUrl(node.attrs.src, options.baseUrl)})`;
    case "fileAttachment":
      return `[附件: ${node.attrs.filename}](${resolveExportUrl(`/api/v1/files/${node.attrs.fileId}`, options.baseUrl)})`;
    case "penNote":
      return inlineText(node.content ?? []);
    case "taskList":
      return listToMarkdown(node, 0, options);
    case "callout":
      return node.content
        .map((child) =>
          blockToMarkdown(child, options)
            .split("\n")
            .map((line, index) => (index === 0 ? `> ${node.attrs.emoji ?? "💡"} ${line}` : `> ${line}`))
            .join("\n"),
        )
        .join("\n");
    case "columnList":
      // markdown 无分栏概念 → 拍平:各栏内的块按顺序串成普通块(布局有损,内容不丢)。
      return node.content
        .map((col) => col.content.map((child) => blockToMarkdown(child, options)).filter(Boolean).join("\n\n"))
        .filter(Boolean)
        .join("\n\n");
    case "blockMath":
      return `$$\n${node.attrs.latex}\n$$`;
    case "diagram":
      // 图表块 → 对应语言的安全动态围栏，保留 Mermaid/drawio 源码以便 Markdown 往返。
      return fencedCodeBlock(node.attrs.lang, node.attrs.source);
  }
}

function listToMarkdown(
  node: Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>,
  depth: number,
  options: PmToMarkdownOptions,
): string {
  const start = node.type === "orderedList" ? node.attrs.start ?? 1 : 1;
  return node.content
    .map((item, index) => {
      const indent = "  ".repeat(depth);
      const marker = node.type === "orderedList"
        ? `${start + index}.`
        : node.type === "taskList"
          ? `- [${"checked" in item.attrs && item.attrs.checked ? "x" : " "}]`
          : "-";
      const [first, ...rest] = item.content;
      const firstText = first ? blockToListItemText(first) : "";
      const head = `${indent}${marker}${firstText ? ` ${firstText}` : ""}`;
      const tail = rest
        .map((child) => {
          if (child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList") {
            return listToMarkdown(child, depth + 1, options);
          }
          return blockToMarkdown(child, options)
            .split("\n")
            .map((line) => `${"  ".repeat(depth + 1)}${line}`)
            .join("\n");
        })
        .filter(Boolean);
      return [head, ...tail].join("\n");
    })
    .join("\n");
}

function blockToListItemText(node: PmBlockNode): string {
  if (node.type === "paragraph" || node.type === "heading" || node.type === "penNote") {
    return inlineText(node.content ?? []);
  }
  return pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [node] });
}

function inlineText(content: readonly PmInlineNode[]): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return `$${node.attrs?.latex ?? ""}$`;
      return markedText(node.text, node.marks ?? []);
    })
    .join("");
}

function markedText(text: string, marks: readonly PmMark[]): string {
  let value = text;
  for (const mark of [...marks].reverse()) {
    value = wrapMark(value, mark);
  }
  return value;
}

function wrapMark(text: string, mark: PmMark): string {
  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `*${text}*`;
    case "code":
      return inlineCode(text);
    case "strike":
      return `~~${text}~~`;
    case "underline":
      return `<u>${text}</u>`;
    case "highlight": {
      const color = mark.attrs?.color;
      return color ? `<mark data-color="${color}">${text}</mark>` : `<mark>${text}</mark>`;
    }
    case "textColor": {
      const color = mark.attrs?.color;
      return color ? `<span data-text-color="${color}">${text}</span>` : text;
    }
    case "link": {
      const href = mark.attrs.href.trim();
      if (!href) return text;
      return `[${escapeLinkText(text)}](${escapeLinkHref(href)})`;
    }
  }
}

function escapeLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeLinkHref(href: string): string {
  return href.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

function inlineCode(text: string): string {
  const longestRun = longestBacktickRun(text);
  const delimiter = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${delimiter}${body}${delimiter}`;
}

function fencedCodeBlock(language: string, content: string): string {
  // CommonMark:围栏至少 3 个反引号，且闭围栏不得短于开围栏。比正文最长连续反引号多 1
  // 可确保正文中的 ``` / ```` 永远不会被误认成当前块的闭围栏。
  // 正文已有尾换行时不再额外补一行，避免严格 Markdown 往返凭空产生空行。
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
}

function resolveExportUrl(value: string, baseUrl: string | undefined): string {
  if (!baseUrl || !value.startsWith("/api/")) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    // 调用方传入非法 baseUrl 时不应破坏导出；退回原相对地址与旧行为一致。
    return value;
  }
}

// 单元格序列化:保留行内 marks(加粗/链接/行内代码等)。
// 原先用 pmToPlainText 会丢弃所有 marks(e2e E5/E6:导出 md 表格 cell 丢加粗/链接);
// 改为对 cell 内含行内内容的块(paragraph/heading)走 inlineText(经 markedText 保留 marks),
// 非行内块(罕见)回退纯文本;多段以 <br> 连接。
function tableCellToMarkdown(cell: { content: readonly PmBlockNode[] }): string {
  const parts = cell.content.map((block) => {
    const inline = (block as { content?: readonly PmInlineNode[] }).content;
    if (Array.isArray(inline) && (block.type === "paragraph" || block.type === "heading")) {
      return inlineText(inline);
    }
    return pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: [block] });
  });
  return parts.join("\n");
}

function tableToMarkdown(node: Extract<PmBlockNode, { type: "table" }>): string {
  const hasSpan = node.content.some((row) => row.content.some((cell) =>
    (cell.attrs?.colspan ?? 1) > 1 || (cell.attrs?.rowspan ?? 1) > 1,
  ));
  if (hasSpan) return pmTableToHtml(node);
  const rows = node.content.map((row) =>
    row.content.map((cell) =>
      tableCellToMarkdown(cell)
        .replace(/\r\n?/g, "\n")
        .replace(/\n/g, "<br>")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const firstRow = node.content[0];
  const hasHeaderRow = Boolean(
    firstRow &&
    firstRow.content.length > 0 &&
    firstRow.content.every((cell) => cell.type === "tableHeader"),
  );
  const header = hasHeaderRow
    ? rows[0] ?? []
    : Array.from({ length: rows[0]?.length ?? 0 }, () => "");
  const body = hasHeaderRow ? rows.slice(1) : rows;
  const separator = header.map(() => "---");
  return [header, separator, ...body]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}
