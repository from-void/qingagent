import {
  legacySectionsToPm,
  type LegacyLegacySection,
  type LegacyListSectionLike,
  type LegacyTaskItem,
} from "../legacy/legacySectionsToPm";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark } from "../types";

type ParsedMarkdownListKind = "bullet" | "ordered" | "task";

interface ParsedMarkdownListLine {
  level: number;
  kind: ParsedMarkdownListKind;
  text: string;
  checked?: boolean;
}

interface ParsedMarkdownList {
  kind: ParsedMarkdownListKind;
  items: ParsedMarkdownListItem[];
}

interface ParsedMarkdownListItem {
  text: string;
  checked?: boolean;
  children: ParsedMarkdownList[];
}

export function markdownToPm(markdown: string): PmDoc {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: LegacyLegacySection[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;

    if (line.trim() === "$$") {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] ?? "").trim() !== "$$") {
        body.push(lines[i] ?? "");
        i += 1;
      }
      sections.push({ kind: "p", data: { text: `$$\n${body.join("\n")}\n$$` } });
      continue;
    }

    const singleLineMath = line.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (singleLineMath) {
      sections.push({ kind: "p", data: { text: `$$\n${singleLineMath[1] ?? ""}\n$$` } });
      continue;
    }

    const codeMatch = line.match(/^```(\S+)?\s*$/);
    if (codeMatch) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      sections.push({ kind: "code", data: { body: body.join("\n"), language: codeMatch[1] ?? "plaintext" } });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const text = headingMatch[2] ?? "";
      sections.push({ kind: `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6", data: { text } });
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      sections.push({ kind: "hr", data: {} });
      continue;
    }

    const imageMatch = line.match(/^!\[(.*)]\((.+)\)$/);
    if (imageMatch) {
      sections.push({ kind: "image", data: { alt: imageMatch[1] ?? "", src: imageMatch[2] ?? "", caption: null } });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      let cursor = i;
      while (cursor < lines.length && /^\s*>\s?/.test(lines[cursor] ?? "")) {
        quoteLines.push((lines[cursor] ?? "").replace(/^\s*>\s?/, ""));
        cursor += 1;
      }
      sections.push({ kind: "quote", data: { text: quoteLines.join("\n") } });
      i = cursor - 1;
      continue;
    }

    if (isPipeTableHeader(lines, i)) {
      const head = splitPipeTableRow(line);
      const rows: string[][] = [];
      let cursor = i + 2;
      while (cursor < lines.length && isPipeTableRow(lines[cursor] ?? "")) {
        rows.push(splitPipeTableRow(lines[cursor] ?? ""));
        cursor += 1;
      }
      sections.push({ kind: "table", data: { head, rows } });
      i = cursor - 1;
      continue;
    }

    const listLine = parseMarkdownListLine(line);
    if (listLine) {
      const parsed = parseMarkdownList(lines, i, listLine.level, listLine.kind);
      sections.push(markdownListToLegacySection(parsed.list));
      i = parsed.next - 1;
      continue;
    }

    sections.push({ kind: "p", data: { text: line } });
  }

  return withParsedMarkdownInlines(legacySectionsToPm(sections));
}

function parseMarkdownList(
  lines: readonly string[],
  start: number,
  level: number,
  kind: ParsedMarkdownListKind,
): { list: ParsedMarkdownList; next: number } {
  const list: ParsedMarkdownList = { kind, items: [] };
  let cursor = start;

  while (cursor < lines.length) {
    const parsed = parseMarkdownListLine(lines[cursor] ?? "");
    if (!parsed || parsed.level < level || parsed.kind !== kind) break;
    if (parsed.level > level) {
      const lastItem = list.items[list.items.length - 1];
      if (!lastItem) break;
      const child = parseMarkdownList(lines, cursor, parsed.level, parsed.kind);
      lastItem.children.push(child.list);
      cursor = child.next;
      continue;
    }

    const item: ParsedMarkdownListItem = {
      text: parsed.text,
      checked: parsed.checked,
      children: [],
    };
    cursor += 1;

    while (cursor < lines.length) {
      const childLine = parseMarkdownListLine(lines[cursor] ?? "");
      if (!childLine || childLine.level <= level) break;
      const child = parseMarkdownList(lines, cursor, childLine.level, childLine.kind);
      item.children.push(child.list);
      cursor = child.next;
    }

    list.items.push(item);
  }

  return { list, next: cursor };
}

function parseMarkdownListLine(line: string): ParsedMarkdownListLine | null {
  const ordered = line.match(/^([ \t]*)(\d+)\.\s+(.+)$/);
  if (ordered) {
    return {
      level: indentLevel(ordered[1] ?? ""),
      kind: "ordered",
      text: ordered[3] ?? "",
    };
  }

  const task = line.match(/^([ \t]*)[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (task) {
    const marker = task[2] ?? " ";
    return {
      level: indentLevel(task[1] ?? ""),
      kind: "task",
      checked: marker === "x" || marker === "X",
      text: task[3] ?? "",
    };
  }

  const bullet = line.match(/^([ \t]*)[-*]\s+(.+)$/);
  if (bullet) {
    return {
      level: indentLevel(bullet[1] ?? ""),
      kind: "bullet",
      text: bullet[2] ?? "",
    };
  }

  return null;
}

function indentLevel(prefix: string): number {
  let columns = 0;
  for (const char of prefix) columns += char === "\t" ? 2 : 1;
  return Math.floor(columns / 2);
}

function markdownListToLegacySection(list: ParsedMarkdownList): LegacyListSectionLike {
  if (list.kind === "task") {
    return {
      kind: "taskList",
      data: {
        items: list.items.map(markdownTaskItemToLegacy),
      },
    };
  }

  return {
    kind: "list",
    data: {
      ordered: list.kind === "ordered",
      items: list.items.map((item) => ({
        text: item.text,
        children: item.children.map(markdownListToLegacySection),
      })),
    },
  };
}

function markdownTaskItemToLegacy(item: ParsedMarkdownListItem): LegacyTaskItem {
  return {
    text: item.text,
    checked: item.checked === true,
    children: item.children.flatMap<LegacyTaskItem | LegacyListSectionLike>((child) =>
      child.kind === "task"
        ? child.items.map(markdownTaskItemToLegacy)
        : [markdownListToLegacySection(child)],
    ),
  };
}

function withParsedMarkdownInlines(doc: PmDoc): PmDoc {
  return {
    ...doc,
    content: doc.content.map(parseBlockMarkdownInlines),
  };
}

function parseBlockMarkdownInlines(node: PmBlockNode): PmBlockNode {
  const mathBlock = maybeConvertMathParagraph(node);
  if (mathBlock.type === "blockMath") return mathBlock;

  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
      return {
        ...node,
        content: parseInlineNodes(node.content),
      };
    case "blockquote":
      return { ...node, content: node.content.map(parseBlockMarkdownInlines) };
    case "bulletList":
    case "orderedList":
      return {
        ...node,
        content: node.content.map((item) => ({
          ...item,
          content: item.content.map(parseBlockMarkdownInlines),
        })),
      };
    case "taskList":
      return {
        ...node,
        content: node.content.map((item) => ({
          ...item,
          content: item.content.map(parseBlockMarkdownInlines) as typeof item.content,
        })),
      };
    case "table":
      return {
        ...node,
        content: node.content.map((row) => ({
          ...row,
          content: row.content.map((cell) => ({
            ...cell,
            content: cell.content.map(parseBlockMarkdownInlines),
          })),
        })),
      };
    case "callout":
      return { ...node, content: node.content.map(parseBlockMarkdownInlines) as typeof node.content };
    case "blockMath":
      return node;
    default:
      return node;
  }
}

function maybeConvertMathParagraph(node: PmBlockNode): PmBlockNode {
  if (node.type !== "paragraph") return node;
  const text = (node.content ?? [])
    .map((child) => (child.type === "text" ? child.text : ""))
    .join("");
  const math = text.match(/^\$\$\n([\s\S]*)\n\$\$$/);
  if (!math) return node;
  return {
    type: "blockMath",
    attrs: { ...node.attrs, latex: math[1] ?? "" },
  };
}

function parseInlineNodes(content: readonly PmInlineNode[] | undefined): PmInlineNode[] | undefined {
  if (!content?.length) return content ? [] : undefined;
  const out: PmInlineNode[] = [];
  for (const node of content) {
    if (node.type !== "text") {
      out.push(node);
      continue;
    }
    out.push(...parseInlineMarkdown(node.text));
  }
  return out;
}

function parseInlineMarkdown(text: string): PmInlineNode[] {
  const nodes: PmInlineNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const match = nextInlineToken(text, cursor);
    if (!match) {
      pushText(nodes, text.slice(cursor));
      break;
    }
    if (match.index > cursor) pushText(nodes, text.slice(cursor, match.index));
    if (match.kind === "code") {
      nodes.push({ type: "text", text: match.body, marks: [{ type: "code" }] });
    } else if (match.kind === "bold") {
      nodes.push(...addInlineMark(parseInlineMarkdown(match.body), { type: "bold" }));
    } else if (match.kind === "italic") {
      nodes.push(...addInlineMark(parseInlineMarkdown(match.body), { type: "italic" }));
    } else {
      nodes.push({ type: "inlineMath", attrs: { latex: match.body } });
    }
    cursor = match.end;
  }
  return nodes;
}

/**
 * 粗体/斜体包裹的内容仍要先识别行内 code 与数学公式。持久 PM 合同禁止 inlineMath 带 mark，
 * 而 Tiptap 的 code mark 又排斥其它 mark，因此这两类叶子节点保持原样。
 */
function addInlineMark(nodes: readonly PmInlineNode[], mark: Extract<PmMark, { type: "bold" | "italic" }>): PmInlineNode[] {
  return nodes.map((node) => {
    if (node.type !== "text" || node.marks?.some((current) => current.type === "code")) return node;
    const marks = node.marks ?? [];
    if (marks.some((current) => current.type === mark.type)) return node;
    // 内层 mark 在前、外层 mark 在后，既稳定又与 markdown 序列化的包裹顺序一致。
    return { ...node, marks: [...marks, mark] };
  });
}

type InlineMatch = {
  kind: "code" | "bold" | "italic" | "math";
  index: number;
  end: number;
  body: string;
};

function nextInlineToken(text: string, from: number): InlineMatch | null {
  const candidates: InlineMatch[] = [];
  const code = boundedToken(text, from, "`", "`", "code");
  if (code) candidates.push(code);
  const bold = boundedToken(text, from, "**", "**", "bold");
  if (bold) candidates.push(bold);
  const italic = boundedToken(text, from, "*", "*", "italic", { avoidDoubleAsterisk: true });
  if (italic) candidates.push(italic);
  const math = boundedToken(text, from, "$", "$", "math", { avoidDoubleDollar: true });
  if (math) candidates.push(math);
  candidates.sort((a, b) => a.index - b.index || a.end - b.end);
  return candidates[0] ?? null;
}

function boundedToken(
  text: string,
  from: number,
  open: string,
  close: string,
  kind: InlineMatch["kind"],
  options: { avoidDoubleAsterisk?: boolean; avoidDoubleDollar?: boolean } = {},
): InlineMatch | null {
  let index = text.indexOf(open, from);
  while (index >= 0) {
    if (
      (options.avoidDoubleAsterisk && (text[index - 1] === "*" || text[index + 1] === "*")) ||
      (options.avoidDoubleDollar && (text[index - 1] === "$" || text[index + 1] === "$"))
    ) {
      index = text.indexOf(open, index + 1);
      continue;
    }
    const bodyStart = index + open.length;
    let end = text.indexOf(close, bodyStart);
    while (end > bodyStart) {
      // 例如 **斜体*嵌套*** 的尾部三个 *：第一个 * 属于内层斜体，粗体应取最后两个 *。
      if (kind === "bold" && text[end + close.length] === "*") {
        end = text.indexOf(close, end + 1);
        continue;
      }
      const body = text.slice(bodyStart, end);
      if (!/^\s|\s$/.test(body)) {
        return { kind, index, end: end + close.length, body };
      }
      end = text.indexOf(close, end + 1);
    }
    index = text.indexOf(open, index + 1);
  }
  return null;
}

function pushText(nodes: PmInlineNode[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === "text" && !last.marks?.length) {
    last.text += text;
    return;
  }
  nodes.push({ type: "text", text });
}

function isPipeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.replace(/\\\|/g, "").includes("|");
}

function isPipeTableSeparator(line: string): boolean {
  const cells = splitPipeTableRow(line);
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
  );
}

function isPipeTableHeader(lines: readonly string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return isPipeTableRow(current) && isPipeTableSeparator(next);
}

function splitPipeTableRow(line: string): string[] {
  const sentinel = "\u0000PIPE\u0000";
  const protectedLine = line.trim().replace(/\\\|/g, sentinel);
  const trimmed = protectedLine.replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split("|")
    .map((cell) => cell.replaceAll(sentinel, "|").trim());
}
