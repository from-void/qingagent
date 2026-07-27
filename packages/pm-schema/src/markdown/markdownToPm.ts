import {
  legacySectionsToPm,
  type LegacyLegacySection,
  type LegacyListSectionLike,
  type LegacyTaskItem,
} from "../legacy/legacySectionsToPm";
import type { PmBlockNode, PmDoc, PmInlineNode, PmMark } from "../types";
import { parseDocument } from "htmlparser2";
import { compileAiDocumentToPm } from "../ai-ir/aiIrToPm";
import { qingmlParse } from "../ai-ir/qingmlParse";
import { materializeDraftBlockIds } from "../ai-ir/draftBlockIds";
import { isAllowedLinkHref, isAllowedThemeColor } from "../validators";

type ParsedMarkdownListKind = "bullet" | "ordered" | "task";

interface ParsedMarkdownListLine {
  level: number;
  kind: ParsedMarkdownListKind;
  text: string;
  start?: number;
  checked?: boolean;
}

interface ParsedMarkdownList {
  kind: ParsedMarkdownListKind;
  start?: number;
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
  const htmlTables = new Map<string, PmBlockNode>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;

    if (/^\s*<table\b/i.test(line)) {
      const fragment: string[] = [line];
      while (!/<\/table\s*>/i.test(fragment.join("\n")) && i + 1 < lines.length) {
        fragment.push(lines[++i] ?? "");
      }
      const source = fragment.join("\n");
      const parsed = parseSafeHtmlTable(source);
      if (parsed) {
        const sentinel = `__QA_HTML_TABLE_${htmlTables.size}__`;
        htmlTables.set(sentinel, parsed);
        sections.push({ kind: "p", data: { text: sentinel } });
      } else {
        sections.push({ kind: "p", data: { text: source } });
      }
      continue;
    }

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

    const codeMatch = line.match(/^(`{3,})(\S+)?\s*$/);
    if (codeMatch) {
      const openingFenceLength = codeMatch[1]?.length ?? 3;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isClosingBacktickFence(lines[i] ?? "", openingFenceLength)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      sections.push({ kind: "code", data: { body: body.join("\n"), language: codeMatch[2] ?? "plaintext" } });
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
      const parsedHead = splitPipeTableRow(line);
      // 空表头行是 pmToMarkdown 为“无标题行表格”写出的 GFM 占位，不应反向造出标题行。
      const head = parsedHead.every((cell) => cell.trim() === "") ? [] : parsedHead;
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

    sections.push({ kind: "p", data: { text: unescapeParagraphBlockSyntax(line) } });
  }

  const base = legacySectionsToPm(sections);
  const replaced: PmDoc = {
    ...base,
    content: base.content.map((block) => {
      if (block.type !== "paragraph" || block.content?.length !== 1 || block.content[0]?.type !== "text") return block;
      return htmlTables.get(block.content[0].text) ?? block;
    }),
  };
  return materializeDraftBlockIds(withParsedMarkdownInlines(replaced), { namespace: "markdown.html-table" });
}

function unescapeParagraphBlockSyntax(line: string): string {
  return line
    .replace(
      /^([ \t]{0,3}\d+)(\\+)([.)])(?=[ \t]+)/,
      (_match, prefix: string, slashes: string, marker: string) =>
        `${prefix}${slashes.slice(1)}${marker}`,
    )
    .replace(
      /^([ \t]{0,3})(\\+)(?=(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|[-+*][ \t]+|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$))/,
      (_match, indent: string, slashes: string) => `${indent}${slashes.slice(1)}`,
    );
}

function isClosingBacktickFence(line: string, openingFenceLength: number): boolean {
  const match = line.match(/^(`+)\s*$/);
  return (match?.[1]?.length ?? 0) >= openingFenceLength;
}

type HtmlNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
};

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tr", "td", "th", "p", "ul", "ol", "li", "b", "strong", "em", "u", "del", "code", "a", "br"]);
const TABLE_ATTRS = new Set(["colspan", "rowspan", "colwidth", "data-bg-color", "href"]);

function parseSafeHtmlTable(source: string): PmBlockNode | null {
  if (source.length > 50_000 || !/<\/table\s*>\s*$/i.test(source.trim()) || !hasBalancedHtmlTableTags(source)) return null;
  try {
    const document = parseDocument(source, { lowerCaseTags: true, lowerCaseAttributeNames: true });
    const roots = (document.children as HtmlNode[]).filter((node) => node.type !== "text" || node.data?.trim());
    if (roots.length !== 1 || roots[0]?.type !== "tag" || roots[0].name !== "table") return null;
    const widths: Array<number[] | null> = [];
    const sanitized = sanitizeTableNode(roots[0], 0, widths);
    if (!sanitized) return null;
    const parsed = qingmlParse(sanitized);
    if (parsed.warnings.some((warning) => warning.severity === "bad-block") || parsed.blocks.length !== 1 || parsed.blocks[0]?.type !== "table") return null;
    const compiled = compileAiDocumentToPm({ blocks: parsed.blocks });
    if (!compiled.ok || !compiled.doc || compiled.doc.content[0]?.type !== "table") return null;
    let widthIndex = 0;
    const table = compiled.doc.content[0];
    return {
      ...table,
      content: table.content.map((row) => ({
        ...row,
        content: row.content.map((cell) => {
          const colwidth = widths[widthIndex++] ?? null;
          const colspan = cell.attrs?.colspan ?? 1;
          if (colwidth && colwidth.length !== colspan) throw new Error("colwidth 与 colspan 不一致");
          return { ...cell, attrs: { ...cell.attrs, colwidth } };
        }),
      })),
    };
  } catch {
    return null;
  }
}

function hasBalancedHtmlTableTags(source: string): boolean {
  const stack: string[] = [];
  const voidTags = new Set(["br"]);
  for (const match of source.matchAll(/<\s*(\/?)\s*([a-z][\w-]*)\b[^>]*>/gi)) {
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (voidTags.has(name) || /\/\s*>$/.test(match[0])) continue;
    if (!closing) {
      stack.push(name);
      if (stack.length > 32) return false;
    } else if (stack.pop() !== name) {
      return false;
    }
  }
  return stack.length === 0;
}

function sanitizeTableNode(node: HtmlNode, depth: number, widths: Array<number[] | null>): string | null {
  if (depth > 32) return null;
  if (node.type === "text") return escapeHtmlText(node.data ?? "");
  if (node.type !== "tag" || !node.name) return "";
  const name = node.name;
  if (name === "script" || name === "style") return "";
  const children = (node.children ?? []).map((child) => sanitizeTableNode(child, depth + 1, widths));
  if (children.some((child) => child === null)) return null;
  const inner = children.join("");
  if (!TABLE_TAGS.has(name)) return inner;
  const attrs = node.attribs ?? {};
  const outAttrs: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) continue;
    if (!TABLE_ATTRS.has(key)) continue;
    if (key === "href") {
      if (!isAllowedLinkHref(value)) continue;
      outAttrs.push(`href="${escapeHtmlAttr(value)}"`);
    } else if (key === "data-bg-color") {
      if (isAllowedThemeColor(value)) outAttrs.push(`bg="${escapeHtmlAttr(value)}"`);
    } else if (key === "colwidth") {
      // 结构编译后按物理 cell 顺序回填，不把非 QingML 属性传给解析器。
    } else if (/^[1-9]\d*$/.test(value)) {
      outAttrs.push(`${key}="${value}"`);
    } else {
      return null;
    }
  }
  if (name === "td" || name === "th") {
    const raw = attrs.colwidth;
    const parsed = raw && /^\d+(?:,\d+)*$/.test(raw) ? raw.split(",").map(Number) : null;
    if (raw && (!parsed || parsed.some((width) => !Number.isSafeInteger(width) || width <= 0))) return null;
    widths.push(parsed);
  }
  const tag = name === "strong" ? "b" : name;
  const attrText = outAttrs.length ? ` ${outAttrs.join(" ")}` : "";
  return tag === "br" ? `<br>` : `<${tag}${attrText}>${inner}</${tag}>`;
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function parseMarkdownList(
  lines: readonly string[],
  start: number,
  level: number,
  kind: ParsedMarkdownListKind,
): { list: ParsedMarkdownList; next: number } {
  const firstLine = parseMarkdownListLine(lines[start] ?? "");
  const list: ParsedMarkdownList = {
    kind,
    ...(kind === "ordered" && firstLine?.kind === "ordered" ? { start: firstLine.start } : {}),
    items: [],
  };
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
    const parsedStart = Number(ordered[2]);
    return {
      level: indentLevel(ordered[1] ?? ""),
      kind: "ordered",
      start: Number.isSafeInteger(parsedStart) && parsedStart > 0 ? parsedStart : 1,
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
      ...(list.kind === "ordered" ? { start: list.start } : {}),
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
    content: doc.content.map((node) => parseBlockMarkdownInlines(node)),
  };
}

function parseBlockMarkdownInlines(node: PmBlockNode, inTableCell = false): PmBlockNode {
  const mathBlock = maybeConvertMathParagraph(node);
  if (mathBlock.type === "blockMath") return mathBlock;

  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
      return {
        ...node,
        content: parseInlineNodes(node.content, inTableCell),
      };
    case "blockquote":
      return { ...node, content: node.content.map((child) => parseBlockMarkdownInlines(child)) };
    case "bulletList":
    case "orderedList":
      return {
        ...node,
        content: node.content.map((item) => ({
          ...item,
          content: item.content.map((child) => parseBlockMarkdownInlines(child)),
        })),
      };
    case "taskList":
      return {
        ...node,
        content: node.content.map((item) => ({
          ...item,
          content: item.content.map((child) => parseBlockMarkdownInlines(child)) as typeof item.content,
        })),
      };
    case "table":
      return {
        ...node,
        content: node.content.map((row) => ({
          ...row,
          content: row.content.map((cell) => ({
            ...cell,
            content: cell.content.map((block) => parseBlockMarkdownInlines(block, true)),
          })),
        })),
      };
    case "callout":
      return { ...node, content: node.content.map((child) => parseBlockMarkdownInlines(child)) as typeof node.content };
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

function parseInlineNodes(
  content: readonly PmInlineNode[] | undefined,
  parseTableBreaks = false,
): PmInlineNode[] | undefined {
  if (!content?.length) return content ? [] : undefined;
  const out: PmInlineNode[] = [];
  for (const node of content) {
    if (node.type !== "text") {
      out.push(node);
      continue;
    }
    if (!parseTableBreaks) {
      out.push(...parseInlineMarkdown(node.text));
      continue;
    }
    const parts = node.text.split(/<br\s*\/?>/gi);
    parts.forEach((part, index) => {
      if (index > 0) out.push({ type: "hardBreak" });
      out.push(...parseInlineMarkdown(part));
    });
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

/** 粗体/斜体包裹的内容仍先识别行内 code 与数学公式；Markdown 包裹仅映射到文本叶子。 */
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
