import { pmToPlainText } from "../pmToPlainText";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark } from "../types";

export function pmToMarkdown(doc: PmDoc): string {
  return doc.content.map(blockToMarkdown).filter(Boolean).join("\n\n");
}

function blockToMarkdown(node: PmBlockNode): string {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(node.attrs.level)} ${inlineText(node.content ?? [])}`;
    case "paragraph":
      return inlineText(node.content ?? []);
    case "blockquote":
      return node.content
        .map((child) =>
          blockToMarkdown(child)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        )
        .join("\n");
    case "bulletList":
      return listToMarkdown(node, 0);
    case "orderedList":
      return listToMarkdown(node, 0);
    case "horizontalRule":
      return "---";
    case "codeBlock":
      return `\`\`\`${node.attrs.language ?? "plaintext"}\n${inlineText(node.content ?? [])}\n\`\`\``;
    case "table":
      return tableToMarkdown(node);
    case "image":
      return `![${node.attrs.alt ?? ""}](${node.attrs.src})`;
    case "fileAttachment":
      return `[附件: ${node.attrs.filename}](/api/v1/files/${node.attrs.fileId})`;
    case "penNote":
      return inlineText(node.content ?? []);
    case "taskList":
      return listToMarkdown(node, 0);
    case "callout":
      return node.content
        .map((child) =>
          blockToMarkdown(child)
            .split("\n")
            .map((line, index) => (index === 0 ? `> ${node.attrs.emoji ?? "💡"} ${line}` : `> ${line}`))
            .join("\n"),
        )
        .join("\n");
    case "columnList":
      // markdown 无分栏概念 → 拍平:各栏内的块按顺序串成普通块(布局有损,内容不丢)。
      return node.content
        .map((col) => col.content.map(blockToMarkdown).filter(Boolean).join("\n\n"))
        .filter(Boolean)
        .join("\n\n");
    case "blockMath":
      return `$$\n${node.attrs.latex}\n$$`;
    case "diagram":
      // 图表块 → 代码围栏(lang=mermaid),markdown 往返 + 飞书画板都吃这个形态。
      return `\`\`\`${node.attrs.lang}\n${node.attrs.source}\n\`\`\``;
  }
}

function listToMarkdown(
  node: Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>,
  depth: number,
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
            return listToMarkdown(child, depth + 1);
          }
          return blockToMarkdown(child)
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
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${delimiter}${body}${delimiter}`;
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
