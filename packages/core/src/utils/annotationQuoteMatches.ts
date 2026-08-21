import type { PmBlockNode } from "@qingagent/pm-schema";
import type { TextBlockRef } from "./pmTextBlocks.js";

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

export function toQuoteMatch(
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

export function applyAllPolicy(matches: QuoteMatch[], all: boolean): QuoteMatch[] {
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
