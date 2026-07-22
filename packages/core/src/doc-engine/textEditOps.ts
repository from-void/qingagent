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

function exactLiteralMatches(blocks: TextBlockRef[], find: string): QuoteMatch[] {
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
  blocks: TextBlockRef[],
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
  blocks: TextBlockRef[],
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
): Promise<QuoteMatch[]> {
  const compiled = compileSafeRegex(pattern);
  if (!compiled.ok) return [];

  const matches: QuoteMatch[] = [];
  for (const block of blocks) {
    const result = await execSafeRegexAll(compiled.re, block.text, 1000);
    if (!result.ok) return [];
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
  return applyAllPolicy(matches, all);
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

function markInlineContent(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
  mark: PmMark,
  op: "add" | "remove",
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;

  for (const node of content ?? []) {
    const len = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + len;

    if (node.type !== "text" || nodeTo <= from || nodeFrom >= to) {
      next.push(node);
      offset = nodeTo;
      continue;
    }

    const markFrom = Math.max(from, nodeFrom) - nodeFrom;
    const markTo = Math.min(to, nodeTo) - nodeFrom;
    const before = node.text.slice(0, markFrom);
    const middle = node.text.slice(markFrom, markTo);
    const after = node.text.slice(markTo);

    if (before) {
      next.push(setTextNodeMarks({ ...node, text: before }, node.marks ? [...node.marks] : undefined));
    }
    if (middle) {
      const marks = op === "add" ? addMark(node.marks, mark) : removeMark(node.marks, mark);
      next.push(setTextNodeMarks({ ...node, text: middle }, marks));
    }
    if (after) {
      next.push(setTextNodeMarks({ ...node, text: after }, node.marks ? [...node.marks] : undefined));
    }

    offset = nodeTo;
  }

  return next;
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

// 防御:模型做"内联选区改写"时,常把 replace 写成**整段重写**(含选区外、块里已存在的
// 紧邻文字)——例如用户只选中标题前缀「多模态大模型综述」(甚至把它改写成「…研究综述」),
// 模型却把整条标题「…综述：架构、对齐与数据治理」塞进 replace。若只把 replace 填进选区,
// 选区外原有的「：架构…治理」仍保留 → 重复拼接成「…治理：架构…治理」。
// 做法:检测 replace 的**尾部**与块内紧邻后文(tail)开头的最长重叠、replace 的**头部**与
// 紧邻前文(head)结尾的最长重叠,把 replace 那段重叠**裁掉**(而非扩张替换范围)——这样选区外
// 的原节点(连同其 bold/link/inlineMath 等结构)原样保留,只去掉 replace 里多写的那份。
// 仅在重叠 >= 2 字符时触发(已覆盖实测全部形态:「：架构…治理」「年版」「协作」),避免单字巧合误伤。
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

export function replaceTextRuns(
  doc: PmDoc,
  matches: QuoteMatch[],
  replace: string,
  captures?: boolean,
): PmDoc {
  const ordered = [...matches].sort((left, right) => right.pmFrom - left.pmFrom);
  return ordered.reduce((currentDoc, match) => {
    const from = match.pmFrom - match.block.textStart;
    const to = match.pmTo - match.block.textStart;
    const replacement = trimReassembledOverlap(
      match.block.text,
      from,
      to,
      expandReplacement(replace, match, captures),
    );
    const content = updateNodeAtPath(currentDoc.content, match.block.path, (node) => {
      if (!isInlineTextBlock(node)) return node;
      return {
        ...node,
        content: replaceInlineContent(node.content, from, to, replacement),
      } as PmBlockNode;
    }) as PmBlockNode[];
    return normalizePmDoc({ ...currentDoc, content });
  }, doc);
}

export function markTextRuns(
  doc: PmDoc,
  matches: QuoteMatch[],
  mark: PmMark,
  op: "add" | "remove",
): PmDoc {
  const ordered = [...matches].sort((left, right) => right.pmFrom - left.pmFrom);
  return ordered.reduce((currentDoc, match) => {
    const from = match.pmFrom - match.block.textStart;
    const to = match.pmTo - match.block.textStart;
    const content = updateNodeAtPath(currentDoc.content, match.block.path, (node) => {
      if (!isInlineTextBlock(node)) return node;
      return {
        ...node,
        content: markInlineContent(node.content, from, to, mark, op),
      } as PmBlockNode;
    }) as PmBlockNode[];
    return normalizePmDoc({ ...currentDoc, content });
  }, doc);
}
