import { parseDocument } from "htmlparser2";
import type { ZodError } from "zod";
import {
  PM_CALLOUT_TONES,
  PM_HIGHLIGHT_COLORS,
  PM_IMAGE_ALIGN_VALUES,
  PM_ORDERED_LIST_STYLES,
  PM_TEXT_ALIGN_VALUES,
  PM_TEXT_COLORS,
} from "../spec";
import { isAllowedLinkHref } from "../validators";
import {
  aiBlockSchema,
  aiListItemSchema,
  aiTableCellSchema,
  aiTaskListItemSchema,
  type AiBlock,
  type AiColumn,
  type AiListItem,
  type AiRun,
  type AiTextRun,
  type AiRunMark,
  type AiTableCell,
  type AiTaskListItem,
} from "./aiIrSchema";

export interface QingmlWarning {
  kind: string;
  severity: "harmless" | "bad-block";
  detail: string;
  diagnostic?: {
    /** 只含白名单标签名；未知外壳名、正文和属性值均不进入诊断。 */
    tagSkeleton: string;
    badBlockCountBefore: number;
    badBlockCountAfter: number;
  };
  location?: {
    startOffset?: number;
    endOffset?: number;
    path?: Array<string | number>;
  };
}

export type FragmentAction =
  | "replaceBlock"
  | "insertBlock"
  | "replaceListItem"
  | "insertListItem"
  | "insertTableRow"
  | "insertTableColumn";

export type QingmlFragmentResult =
  | { ok: true; kind: "blocks"; blocks: AiBlock[]; warnings: QingmlWarning[] }
  | { ok: true; kind: "listItem"; item: AiListItem | AiTaskListItem; warnings: QingmlWarning[] }
  | { ok: true; kind: "row"; cells: AiTableCell[]; warnings: QingmlWarning[] }
  | { ok: true; kind: "column"; cells: AiTableCell[]; warnings: QingmlWarning[] }
  | { ok: false; error: string; warnings: QingmlWarning[] };

type DomNode = {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  data?: string;
  children?: DomNode[];
  startIndex?: number | null;
  endIndex?: number | null;
};

type DomElement = DomNode & {
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
};

type ParseContext = {
  warnings: QingmlWarning[];
  warningKeys: Set<string>;
  source: string;
};

type InlineOptions = {
  paragraphBreaks?: boolean;
  inlineOnlyTag?: string;
};

const BLOCK_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "tasks",
  "blockquote",
  "hr",
  "pre",
  "table",
  "callout",
  "columns",
  "mermaid",
  "drawio",
  "math-block",
  "img",
  "file",
  "pennote",
]);

const INLINE_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "code",
  "a",
  "mark",
  "color",
  "math",
  "footnote",
  "br",
]);

const STRUCTURAL_TAGS = new Set([
  "title",
  "li",
  "task",
  "tr",
  "td",
  "th",
  "column",
  ...BLOCK_TAGS,
]);

const SAFE_QINGML_SKELETON_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "task",
  "tr",
  "td",
  "th",
  "column",
  ...STRUCTURAL_TAGS,
  ...INLINE_TAGS,
]);

const UNSUPPORTED_NESTED_TABLE_DETAIL =
  "表中表是不被支持的结构：<td>/<th> 单元格内不能包含 <table>。" +
  "请保留原有内容，把内层表移到外层表之后拆成独立表格，并在原单元格标明关联；" +
  "若只需表达层级，则改用单元格内的嵌套 <ul>/<ol>。压缩正文篇幅不能修复此错误。";

/**
 * 只保留 QingML 标签骨架：正文、属性值和非白名单标签名均不进诊断帧。
 * 输出按节点数封顶，避免超长/恶意输入把失败帧撑大。
 */
export function qingmlTagSkeleton(text: string, maxTags = 64): string {
  const document = parseDocument(text, {
    decodeEntities: false,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
  }) as unknown as DomNode;
  const limit = Math.max(1, Math.floor(maxTags));
  const tokens: string[] = [];
  let seen = 0;
  let truncated = false;

  const visit = (node: DomNode): void => {
    if (truncated) return;
    if (!isTag(node)) {
      node.children?.forEach(visit);
      return;
    }
    if (seen >= limit) {
      truncated = true;
      return;
    }
    seen += 1;
    const name = SAFE_QINGML_SKELETON_TAGS.has(node.name) ? node.name : "unknown";
    tokens.push(`<${name}>`);
    node.children.forEach(visit);
    if (!QINGML_VOID_TAGS.has(name)) tokens.push(`</${name}>`);
  };

  document.children?.forEach(visit);
  return `${tokens.join("")}${truncated ? "…" : ""}`;
}

export function qingmlParse(text: string): { title: string | null; blocks: AiBlock[]; warnings: QingmlWarning[] } {
  const ctx = createContext();
  const nodes = parseQingmlNodes(text, ctx);
  const preprocessingWarnings = [...ctx.warnings];
  const original = parseQingmlDocumentNodes(nodes, ctx, text);
  const wrapper = singleUnknownDocumentWrapper(nodes);
  if (!wrapper) return original;

  // 容错只尝试当前最外层一次；候选解析不会再次进入 qingmlParse，避免递归剥壳。
  const strippedCtx = createContext();
  strippedCtx.source = ctx.source;
  for (const warning of preprocessingWarnings) {
    warn(
      strippedCtx,
      warning.kind,
      warning.severity,
      warning.detail,
      warning.location,
      warning.diagnostic,
    );
  }
  const stripped = parseQingmlDocumentNodes(wrapper.children, strippedCtx, ctx.source);
  const badBlockCountBefore = countBadBlockWarnings(original.warnings);
  const badBlockCountAfter = countBadBlockWarnings(stripped.warnings);
  if (badBlockCountAfter >= badBlockCountBefore) return original;

  warn(
    strippedCtx,
    "document-wrapper-stripped",
    "harmless",
    "检测到单个未知顶层容器；剥掉最外层后结构错误减少，已采用剥壳结果。",
    domNodeLocation(wrapper),
    {
      tagSkeleton: qingmlTagSkeleton(ctx.source),
      badBlockCountBefore,
      badBlockCountAfter,
    },
  );
  return stripped;
}

function parseQingmlDocumentNodes(
  nodes: readonly DomNode[],
  ctx: ParseContext,
  sourceText: string,
): { title: string | null; blocks: AiBlock[]; warnings: QingmlWarning[] } {
  let title: string | null = null;
  const contentNodes: DomNode[] = [];
  const hasTopLevelBlock = nodes.some((node) => isTag(node) && isBlockTagName(node.name));

  for (const node of nodes) {
    if (isTag(node) && node.name === "title") {
      if (title === null) title = collapseInlineWhitespace(textContent(node.children)).trim() || null;
      continue;
    }
    if (hasTopLevelBlock && isText(node) && hasMeaningfulText(node.data ?? "")) {
      warn(ctx, "root-text-stripped", "harmless", "检测到块级 QingML 旁的顶层散文，按前导/收尾话剥壳忽略。");
      continue;
    }
    contentNodes.push(node);
  }

  const blocks = parseNodesAsBlocks(contentNodes, ctx);
  validateFootnoteDefinitions(blocks, ctx);
  if (!nodes.some(isTag) && hasMeaningfulText(sourceText)) {
    warn(ctx, "plain-text-document", "harmless", "输入没有 QingML 标签，按纯文本段落解析。");
  }
  return { title, blocks, warnings: ctx.warnings };
}

function singleUnknownDocumentWrapper(nodes: readonly DomNode[]): DomElement | null {
  const meaningfulNodes = nodes.filter((node) => !isIgnorable(node));
  if (meaningfulNodes.length !== 1) return null;
  const root = meaningfulNodes[0];
  if (!root || !isTag(root) || isKnownQingmlTagName(root.name)) return null;
  return containsStructuralTag(root.children) ? root : null;
}

function isKnownQingmlTagName(name: string): boolean {
  return isHeadingTag(name) || STRUCTURAL_TAGS.has(name) || INLINE_TAGS.has(name);
}

function countBadBlockWarnings(warnings: readonly QingmlWarning[]): number {
  return warnings.filter((warning) => warning.severity === "bad-block").length;
}

export function qingmlParseFragment(text: string, action: FragmentAction): QingmlFragmentResult {
  const ctx = createContext();
  const nodes = parseQingmlNodes(text, ctx);

  if (action === "replaceBlock" || action === "insertBlock") {
    const extracted = extractBlockFragmentRoots(nodes, ctx);
    if (!extracted.ok) return { ok: false, error: extracted.error, warnings: ctx.warnings };
    const blocks = parseNodesAsBlocks(extracted.nodes, ctx);
    if (blocks.length === 0) return { ok: false, error: "片段没有可用块级节点。", warnings: ctx.warnings };
    return { ok: true, kind: "blocks", blocks, warnings: ctx.warnings };
  }

  if (action === "replaceListItem" || action === "insertListItem") {
    const item = parseListItemFragment(nodes, ctx);
    if (!item.ok) return { ok: false, error: item.error, warnings: ctx.warnings };
    return { ok: true, kind: "listItem", item: item.item, warnings: ctx.warnings };
  }

  if (action === "insertTableRow") {
    const cells = parseTableRowFragment(nodes, ctx);
    if (!cells.ok) return { ok: false, error: cells.error, warnings: ctx.warnings };
    return { ok: true, kind: "row", cells: cells.cells, warnings: ctx.warnings };
  }

  const cells = parseTableColumnFragment(nodes, ctx);
  if (!cells.ok) return { ok: false, error: cells.error, warnings: ctx.warnings };
  return { ok: true, kind: "column", cells: cells.cells, warnings: ctx.warnings };
}

function createContext(): ParseContext {
  return { warnings: [], warningKeys: new Set(), source: "" };
}

function warn(
  ctx: ParseContext,
  kind: string,
  severity: QingmlWarning["severity"],
  detail: string,
  location?: QingmlWarning["location"],
  diagnostic?: QingmlWarning["diagnostic"],
): void {
  const key = `${kind}:${severity}:${detail}`;
  if (ctx.warningKeys.has(key)) return;
  ctx.warningKeys.add(key);
  ctx.warnings.push({
    kind,
    severity,
    detail,
    ...(diagnostic ? { diagnostic } : {}),
    ...(location ? { location } : {}),
  });
}

function parseQingmlNodes(text: string, ctx: ParseContext): DomNode[] {
  const stripped = stripFence(text, ctx);
  ctx.source = stripped;
  const document = parseDocument(stripped, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
    withStartIndices: true,
    withEndIndices: true,
  }) as unknown as DomNode;
  return document.children ?? [];
}

function stripFence(text: string, ctx: ParseContext): string {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const fence = /```(?:html|qingml|xml)?[ \t]*\n?([\s\S]*?)```/i.exec(withoutBom);
  if (!fence) return withoutBom;
  warn(ctx, "fence-stripped", "harmless", "检测到 fenced QingML，已剥掉代码围栏和围栏外文本。");
  return fence[1] ?? "";
}

function parseNodesAsBlocks(nodes: readonly DomNode[], ctx: ParseContext): AiBlock[] {
  const blocks: AiBlock[] = [];
  const inlineBuffer: DomNode[] = [];

  const flushInline = (): void => {
    const runs = parseInlineNodes(inlineBuffer, ctx);
    inlineBuffer.length = 0;
    if (runs.length === 0) return;
    acceptBlock(blocks, { type: "paragraph", runs }, ctx);
  };

  for (const node of nodes) {
    if (isIgnorable(node)) continue;
    if (isTag(node) && node.name === "title") continue;
    if (isTag(node) && isBlockTagName(node.name)) {
      flushInline();
      const block = parseBlockElement(node, ctx);
      if (block) acceptBlock(blocks, block, ctx);
      continue;
    }
    inlineBuffer.push(node);
  }

  flushInline();
  return blocks;
}

function parseBlockElement(element: DomElement, ctx: ParseContext): AiBlock | null {
  const name = element.name;
  if (isHeadingTag(name)) {
    const level = Number(name.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    const block: AiBlock = {
      type: "heading",
      level,
      runs: parseInlineNodes(element.children, ctx, { inlineOnlyTag: name }),
    };
    const textAlign = oneOf(PM_TEXT_ALIGN_VALUES, element.attribs.align);
    const anchor = optionalString(element.attribs.anchor);
    if (textAlign) block.textAlign = textAlign;
    if (anchor) block.anchor = anchor;
    return block;
  }

  switch (name) {
    case "p": {
      const block: AiBlock = {
        type: "paragraph",
        runs: parseInlineNodes(element.children, ctx, { inlineOnlyTag: name }),
      };
      const textAlign = oneOf(PM_TEXT_ALIGN_VALUES, element.attribs.align);
      if (textAlign) block.textAlign = textAlign;
      return block;
    }
    case "ul":
      return { type: "bulletList", items: parseListItems(element, ctx) };
    case "ol": {
      const block: AiBlock = { type: "orderedList", items: parseListItems(element, ctx) };
      const start = integer(element.attribs.start);
      const listStyle = oneOf(PM_ORDERED_LIST_STYLES, element.attribs.style);
      if (start !== undefined) block.start = start;
      if (listStyle) block.listStyle = listStyle;
      return block;
    }
    case "tasks":
      return { type: "taskList", items: parseTaskItems(element, ctx) };
    case "blockquote":
      return parseContainerBlock(element, ctx, "blockquote");
    case "hr":
      return { type: "horizontalRule" };
    case "pre":
      return { type: "codeBlock", language: optionalString(element.attribs.lang), text: rawTextElementText(element, ctx) };
    case "table":
      warnIfInvalidTableStructure(element, ctx);
      return { type: "table", rows: parseTableRows(element, ctx) };
    case "callout": {
      const block = parseContainerBlock(element, ctx, "callout");
      const emoji = optionalString(element.attribs.emoji);
      const tone = oneOf(PM_CALLOUT_TONES, element.attribs.tone);
      if (emoji) block.emoji = emoji;
      if (tone) block.tone = tone;
      return block;
    }
    case "columns":
      return { type: "columnList", columns: parseColumns(element, ctx) };
    case "mermaid":
      return { type: "diagram", lang: "mermaid", source: rawTextElementText(element, ctx).trim() };
    case "drawio":
      return { type: "diagram", lang: "drawio", source: rawTextElementText(element, ctx).trim() };
    case "math-block":
      return { type: "blockMath", latex: rawTextElementText(element, ctx).trim() };
    case "img": {
      const block: AiBlock = { type: "image", src: element.attribs.src ?? "" };
      const alt = optionalString(element.attribs.alt);
      const title = optionalString(element.attribs.title);
      const caption = optionalString(element.attribs.caption);
      const width = positiveInt(element.attribs.width);
      const height = positiveInt(element.attribs.height);
      const align = oneOf(PM_IMAGE_ALIGN_VALUES, element.attribs.align);
      if (alt) block.alt = alt;
      if (title) block.title = title;
      if (caption) block.caption = caption;
      if (width !== undefined) block.width = width;
      if (height !== undefined) block.height = height;
      if (align) block.align = align;
      return block;
    }
    case "file":
      return {
        type: "fileAttachment",
        fileId: element.attribs.id ?? "",
        filename: element.attribs.filename ?? "",
        mimeType: element.attribs.mime ?? element.attribs.mimetype ?? "",
        size: nonnegativeInt(element.attribs.size) ?? Number.NaN,
      };
    case "pennote":
      return { type: "penNote", runs: parseInlineNodes(element.children, ctx, { inlineOnlyTag: name }) };
    default:
      return null;
  }
}

function parseContainerBlock(
  element: DomElement,
  ctx: ParseContext,
  type: "blockquote",
): Extract<AiBlock, { type: "blockquote" }>;
function parseContainerBlock(
  element: DomElement,
  ctx: ParseContext,
  type: "callout",
): Extract<AiBlock, { type: "callout" }>;
function parseContainerBlock(
  element: DomElement,
  ctx: ParseContext,
  type: "blockquote" | "callout",
): Extract<AiBlock, { type: "blockquote" | "callout" }> {
  const hasStructuredChildren = element.children.some(
    (child) => isTag(child) && isBlockTagName(child.name),
  );
  if (hasStructuredChildren) {
    return { type, blocks: parseNodesAsBlocks(element.children, ctx) };
  }
  return {
    type,
    runs: parseInlineNodes(element.children, ctx, {
      paragraphBreaks: type === "blockquote",
      inlineOnlyTag: type,
    }),
  };
}

function parseListItems(element: DomElement, ctx: ParseContext): AiListItem[] {
  return element.children
    .filter(isTag)
    .filter((child) => child.name === "li")
    .map((li) => parseListItemElement(li, ctx));
}

function parseTaskItems(element: DomElement, ctx: ParseContext): AiTaskListItem[] {
  return element.children
    .filter(isTag)
    .filter((child) => child.name === "task")
    .map((task) => parseTaskItemElement(task, ctx));
}

function parseListItemElement(element: DomElement, ctx: ParseContext): AiListItem {
  const inlineNodes: DomNode[] = [];
  const children: AiBlock[] = [];
  let leadingParagraphs = true;

  for (const child of element.children) {
    if (isIgnorable(child)) continue;
    if (isTag(child) && (child.name === "ul" || child.name === "ol" || child.name === "tasks")) {
      leadingParagraphs = false;
      const block = parseBlockElement(child, ctx);
      if (block) acceptBlock(children, block, ctx);
      continue;
    }
    if (isTag(child) && child.name === "p" && leadingParagraphs) {
      appendSyntheticBreakIfNeeded(inlineNodes);
      inlineNodes.push(...child.children);
      continue;
    }
    if (isTag(child) && isBlockTagName(child.name)) {
      leadingParagraphs = false;
      const block = parseBlockElement(child, ctx);
      if (block) acceptBlock(children, block, ctx);
      continue;
    }
    inlineNodes.push(child);
  }

  const item: AiListItem = {
    runs: parseInlineNodes(inlineNodes, ctx, { inlineOnlyTag: element.name }),
  };
  if (children.length > 0) item.children = children;
  return item;
}

function parseTaskItemElement(element: DomElement, ctx: ParseContext): AiTaskListItem {
  const base = parseListItemElement(element, ctx);
  return { checked: booleanAttr(element.attribs.checked), runs: base.runs, ...(base.children ? { children: base.children } : {}) };
}

function parseTableRows(element: DomElement, ctx: ParseContext) {
  return tableRowElements(element).map((row) => {
    const cellElements = tableCellElements(row);
    const cells = cellElements.map((cell) => parseTableCell(cell, ctx));
    const allHeader = cellElements.length > 0 && cellElements.every((cell) => cell.name === "th");
    return { cells, ...(allHeader ? { header: true } : {}) };
  });
}

function parseTableCell(element: DomElement, ctx: ParseContext): AiTableCell {
  warnIfInvalidTableStructure(element, ctx);
  const parsedBlocks = parseNodesAsBlocks(element.children, ctx);
  const cell: AiTableCell = {
    // PM tableCell/tableHeader 要求 block+；旧式裸文本由 parseNodesAsBlocks 合成 paragraph，
    // 空 td/th 则在这里补一个空 paragraph。
    blocks: parsedBlocks.length > 0 ? parsedBlocks : [{ type: "paragraph", runs: [] }],
  };
  if (element.name === "th") cell.header = true;
  const bg = optionalString(element.attribs.bg);
  if (bg) cell.backgroundColor = bg;
  const colspan = tableSpanAttr(element, "colspan", ctx);
  const rowspan = tableSpanAttr(element, "rowspan", ctx);
  if (colspan !== undefined) cell.colspan = colspan;
  if (rowspan !== undefined) cell.rowspan = rowspan;
  return cell;
}

function tableSpanAttr(
  element: DomElement,
  name: "colspan" | "rowspan",
  ctx: ParseContext,
): number | undefined {
  const raw = element.attribs[name];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    warn(ctx, "invalid-table-span", "bad-block", `<${element.name}> 的 ${name} 必须是大于等于 1 的整数。`);
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    warn(ctx, "invalid-table-span", "bad-block", `<${element.name}> 的 ${name} 超出安全整数范围。`);
    return undefined;
  }
  return parsed;
}

const QINGML_VOID_TAGS = new Set(["br", "hr", "img", "file"]);

function warnIfInvalidTableStructure(element: DomElement, ctx: ParseContext): void {
  const visit = (node: DomElement, root: boolean): void => {
    if (!root && node.name === "table") {
      warn(
        ctx,
        "unsupported-nested-table",
        "bad-block",
        UNSUPPORTED_NESTED_TABLE_DETAIL,
        domNodeLocation(node),
      );
    }
    if (!QINGML_VOID_TAGS.has(node.name) && !hasExplicitClosingTag(node, ctx.source)) {
      warn(
        ctx,
        "truncated-table-structure",
        "bad-block",
        `表格内 <${node.name}> 缺少显式闭合标签，疑似输出截断。`,
        domNodeLocation(node),
      );
    }
    node.children.filter(isTag).forEach((child) => visit(child, false));
  };
  visit(element, true);
}

function domNodeLocation(node: DomNode): QingmlWarning["location"] | undefined {
  const startOffset = typeof node.startIndex === "number" ? node.startIndex : undefined;
  const endOffset = typeof node.endIndex === "number" ? node.endIndex : undefined;
  if (startOffset === undefined && endOffset === undefined) return undefined;
  return {
    ...(startOffset !== undefined ? { startOffset } : {}),
    ...(endOffset !== undefined ? { endOffset } : {}),
  };
}

function hasExplicitClosingTag(element: DomElement, source: string): boolean {
  if (typeof element.startIndex !== "number" || typeof element.endIndex !== "number") return true;
  const slice = source.slice(element.startIndex, element.endIndex + 1);
  const tagPattern = new RegExp(`<\\s*(/?)\\s*${escapeRegExp(element.name)}\\b[^>]*>`, "gi");
  let depth = 0;
  let sawOpeningTag = false;
  for (const match of slice.matchAll(tagPattern)) {
    const token = match[0];
    if (match[1] === "/") {
      depth -= 1;
    } else if (!/\/\s*>$/.test(token)) {
      sawOpeningTag = true;
      depth += 1;
    }
    if (depth < 0) return false;
  }
  // 同名标签可嵌套；必须整段配平，不能让内层 </table> 冒充外层闭合。
  return sawOpeningTag && depth === 0;
}

function parseColumns(element: DomElement, ctx: ParseContext): AiColumn[] {
  return element.children
    .filter(isTag)
    .filter((child) => child.name === "column")
    .map((column) => {
      const parsed: AiColumn = { blocks: parseNodesAsBlocks(column.children, ctx) };
      const ratio = positiveRatio(column.attribs.ratio);
      if (ratio !== undefined) parsed.widthRatio = ratio;
      return parsed;
    });
}

function parseInlineNodes(nodes: readonly DomNode[], ctx: ParseContext, options: InlineOptions = {}): AiRun[] {
  const runs: AiRun[] = [];

  const walk = (
    node: DomNode,
    marks: readonly AiRunMark[],
    contextTag: string | undefined,
  ): void => {
    if (isText(node)) {
      appendText(runs, collapseInlineWhitespace(node.data ?? ""), marks);
      return;
    }
    if (!isTag(node)) return;

    const name = node.name;
    if (name === "script" || name === "style") {
      // htmlparser2 把 script/style 内容当特殊 raw 文本;不能把 alert(1)/CSS 当正文吞进 runs。
      warn(ctx, "script-style-dropped", "harmless", `<${name}> 已忽略,不作为正文。`);
      return;
    }
    if (name === "br") {
      appendText(runs, "\n", marks, true);
      warn(ctx, "br-soft-break", "harmless", "<br> 已归一为当前 run 内的换行。");
      return;
    }
    if (name === "p" && options.paragraphBreaks) {
      appendNewlineIfNeeded(runs, marks);
      walkChildren(node.children, marks, contextTag);
      return;
    }
    if (name === "math") {
      const latex = textContent(node.children).trim();
      if (latex) appendText(runs, latex, [{ type: "math" }], true);
      return;
    }
    if (name === "footnote") {
      if (!hasExplicitClosingTag(node, ctx.source)) {
        warn(ctx, "truncated-footnote", "bad-block", "<footnote> 缺少显式闭合标签，疑似输出截断。");
      }
      if (node.children.some((child) => !isText(child))) {
        warn(ctx, "nested-footnote-content", "bad-block", "<footnote> 内只允许纯文本和实体转义，不能嵌套标签。");
      }
      const id = optionalString(node.attribs.id);
      runs.push({
        type: "footnote",
        ...(id ? { id } : {}),
        note: collapseInlineWhitespace(textContent(node.children)).trim(),
      });
      return;
    }
    if (isInlineMarkTag(name)) {
      walkChildren(node.children, addInlineMark(node, marks), contextTag);
      return;
    }
    if (isBlockTagName(name) || STRUCTURAL_TAGS.has(name)) {
      const context = contextTag ? `<${contextTag}> 内` : "顶层行内内容中";
      warn(ctx, "inline-block-flattened", "bad-block", `${context}出现块级/结构标签 <${name}>，已拍平成行内文本。`);
      appendNewlineIfNeeded(runs, marks);
      walkChildren(node.children, marks, name);
      appendNewlineIfNeeded(runs, marks);
      return;
    }
    if (containsStructuralTag(node.children)) {
      warn(ctx, "unknown-structural-tag", "bad-block", `非白名单标签 <${name}> 包含块级结构，剥壳会导致结构丢失。`);
      appendNewlineIfNeeded(runs, marks);
      walkChildren(node.children, marks, name);
      appendNewlineIfNeeded(runs, marks);
      return;
    }
    walkChildren(node.children, marks, contextTag);
  };

  const walkChildren = (
    children: readonly DomNode[],
    marks: readonly AiRunMark[],
    contextTag: string | undefined,
  ): void => {
    for (const child of children) walk(child, marks, contextTag);
  };

  walkChildren(nodes, [], options.inlineOnlyTag);
  return normalizeRuns(runs);
}

function addInlineMark(element: DomElement, marks: readonly AiRunMark[]): readonly AiRunMark[] {
  const name = element.name;
  if (name === "b" || name === "strong") return appendMark(marks, { type: "bold" });
  if (name === "i" || name === "em") return appendMark(marks, { type: "italic" });
  if (name === "u") return appendMark(marks, { type: "underline" });
  if (name === "s" || name === "del") return appendMark(marks, { type: "strike" });
  if (name === "code") return appendMark(marks, { type: "code" });
  if (name === "a") {
    const href = optionalString(element.attribs.href);
    if (!href || !isAllowedLinkHref(href)) return marks;
    return appendMark(marks, { type: "link", href, title: optionalString(element.attribs.title) });
  }
  if (name === "mark") {
    const color = oneOf(PM_HIGHLIGHT_COLORS, element.attribs.color) ?? oneOf(PM_HIGHLIGHT_COLORS, "yellow");
    return color ? appendMark(marks, { type: "highlight", color }) : marks;
  }
  if (name === "color") {
    const color = oneOf(PM_TEXT_COLORS, element.attribs.val);
    return color ? appendMark(marks, { type: "textColor", color }) : marks;
  }
  return marks;
}

function appendMark(marks: readonly AiRunMark[], mark: AiRunMark): readonly AiRunMark[] {
  if (marks.some((existing) => JSON.stringify(existing) === JSON.stringify(mark))) return marks;
  return [...marks, mark];
}

function appendText(runs: AiRun[], text: string, marks: readonly AiRunMark[], preserveWhitespace = false): void {
  const value = preserveWhitespace ? text : collapseInlineWhitespace(text);
  if (!value) return;
  const normalizedMarks = normalizeMarkList(marks);
  const last = runs[runs.length - 1];
  if (last && isAiTextRun(last) && sameMarks(last.marks ?? [], normalizedMarks)) {
    last.text += value;
    return;
  }
  runs.push(normalizedMarks.length > 0 ? { text: value, marks: normalizedMarks } : { text: value });
}

function appendNewlineIfNeeded(runs: AiRun[], marks: readonly AiRunMark[]): void {
  const last = runs[runs.length - 1];
  if (!last || (isAiTextRun(last) && last.text.endsWith("\n"))) return;
  appendText(runs, "\n", marks, true);
}

function normalizeRuns(input: readonly AiRun[]): AiRun[] {
  const runs = input
    .map((run): AiRun =>
      isAiTextRun(run)
        ? { ...run, marks: run.marks ? normalizeMarkList(run.marks) : undefined }
        : { ...run, note: run.note.trim() },
    )
    .filter((run) => !isAiTextRun(run) || run.text.length > 0);

  if (runs.length === 0) return [];
  const first = runs[0];
  if (first && isAiTextRun(first)) {
    runs[0] = { ...first, text: first.text.replace(/^[ \t\r\n\f]+/, "") };
  }
  const lastIndex = runs.length - 1;
  const last = runs[lastIndex];
  if (last && isAiTextRun(last)) {
    runs[lastIndex] = { ...last, text: last.text.replace(/[ \t\r\n\f]+$/, "") };
  }

  const merged: AiRun[] = [];
  for (const run of runs) {
    if (!isAiTextRun(run)) {
      merged.push(run);
      continue;
    }
    if (run.text.length === 0) continue;
    const marks = run.marks && run.marks.length > 0 ? run.marks : undefined;
    const prev = merged[merged.length - 1];
    if (prev && isAiTextRun(prev) && sameMarks(prev.marks ?? [], marks ?? [])) {
      prev.text += run.text;
      continue;
    }
    merged.push(marks ? { text: run.text, marks } : { text: run.text });
  }
  return merged;
}

function isAiTextRun(run: AiRun): run is AiTextRun {
  return !("type" in run);
}

function validateFootnoteDefinitions(blocks: readonly AiBlock[], ctx: ParseContext): void {
  const definitions = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === "footnote"
      && typeof record.id === "string"
      && typeof record.note === "string"
    ) {
      const previous = definitions.get(record.id);
      if (previous !== undefined && previous !== record.note) {
        warn(ctx, "conflicting-footnote-id", "bad-block", `脚注 id "${record.id}" 对应了不同 note。`);
      } else {
        definitions.set(record.id, record.note);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(blocks);
}

function normalizeMarkList(marks: readonly AiRunMark[]): AiRunMark[] {
  if (marks.some((mark) => mark.type === "math")) return [{ type: "math" }];
  const seen = new Set<string>();
  const out: AiRunMark[] = [];
  for (const mark of marks) {
    const key = JSON.stringify(mark);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mark);
  }
  return out;
}

function sameMarks(left: readonly AiRunMark[], right: readonly AiRunMark[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function acceptBlock(blocks: AiBlock[], block: AiBlock, ctx: ParseContext): void {
  const parsed = aiBlockSchema.safeParse(block);
  if (parsed.success) {
    blocks.push(parsed.data);
    return;
  }
  warnSchemaError(ctx, parsed.error, "invalid-ai-block");
}

function validateListItem(item: AiListItem, ctx: ParseContext): AiListItem | null {
  const parsed = aiListItemSchema.safeParse(item);
  if (parsed.success) return parsed.data;
  warnSchemaError(ctx, parsed.error, "invalid-list-item");
  return null;
}

function validateTaskItem(item: AiTaskListItem, ctx: ParseContext): AiTaskListItem | null {
  const parsed = aiTaskListItemSchema.safeParse(item);
  if (parsed.success) return parsed.data;
  warnSchemaError(ctx, parsed.error, "invalid-task-list-item");
  return null;
}

function validateCells(cells: readonly AiTableCell[], ctx: ParseContext): { ok: true; cells: AiTableCell[] } | { ok: false; error: string } {
  const out: AiTableCell[] = [];
  for (const cell of cells) {
    const parsed = aiTableCellSchema.safeParse(cell);
    if (!parsed.success) {
      warnSchemaError(ctx, parsed.error, "invalid-table-cell");
      return { ok: false, error: "表格单元格不符合 AiTableCell schema。" };
    }
    out.push(parsed.data);
  }
  return { ok: true, cells: out };
}

function warnSchemaError(ctx: ParseContext, error: ZodError, fallbackKind: string): void {
  const nestedTableIssue = error.issues.find(
    (issue) => issue.code === "custom" && issue.message === "table cell blocks must not contain table",
  );
  if (nestedTableIssue) {
    warn(ctx, "unsupported-nested-table", "bad-block", UNSUPPORTED_NESTED_TABLE_DETAIL, {
      path: nestedTableIssue.path.map((part) => typeof part === "number" ? part : String(part)),
    });
    return;
  }
  warn(ctx, fallbackKind, "bad-block", error.message);
}

function extractBlockFragmentRoots(nodes: readonly DomNode[], ctx: ParseContext): { ok: true; nodes: DomNode[] } | { ok: false; error: string } {
  const roots = meaningfulFragmentNodes(nodes);
  const out: DomNode[] = [];
  for (const node of roots) {
    if (isTag(node) && isBlockTagName(node.name)) {
      out.push(node);
      continue;
    }
    if (isTag(node) && !STRUCTURAL_TAGS.has(node.name)) {
      const inner = extractBlockFragmentRoots(node.children, ctx);
      if (inner.ok) {
        warn(ctx, "fragment-wrapper-stripped", "harmless", `块片段已剥掉多余包裹 <${node.name}>。`);
        out.push(...inner.nodes);
        continue;
      }
    }
    return { ok: false, error: `action 需要块级根节点，但收到 ${describeNode(node)}。` };
  }
  if (out.length === 0) return { ok: false, error: "action 需要至少一个块级根节点。" };
  return { ok: true, nodes: out };
}

function parseListItemFragment(nodes: readonly DomNode[], ctx: ParseContext): { ok: true; item: AiListItem | AiTaskListItem } | { ok: false; error: string } {
  const roots = meaningfulFragmentNodes(nodes);
  const first = roots[0];
  if (roots.length === 1 && first && isTag(first)) {
    const root = first;
    if (root.name === "li") {
      const item = validateListItem(parseListItemElement(root, ctx), ctx);
      return item ? { ok: true, item } : { ok: false, error: "li 片段不符合 AiListItem schema。" };
    }
    if (root.name === "task") {
      const item = validateTaskItem(parseTaskItemElement(root, ctx), ctx);
      return item ? { ok: true, item } : { ok: false, error: "task 片段不符合 AiTaskListItem schema。" };
    }
    if (root.name === "ul" || root.name === "ol") {
      const items = root.children.filter(isTag).filter((child) => child.name === "li");
      if (items.length !== 1) return { ok: false, error: "list-item action 只接受一个 li。" };
      const item = validateListItem(parseListItemElement(items[0]!, ctx), ctx);
      return item ? { ok: true, item } : { ok: false, error: "li 片段不符合 AiListItem schema。" };
    }
    if (root.name === "tasks") {
      const items = root.children.filter(isTag).filter((child) => child.name === "task");
      if (items.length !== 1) return { ok: false, error: "list-item action 只接受一个 task。" };
      const item = validateTaskItem(parseTaskItemElement(items[0]!, ctx), ctx);
      return item ? { ok: true, item } : { ok: false, error: "task 片段不符合 AiTaskListItem schema。" };
    }
  }

  if (roots.length > 0 && roots.every(isInlineFragmentNode)) {
    const item: AiListItem = { runs: parseInlineNodes(roots, ctx) };
    const parsed = validateListItem(item, ctx);
    return parsed ? { ok: true, item: parsed } : { ok: false, error: "裸行内片段不符合 AiListItem schema。" };
  }
  return { ok: false, error: `list-item action 收到越界根节点: ${roots.map(describeNode).join(", ") || "空片段"}。` };
}

function parseTableRowFragment(nodes: readonly DomNode[], ctx: ParseContext): { ok: true; cells: AiTableCell[] } | { ok: false; error: string } {
  const roots = meaningfulFragmentNodes(nodes);
  const first = roots[0];
  let cells: AiTableCell[] | null = null;
  if (roots.length === 1 && first && isTag(first) && first.name === "table") {
    const rows = tableRowElements(first);
    if (rows.length !== 1) return { ok: false, error: "insertTableRow 只接受一个 tr。" };
    cells = tableCellElements(rows[0]!).map((cell) => parseTableCell(cell, ctx));
  } else if (roots.length === 1 && first && isTag(first) && first.name === "tr") {
    cells = tableCellElements(first).map((cell) => parseTableCell(cell, ctx));
  } else if (roots.length > 0 && roots.every((node) => isTag(node) && isTableCellTag(node.name))) {
    cells = roots.map((node) => parseTableCell(node as DomElement, ctx));
  } else {
    return { ok: false, error: `insertTableRow 收到越界根节点: ${roots.map(describeNode).join(", ") || "空片段"}。` };
  }

  if (cells.length === 0) return { ok: false, error: "insertTableRow 需要至少一个 td/th。" };
  return validateCells(cells, ctx);
}

function parseTableColumnFragment(nodes: readonly DomNode[], ctx: ParseContext): { ok: true; cells: AiTableCell[] } | { ok: false; error: string } {
  const roots = meaningfulFragmentNodes(nodes);
  const first = roots[0];
  let cells: AiTableCell[] | null = null;

  if (roots.length === 1 && first && isTag(first) && first.name === "table") {
    const picked = pickOneCellPerRow(tableRowElements(first), ctx);
    if (!picked.ok) return picked;
    cells = picked.cells;
  } else if (roots.length > 0 && roots.every((node) => isTag(node) && node.name === "tr")) {
    const picked = pickOneCellPerRow(roots as DomElement[], ctx);
    if (!picked.ok) return picked;
    cells = picked.cells;
  } else if (roots.length > 0 && roots.every((node) => isTag(node) && isTableCellTag(node.name))) {
    cells = roots.map((node) => parseTableCell(node as DomElement, ctx));
  } else {
    return { ok: false, error: `insertTableColumn 收到越界根节点: ${roots.map(describeNode).join(", ") || "空片段"}。` };
  }

  if (cells.length === 0) return { ok: false, error: "insertTableColumn 需要至少一个 td/th。" };
  return validateCells(cells, ctx);
}

function pickOneCellPerRow(rows: readonly DomElement[], ctx: ParseContext): { ok: true; cells: AiTableCell[] } | { ok: false; error: string } {
  const cells: AiTableCell[] = [];
  for (const row of rows) {
    const rowCells = tableCellElements(row);
    if (rowCells.length !== 1) return { ok: false, error: "insertTableColumn 要求每个 tr 恰好一个 td/th。" };
    cells.push(parseTableCell(rowCells[0]!, ctx));
  }
  return validateCells(cells, ctx);
}

function meaningfulFragmentNodes(nodes: readonly DomNode[]): DomNode[] {
  return nodes.filter((node) => {
    if (isIgnorable(node)) return false;
    return !(isTag(node) && node.name === "title");
  });
}

function isInlineFragmentNode(node: DomNode): boolean {
  if (isText(node)) return hasMeaningfulText(node.data ?? "");
  if (!isTag(node)) return false;
  if (INLINE_TAGS.has(node.name)) return true;
  return !STRUCTURAL_TAGS.has(node.name) && !containsStructuralTag(node.children);
}

function tableRowElements(table: DomElement): DomElement[] {
  const rows: DomElement[] = [];
  for (const child of table.children) {
    if (!isTag(child)) continue;
    if (child.name === "tr") rows.push(child);
    if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
      rows.push(...child.children.filter(isTag).filter((row) => row.name === "tr"));
    }
  }
  return rows;
}

function tableCellElements(row: DomElement): DomElement[] {
  return row.children.filter(isTag).filter((cell) => isTableCellTag(cell.name));
}

function appendSyntheticBreakIfNeeded(nodes: DomNode[]): void {
  if (nodes.length === 0) return;
  nodes.push({ type: "text", data: "\n" });
}

function rawTextElementText(element: DomElement, ctx: ParseContext): string {
  if (!containsAnyTag(element.children)) return textContent(element.children);
  if (!canRebuildRawTextElement(element)) {
    warnRawTextChildTag(element, ctx);
    return textContent(element.children);
  }
  return rebuildRawTextElementChildren(element, ctx);
}

function canRebuildRawTextElement(element: DomElement): boolean {
  return !containsBlockTag(element.children);
}

function warnRawTextChildTag(element: DomElement, ctx: ParseContext): void {
  warn(ctx, "raw-text-child-tag", "bad-block", `<${element.name}> 内出现子标签，通常表示代码/公式里的 < 没有按 &lt; 转义。`);
}

function containsAnyTag(nodes: readonly DomNode[]): boolean {
  return nodes.some((node) => isTag(node) || containsAnyTag(node.children ?? []));
}

function containsBlockTag(nodes: readonly DomNode[]): boolean {
  return nodes.some((node) => {
    if (!isTag(node)) return false;
    if (isBlockTagName(node.name)) return true;
    return containsBlockTag(node.children);
  });
}

function rebuildRawTextElementChildren(element: DomElement, ctx: ParseContext): string {
  const sourceText = rawTextSourceSlice(element, ctx.source);
  if (sourceText !== null) return decodeRawTextEntities(sourceText);
  return serializeRawTextNodes(element.children);
}

function rawTextSourceSlice(element: DomElement, source: string): string | null {
  if (!source) return null;
  if (typeof element.startIndex !== "number" || typeof element.endIndex !== "number") return null;
  const openEnd = source.indexOf(">", element.startIndex);
  if (openEnd < 0 || openEnd > element.endIndex) return null;
  const fullElementSource = source.slice(element.startIndex, element.endIndex + 1);
  const closing = new RegExp(`</\\s*${escapeRegExp(element.name)}\\s*>\\s*$`, "i").exec(fullElementSource);
  const innerEnd = closing ? element.startIndex + closing.index : element.endIndex + 1;
  if (innerEnd < openEnd + 1) return null;
  return source.slice(openEnd + 1, innerEnd);
}

function serializeRawTextNodes(nodes: readonly DomNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      out += node.data ?? "";
      continue;
    }
    if (!isTag(node)) {
      out += serializeRawTextNodes(node.children ?? []);
      continue;
    }
    const attrs = serializeRawTextAttrs(node.attribs);
    if (node.children.length === 0) {
      out += `<${node.name}${attrs}/>`;
      continue;
    }
    out += `<${node.name}${attrs}>${serializeRawTextNodes(node.children)}</${node.name}>`;
  }
  return out;
}

function serializeRawTextAttrs(attribs: Record<string, string>): string {
  return Object.entries(attribs)
    .map(([key, value]) => value === "" ? ` ${key}` : ` ${key}="${escapeRawTextAttr(value)}"`)
    .join("");
}

function escapeRawTextAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function decodeRawTextEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (entity.startsWith("#x")) return codePointToString(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith("#")) return codePointToString(Number.parseInt(entity.slice(1), 10));
        return `&${entity};`;
    }
  });
}

function codePointToString(codePoint: number): string {
  if (!Number.isFinite(codePoint)) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function containsStructuralTag(nodes: readonly DomNode[]): boolean {
  return nodes.some((node) => {
    if (!isTag(node)) return false;
    if (isBlockTagName(node.name) || STRUCTURAL_TAGS.has(node.name)) return true;
    return containsStructuralTag(node.children);
  });
}

function textContent(nodes: readonly DomNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) out += node.data ?? "";
    else if (isTag(node) && node.name === "br") out += "\n";
    else out += textContent(node.children ?? []);
  }
  return out;
}

function collapseInlineWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, " ");
}

function isTag(node: DomNode): node is DomElement {
  return (node.type === "tag" || node.type === "script" || node.type === "style") && typeof node.name === "string";
}

function isText(node: DomNode): boolean {
  return node.type === "text";
}

function isIgnorable(node: DomNode): boolean {
  if (node.type === "comment" || node.type === "directive") return true;
  return isText(node) && !hasMeaningfulText(node.data ?? "");
}

function hasMeaningfulText(text: string): boolean {
  return /[^\s]/u.test(text);
}

function isHeadingTag(name: string): boolean {
  return /^h[1-6]$/.test(name);
}

function isBlockTagName(name: string): boolean {
  return isHeadingTag(name) || BLOCK_TAGS.has(name);
}

function isInlineMarkTag(name: string): boolean {
  return INLINE_TAGS.has(name) && name !== "br" && name !== "math";
}

function isTableCellTag(name: string): name is "td" | "th" {
  return name === "td" || name === "th";
}

function oneOf<const T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonnegativeInt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveRatio(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function booleanAttr(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1" || normalized === "checked" || normalized === "yes";
}

function describeNode(node: DomNode): string {
  if (isText(node)) return "text";
  if (isTag(node)) return `<${node.name}>`;
  return node.type;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
