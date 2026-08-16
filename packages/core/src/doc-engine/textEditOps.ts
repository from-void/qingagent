import {
  normalizePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
  type PmNode,
} from "@qingagent/pm-schema";
import { compileSafeRegex, execSafeRegexAll } from "../agent-run/safeRegex.js";
import {
  collectTopLevelTextBlocks,
  inlineNodeLen,
  isInlineTextBlock,
  type TextBlockRef,
} from "../utils/pmTextBlocks.js";

export {
  collectTopLevelTextBlocks,
  type TextBlockRef,
} from "../utils/pmTextBlocks.js";

export interface QuoteMatch {
  blockId: string;
  node: PmBlockNode;
  pmFrom: number;
  pmTo: number;
  matchText: string;
  block: TextBlockRef;
  startOffset: number;
  endOffset: number;
  captures?: string[];
}

function toQuoteMatch(
  block: TextBlockRef,
  startOffset: number,
  endOffset: number,
  matchText: string,
  captures?: string[],
): QuoteMatch {
  return {
    blockId: block.blockId,
    node: block.node,
    pmFrom: block.textStart + startOffset,
    pmTo: block.textStart + endOffset,
    matchText,
    block,
    startOffset,
    endOffset,
    ...(captures ? { captures } : {}),
  };
}

function applyAllPolicy(matches: QuoteMatch[], all: boolean): QuoteMatch[] {
  if (all) return matches;
  return matches.length === 1 ? matches : [];
}

interface LiteralRange {
  start: number;
  end: number;
}

type WhitespaceNormalization = "remove" | "collapse";

function normalizeQuoteVariant(value: string): string {
  if (/[「」『』“”]/u.test(value)) return '"';
  if (/[‘’]/u.test(value)) return "'";
  return value;
}

function normalizeLiteralWithOffsets(
  value: string,
  whitespace: WhitespaceNormalization,
): { normalized: string; starts: number[]; ends: number[] } {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];

  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const raw = String.fromCodePoint(codePoint);
    const nextOffset = offset + raw.length;
    for (const normalizedCodePoint of raw.normalize("NFKC")) {
      const part = normalizeQuoteVariant(normalizedCodePoint);
      if (/\s/u.test(part)) {
        if (whitespace === "collapse" && normalized && !normalized.endsWith(" ")) {
          normalized += " ";
          starts.push(offset);
          ends.push(nextOffset);
        } else if (whitespace === "collapse" && normalized.endsWith(" ")) {
          ends[ends.length - 1] = nextOffset;
        }
        continue;
      }
      normalized += part;
      for (let unit = 0; unit < part.length; unit += 1) {
        starts.push(offset);
        ends.push(nextOffset);
      }
    }
    offset = nextOffset;
  }

  if (whitespace === "collapse" && normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { normalized, starts, ends };
}

export function normalizeAnnotationQuote(value: string): string {
  return normalizeLiteralWithOffsets(value, "collapse").normalized;
}

/**
 * 素材引文存在性校验的规范化口径：兼容空白差异与全/半角差异。
 * 范围映射只供只读校验与批注定位使用，不能用于正文编辑。
 */
function findNormalizedLiteralRanges(
  text: string,
  find: string,
  whitespace: WhitespaceNormalization,
): LiteralRange[] {
  const haystack = normalizeLiteralWithOffsets(text, whitespace);
  const needle = normalizeLiteralWithOffsets(find, whitespace).normalized;
  if (!needle) return [];

  const ranges: LiteralRange[] = [];
  let index = haystack.normalized.indexOf(needle);
  while (index >= 0) {
    const lastIndex = index + needle.length - 1;
    const start = haystack.starts[index];
    const end = haystack.ends[lastIndex];
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
    index = haystack.normalized.indexOf(needle, index + Math.max(1, needle.length));
  }
  return ranges;
}

export function containsLiteralMatch(text: string, find: string): boolean {
  return findNormalizedLiteralRanges(text, find, "remove").length > 0;
}

function exactLiteralMatches(blocks: readonly TextBlockRef[], find: string): QuoteMatch[] {
  const matches: QuoteMatch[] = [];
  for (const block of blocks) {
    let index = block.text.indexOf(find);
    while (index >= 0) {
      const end = index + find.length;
      matches.push(toQuoteMatch(block, index, end, find));
      index = block.text.indexOf(find, index + Math.max(1, find.length));
    }
  }
  return matches;
}

export function findLiteralMatches(
  blocks: readonly TextBlockRef[],
  find: string,
  all: boolean,
): QuoteMatch[] {
  if (!find) return [];
  return applyAllPolicy(exactLiteralMatches(blocks, find), all);
}

/**
 * 批注锚点先走逐字匹配；只有完全没有逐字候选时，才按 trim、连续空白、
 * 全/半角与中英文引号变体做二次定位。这样不会把原本的唯一性失败放宽成猜测。
 */
export function findAnnotationQuoteMatches(
  blocks: readonly TextBlockRef[],
  find: string,
  all: boolean,
): QuoteMatch[] {
  if (!find) return [];
  const exact = exactLiteralMatches(blocks, find);
  if (exact.length > 0) return applyAllPolicy(exact, all);

  const normalized: QuoteMatch[] = [];
  for (const block of blocks) {
    for (const range of findNormalizedLiteralRanges(block.text, find, "collapse")) {
      normalized.push(toQuoteMatch(
        block,
        range.start,
        range.end,
        block.text.slice(range.start, range.end),
      ));
    }
  }
  return applyAllPolicy(normalized, all);
}

export async function findSafeRegexMatches(
  blocks: TextBlockRef[],
  pattern: string,
  all: boolean,
): Promise<
  | { ok: true; matches: QuoteMatch[] }
  | { ok: false; error: string }
> {
  const compiled = compileSafeRegex(pattern);
  if (!compiled.ok) return compiled;

  const matches: QuoteMatch[] = [];
  for (const block of blocks) {
    const result = await execSafeRegexAll(compiled.re, block.text, 1000);
    if (!result.ok) return result;
    for (const match of result.matches) {
      const matchedText = match[0] ?? "";
      const index = match.index ?? -1;
      if (index < 0 || matchedText.length === 0) continue;
      const end = index + matchedText.length;
      matches.push(toQuoteMatch(
        block,
        index,
        end,
        matchedText,
        match.slice(1).map((part) => part ?? ""),
      ));
    }
  }
  return { ok: true, matches: applyAllPolicy(matches, all) };
}

function textToInlineNodes(text: string, marks?: readonly PmMark[]): PmInlineNode[] {
  const parts = text.split("\n");
  const nodes: PmInlineNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (!part) return;
    nodes.push(marks && marks.length > 0 ? { type: "text", text: part, marks: [...marks] } : { type: "text", text: part });
  });
  return nodes;
}

function sameMark(left: PmMark, right: PmMark): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setTextNodeMarks(
  node: Extract<PmInlineNode, { type: "text" }>,
  marks: PmMark[] | undefined,
): PmInlineNode {
  return marks && marks.length > 0
    ? { ...node, marks }
    : { type: "text", text: node.text };
}

function addMark(marks: readonly PmMark[] | undefined, mark: PmMark): PmMark[] | undefined {
  const current = marks ? [...marks] : [];
  if (!current.some((candidate) => sameMark(candidate, mark))) {
    current.push(mark);
  }
  return current.length > 0 ? current : undefined;
}

function removeMark(marks: readonly PmMark[] | undefined, mark: PmMark): PmMark[] | undefined {
  const next = (marks ?? []).filter((candidate) => !sameMark(candidate, mark));
  return next.length > 0 ? next : undefined;
}

function splitTextNode(
  node: Extract<PmInlineNode, { type: "text" }>,
  from: number,
  to: number,
): [PmInlineNode | null, PmInlineNode | null] {
  const before = node.text.slice(0, from);
  const after = node.text.slice(to);
  return [
    before ? { ...node, text: before } : null,
    after ? { ...node, text: after } : null,
  ];
}

function inheritedMarks(
  content: readonly PmInlineNode[] | undefined,
  start: number,
): PmMark[] | undefined {
  let offset = 0;
  for (const node of content ?? []) {
    const len = inlineNodeLen(node);
    if (node.type === "text" && start >= offset && start < offset + len) {
      return node.marks ? [...node.marks] : undefined;
    }
    offset += len;
  }
  return undefined;
}

function replaceInlineContent(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
  replacement: string,
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;
  let inserted = false;
  const marks = inheritedMarks(content, from);
  for (const node of content ?? []) {
    const len = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + len;
    if (nodeTo <= from || nodeFrom >= to) {
      if (!inserted && nodeFrom >= to) {
        next.push(...textToInlineNodes(replacement, marks));
        inserted = true;
      }
      next.push(node);
      offset = nodeTo;
      continue;
    }

    if (node.type === "text") {
      const keepBefore = Math.max(0, from - nodeFrom);
      const keepAfter = Math.min(len, to - nodeFrom);
      const pieces = splitTextNode(node, keepBefore, keepAfter);
      if (pieces[0]) next.push(pieces[0]);
      if (!inserted) {
        next.push(...textToInlineNodes(replacement, marks));
        inserted = true;
      }
      if (pieces[1]) next.push(pieces[1]);
    } else if (!inserted) {
      next.push(...textToInlineNodes(replacement, marks));
      inserted = true;
    }
    offset = nodeTo;
  }
  if (!inserted) next.push(...textToInlineNodes(replacement, marks));
  return next;
}

interface InlineRange {
  from: number;
  to: number;
}

interface InlineReplacement extends InlineRange {
  replacement: string;
}

function sliceInlineContent(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;
  for (const node of content ?? []) {
    const len = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + len;
    offset = nodeTo;
    if (nodeTo <= from || nodeFrom >= to) continue;
    if (node.type === "text") {
      const textFrom = Math.max(from, nodeFrom) - nodeFrom;
      const textTo = Math.min(to, nodeTo) - nodeFrom;
      const value = node.text.slice(textFrom, textTo);
      if (value) next.push({ ...node, text: value });
      continue;
    }
    if (nodeFrom >= from && nodeTo <= to) next.push(node);
  }
  return next;
}

function replaceInlineContentBatch(
  content: readonly PmInlineNode[] | undefined,
  replacements: InlineReplacement[],
): PmInlineNode[] {
  const ordered = [...replacements].sort((left, right) => left.from - right.from);
  // 正常匹配器只产出非重叠区间，可基于原 content 一次重建；对手写的重叠
  // QuoteMatch 输入保留旧实现的倒序逐区间语义，避免改变导出函数的边界行为。
  const hasOverlap = ordered.some((range, index) =>
    index > 0 && range.from < ordered[index - 1]!.to
  );
  if (hasOverlap) {
    return [...replacements]
      .sort((left, right) => right.from - left.from)
      .reduce(
        (current, range) => replaceInlineContent(
          current,
          range.from,
          range.to,
          range.replacement,
        ),
        [...(content ?? [])],
      );
  }

  const next: PmInlineNode[] = [];
  let cursor = 0;
  for (const range of ordered) {
    next.push(...sliceInlineContent(content, cursor, range.from));
    next.push(...textToInlineNodes(range.replacement, inheritedMarks(content, range.from)));
    cursor = range.to;
  }
  next.push(...sliceInlineContent(content, cursor, Number.POSITIVE_INFINITY));
  return next;
}

function markInlineContentBatch(
  content: readonly PmInlineNode[] | undefined,
  ranges: InlineRange[],
  mark: PmMark,
  op: "add" | "remove",
): { content: PmInlineNode[]; changed: boolean } {
  // 用区间事件扫描代替“每个 match 重新扫描已切碎的 content”，同时保留所有
  // match 边界（相邻区间的 delta 即使抵消，Map 中的边界仍然存在）。
  const eventDeltas = new Map<number, number>();
  for (const range of ranges) {
    if (range.from >= range.to) continue;
    eventDeltas.set(range.from, (eventDeltas.get(range.from) ?? 0) + 1);
    eventDeltas.set(range.to, (eventDeltas.get(range.to) ?? 0) - 1);
  }
  const events = [...eventDeltas.entries()]
    .map(([position, delta]) => ({ position, delta }))
    .sort((left, right) => left.position - right.position);
  if (events.length === 0) return { content: [...(content ?? [])], changed: false };

  const next: PmInlineNode[] = [];
  let offset = 0;
  let eventIndex = 0;
  let activeRanges = 0;
  let changed = false;

  const applyEventsThrough = (position: number): void => {
    while (eventIndex < events.length && events[eventIndex]!.position <= position) {
      activeRanges += events[eventIndex]!.delta;
      eventIndex += 1;
    }
  };

  for (const node of content ?? []) {
    const len = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + len;
    applyEventsThrough(nodeFrom);

    if (node.type !== "text") {
      next.push(node);
      offset = nodeTo;
      continue;
    }

    const pieces: PmInlineNode[] = [];
    let pieceFrom = nodeFrom;
    let nodeChanged = false;
    const appendPiece = (pieceTo: number): void => {
      if (pieceTo <= pieceFrom) return;
      const value = node.text.slice(pieceFrom - nodeFrom, pieceTo - nodeFrom);
      const hasMark = (node.marks ?? []).some((candidate) => sameMark(candidate, mark));
      const pieceChanged = activeRanges > 0 && (op === "add" ? !hasMark : hasMark);
      const marks = pieceChanged
        ? (op === "add" ? addMark(node.marks, mark) : removeMark(node.marks, mark))
        : node.marks ? [...node.marks] : undefined;
      pieces.push(setTextNodeMarks({ ...node, text: value }, marks));
      nodeChanged ||= pieceChanged;
      pieceFrom = pieceTo;
    };

    while (eventIndex < events.length && events[eventIndex]!.position < nodeTo) {
      const position = Math.max(nodeFrom, events[eventIndex]!.position);
      appendPiece(position);
      applyEventsThrough(events[eventIndex]!.position);
    }
    appendPiece(nodeTo);
    applyEventsThrough(nodeTo);

    if (nodeChanged) {
      next.push(...pieces);
      changed = true;
    } else {
      next.push(node);
    }
    offset = nodeTo;
  }

  return { content: next, changed };
}

function updateNodeAtPath(
  nodes: readonly PmNode[],
  path: readonly number[],
  update: (node: PmBlockNode) => PmBlockNode,
): PmNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return [...nodes];
  return nodes.map((node, index): PmNode => {
    if (index !== head) return node;
    if (rest.length === 0) return update(node as PmBlockNode);
    if (!("content" in node) || !Array.isArray(node.content)) return node;
    return {
      ...node,
      content: updateNodeAtPath(node.content as PmNode[], rest, update),
    } as PmNode;
  });
}

function expandReplacement(replace: string, match: QuoteMatch, captures: boolean | undefined): string {
  if (!captures) return replace;
  return replace.replace(/\$(\d+)/g, (raw, indexText: string) => {
    const index = Number(indexText);
    return match.captures?.[index - 1] ?? raw;
  });
}

// 只有可信调用方明确知道 replacement 是从当前整块重组而来、确实夹带了选区外相邻正文时，
// 才允许按边界重叠裁掉重复片段。单凭两个字符重合不能作为证据：重复词或标题边界本身也可能
// 是调用方明确要求写入的合法正文。
const REASSEMBLED_OVERLAP_MIN = 2;

function longestBoundaryOverlap(endsWith: string, startsWith: string): number {
  const limit = Math.min(endsWith.length, startsWith.length);
  for (let k = limit; k >= REASSEMBLED_OVERLAP_MIN; k -= 1) {
    if (endsWith.slice(endsWith.length - k) === startsWith.slice(0, k)) return k;
  }
  return 0;
}

function trimReassembledOverlap(
  blockText: string,
  from: number,
  to: number,
  replacement: string,
): string {
  if (!replacement) return replacement;
  let result = replacement;
  // 后缀重叠:result 结尾与紧邻后文开头重叠 → 去掉 result 尾部那段(后文原节点保留)。
  const tail = blockText.slice(to);
  const tailOverlap = longestBoundaryOverlap(result, tail);
  if (tailOverlap > 0 && tailOverlap < result.length) {
    result = result.slice(0, result.length - tailOverlap);
  }
  // 前缀重叠:result 开头与紧邻前文结尾重叠 → 去掉 result 头部那段(前文原节点保留)。
  const head = blockText.slice(0, from);
  const headOverlap = longestBoundaryOverlap(head, result);
  if (headOverlap > 0 && headOverlap < result.length) {
    result = result.slice(headOverlap);
  }
  return result;
}

export interface ReplaceTextRunsOptions {
  captures?: boolean;
  /** replacement 确由当前整块重组而来，包含了选区外相邻正文。 */
  reassembledFromBlock?: boolean;
}

export function replaceTextRuns(
  doc: PmDoc,
  matches: QuoteMatch[],
  replace: string,
  options: boolean | ReplaceTextRunsOptions = false,
): PmDoc {
  const captures = typeof options === "boolean" ? options : options.captures;
  const reassembledFromBlock =
    typeof options !== "boolean" && options.reassembledFromBlock === true;
  const ordered = [...matches].sort((left, right) => right.pmFrom - left.pmFrom);
  if (ordered.length === 0) return doc;
  const matchesByBlock = new Map<string, QuoteMatch[]>();
  for (const match of ordered) {
    const key = match.block.path.join(".");
    const group = matchesByBlock.get(key);
    if (group) group.push(match);
    else matchesByBlock.set(key, [match]);
  }

  let content: PmNode[] = doc.content;
  for (const blockMatches of matchesByBlock.values()) {
    const block = blockMatches[0]!.block;
    content = updateNodeAtPath(content, block.path, (node) => {
      if (!isInlineTextBlock(node)) return node;
      const replacements = blockMatches.map((match): InlineReplacement => {
        const from = match.pmFrom - match.block.textStart;
        const to = match.pmTo - match.block.textStart;
        const expanded = expandReplacement(replace, match, captures);
        return {
          from,
          to,
          replacement: reassembledFromBlock
            ? trimReassembledOverlap(match.block.text, from, to, expanded)
            : expanded,
        };
      });
      return {
        ...node,
        content: replaceInlineContentBatch(node.content, replacements),
      } as PmBlockNode;
    });
  }
  return normalizePmDoc({ ...doc, content: content as PmBlockNode[] });
}

export function markTextRuns(
  doc: PmDoc,
  matches: QuoteMatch[],
  mark: PmMark,
  op: "add" | "remove",
): PmDoc {
  const ordered = [...matches].sort((left, right) => right.pmFrom - left.pmFrom);
  if (ordered.length === 0) return doc;
  const matchesByBlock = new Map<string, QuoteMatch[]>();
  for (const match of ordered) {
    const key = match.block.path.join(".");
    const group = matchesByBlock.get(key);
    if (group) group.push(match);
    else matchesByBlock.set(key, [match]);
  }

  let content: PmNode[] = doc.content;
  let changed = false;
  for (const blockMatches of matchesByBlock.values()) {
    const block = blockMatches[0]!.block;
    content = updateNodeAtPath(content, block.path, (node) => {
      if (!isInlineTextBlock(node)) return node;
      const result = markInlineContentBatch(
        node.content,
        blockMatches.map((match) => ({
          from: match.pmFrom - match.block.textStart,
          to: match.pmTo - match.block.textStart,
        })),
        mark,
        op,
      );
      if (!result.changed) return node;
      changed = true;
      return {
        ...node,
        content: result.content,
      } as PmBlockNode;
    });
  }
  if (!changed) return doc;
  return normalizePmDoc({ ...doc, content: content as PmBlockNode[] });
}
