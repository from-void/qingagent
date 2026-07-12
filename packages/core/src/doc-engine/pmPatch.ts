import crypto from "node:crypto";
import type {
  ChatChip,
  DocSuggestion,
  PatchConflict,
} from "@qingagent/contract-ts";
import {
  markdownToPm,
  normalizePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
  type PmNode,
  type PmStep,
} from "@qingagent/pm-schema";
import { sanitizeMarkdownInline } from "../utils/sanitizeMarkdown.js";
import { isServerReanchorEnabled } from "./draftFeatureFlags.js";

export interface BeforeAfterPatchInput {
  before: string;
  after: string;
  summary: string;
  blockIndex?: number;
  format?: PatchFormat;
}

export type PatchFormat = "bold" | "unbold";

export interface SuggestionRecordDraft {
  before: string;
  after: string;
  blockIndex: number;
  suggestion: DocSuggestion;
}

export type CompileSuggestionResult =
  | {
      ok: true;
      record: SuggestionRecordDraft;
    }
  | {
      ok: false;
      error: string;
      conflictKind?: PatchConflict["kind"];
      blockIndex?: number;
    };

export interface ApplySuggestionsResult {
  nextDoc: PmDoc;
  steps: PmStep[];
  conflicts: PatchConflict[];
}

export type ApplyBeforeAfterPatchResult =
  | {
      ok: true;
      doc: PmDoc;
      before: string;
      after: string;
      blockIndex: number;
      reanchor?: ServerReanchorTelemetry;
    }
  | {
      ok: false;
      error: string;
      conflictKind?: PatchConflict["kind"];
      blockIndex?: number;
      reanchor?: ServerReanchorTelemetry;
    };

interface TextBlockRef {
  blockId: string;
  path: number[];
  topIndex: number;
  textStart: number;
  textEnd: number;
  text: string;
  node: PmBlockNode;
}

interface QuoteMatch {
  block: TextBlockRef;
  startOffset: number;
  endOffset: number;
  pmFrom: number;
  pmTo: number;
}

const CONTEXT_CHARS = 24;
export const SERVER_REANCHOR_MIN_CONFIDENCE = 0.86;
export const SERVER_REANCHOR_MIN_MARGIN = 0.08;
export const SERVER_REANCHOR_MIN_NORMALIZED_LENGTH = 6;
const SERVER_REANCHOR_WINDOW_VARIANCE = 0.12;
const SERVER_REANCHOR_CANDIDATE_FLOOR =
  SERVER_REANCHOR_MIN_CONFIDENCE - SERVER_REANCHOR_MIN_MARGIN;

export interface ServerReanchorTelemetry {
  attempted: boolean;
  applied: boolean;
  confidence?: number;
  matchCount: number;
}

interface FuzzyIndexedChar {
  ch: string;
  start: number;
  end: number;
}

interface FuzzyCandidate {
  match: QuoteMatch;
  confidence: number;
}

const FULLWIDTH_TO_HALFWIDTH: Record<string, string> = {
  "，": ",",
  "。": ".",
  "！": "!",
  "？": "?",
  "：": ":",
  "；": ";",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "「": "\"",
  "」": "\"",
  "『": "'",
  "』": "'",
  "、": ",",
  "“": "\"",
  "”": "\"",
  "‘": "'",
  "’": "'",
};

export function stripLeadingHeadingMarker(s: string): string {
  return s.replace(/^\s*#{1,6}[ \t]+/, "");
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function deepNormalize(s: string): string {
  let out = s.normalize("NFC");
  for (const [fw, hw] of Object.entries(FULLWIDTH_TO_HALFWIDTH)) {
    out = out.split(fw).join(hw);
  }
  return normalizeWhitespace(out);
}

function normalizeFuzzyChar(ch: string): string | null {
  const normalized = (FULLWIDTH_TO_HALFWIDTH[ch] ?? ch).normalize("NFC").toLowerCase();
  if (!normalized.trim()) return null;
  if (/^[\p{P}\p{S}]$/u.test(normalized)) return null;
  return normalized;
}

function buildFuzzyIndex(text: string): FuzzyIndexedChar[] {
  const out: FuzzyIndexedChar[] = [];
  let offset = 0;
  for (const raw of text) {
    const start = offset;
    offset += raw.length;
    const normalized = normalizeFuzzyChar(raw);
    if (!normalized) continue;
    for (const ch of normalized) {
      out.push({ ch, start, end: offset });
    }
  }
  return out;
}

function lcsLength(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[right.length]!;
}

function fuzzySimilarity(left: readonly string[], right: readonly string[]): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 0;
  return lcsLength(left, right) / longest;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWhitespacePattern(quote: string): RegExp | null {
  const normalized = normalizeWhitespace(quote);
  if (!normalized) return null;
  return new RegExp(escapeRegExp(normalized).replace(/ /g, "\\s+"), "g");
}

function buildDeepPattern(quote: string): RegExp | null {
  const deep = deepNormalize(quote);
  if (!deep) return null;
  const halfToFullGroup = new Map<string, string>();
  for (const [fw, hw] of Object.entries(FULLWIDTH_TO_HALFWIDTH)) {
    halfToFullGroup.set(hw, (halfToFullGroup.get(hw) ?? "") + fw);
  }
  let pattern = "";
  for (const ch of deep) {
    if (ch === " ") {
      pattern += "\\s+";
      continue;
    }
    const escaped = escapeRegExp(ch);
    const alternatives = halfToFullGroup.get(ch);
    pattern += alternatives
      ? `[${escaped}${escapeRegExp(alternatives)}]`
      : escaped;
  }
  try {
    return new RegExp(pattern, "g");
  } catch {
    return null;
  }
}

function nodeSize(node: PmNode | PmDoc): number {
  if (node.type === "doc") {
    return node.content.reduce((sum, child) => sum + nodeSize(child), 0);
  }
  if (node.type === "text") return node.text.length;
  if (node.type === "hardBreak") return 1;
  if (!("content" in node) || !Array.isArray(node.content)) return 1;
  return 2 + node.content.reduce((sum, child) => sum + nodeSize(child as PmNode), 0);
}

// inlineMath 是原子行内节点(PM nodeSize=1):文本投影用 U+FFFC 占位,保证 offset 与 PM 位置一致。
function inlineNodeLen(node: PmInlineNode): number {
  return node.type === "text" ? node.text.length : 1;
}

function inlineText(content: readonly PmInlineNode[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return "￼";
      return node.text;
    })
    .join("");
}

function isInlineTextBlock(node: PmNode): node is PmBlockNode & { content?: PmInlineNode[] } {
  return (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "codeBlock" ||
    node.type === "penNote"
  );
}

function inlineBlockContent(node: PmBlockNode): PmInlineNode[] | undefined {
  return isInlineTextBlock(node) ? node.content : undefined;
}

export function collectTextBlocks(doc: PmDoc): TextBlockRef[] {
  const out: TextBlockRef[] = [];

  function visit(node: PmNode, path: number[], pos: number, topIndex: number): void {
    if (isInlineTextBlock(node)) {
      const text = inlineText(node.content);
      out.push({
        blockId: node.attrs.blockId,
        path,
        topIndex,
        textStart: pos + 1,
        textEnd: pos + 1 + text.length,
        text,
        node,
      });
    }

    if (!("content" in node) || !Array.isArray(node.content)) return;
    let childPos = pos + 1;
    node.content.forEach((child, index) => {
      if (typeof child !== "object" || child === null) return;
      visit(child as PmNode, [...path, index], childPos, topIndex);
      childPos += nodeSize(child as PmNode);
    });
  }

  let pos = 0;
  doc.content.forEach((child, index) => {
    visit(child, [index], pos, index);
    pos += nodeSize(child);
  });
  return out;
}

function findExactMatches(block: TextBlockRef, quote: string): QuoteMatch[] {
  if (!quote) return [];
  const matches: QuoteMatch[] = [];
  let index = block.text.indexOf(quote);
  while (index >= 0) {
    const end = index + quote.length;
    matches.push({
      block,
      startOffset: index,
      endOffset: end,
      pmFrom: block.textStart + index,
      pmTo: block.textStart + end,
    });
    index = block.text.indexOf(quote, index + Math.max(1, quote.length));
  }
  return matches;
}

function findRegexMatches(block: TextBlockRef, re: RegExp | null): QuoteMatch[] {
  if (!re) return [];
  const matches: QuoteMatch[] = [];
  for (const match of block.text.matchAll(re)) {
    const matchedText = match[0] ?? "";
    const index = match.index ?? -1;
    if (index < 0 || matchedText.length === 0) continue;
    const end = index + matchedText.length;
    matches.push({
      block,
      startOffset: index,
      endOffset: end,
      pmFrom: block.textStart + index,
      pmTo: block.textStart + end,
    });
  }
  return matches;
}

function findQuoteMatches(block: TextBlockRef, quote: string): QuoteMatch[] {
  const exact = findExactMatches(block, quote);
  if (exact.length > 0) return exact;
  const whitespace = findRegexMatches(block, buildWhitespacePattern(quote));
  if (whitespace.length > 0) return whitespace;
  return findRegexMatches(block, buildDeepPattern(quote));
}

function contextMatches(
  block: TextBlockRef,
  match: QuoteMatch,
  prefix?: string,
  suffix?: string,
): boolean {
  if (prefix) {
    const before = block.text.slice(0, match.startOffset);
    if (!deepNormalize(before).endsWith(deepNormalize(prefix))) return false;
  }
  if (suffix) {
    const after = block.text.slice(match.endOffset);
    if (!deepNormalize(after).startsWith(deepNormalize(suffix))) return false;
  }
  return true;
}

function chooseUniqueMatch(
  matches: QuoteMatch[],
  conflictBase: Pick<PatchConflict, "message" | "blockId">,
): { ok: true; match: QuoteMatch } | { ok: false; conflict: PatchConflict } {
  if (matches.length === 1) return { ok: true, match: matches[0]! };
  if (matches.length === 0) {
    return {
      ok: false,
      conflict: {
        kind: "target_text_changed",
        message: conflictBase.message,
        blockId: conflictBase.blockId,
      },
    };
  }
  return {
    ok: false,
    conflict: {
      kind: "ambiguous_match",
      message: "目标文本出现多次，缺少足够上下文，未应用修改。",
      blockId: conflictBase.blockId,
    },
  };
}

function preferredBlocks(
  blocks: TextBlockRef[],
  input: BeforeAfterPatchInput,
  chips: readonly ChatChip[] | null | undefined,
): { blocks: TextBlockRef[]; selectedRange?: { from: number; to: number } } {
  // 先按稳定 blockId 精确命中:chip.resourceRef.id 承载前端选中块的 blockId(见
  // WorkspacePage.toContractChip),它不随表格/列表/原子块导致的 PM 位置漂移而失准。
  for (const chip of chips ?? []) {
    const refId = chip.resourceRef?.id;
    if (!refId) continue;
    const hit = blocks.find((block) => block.blockId === refId);
    if (hit) {
      const selectedRange =
        chip.from !== undefined && chip.to !== undefined
          ? { from: chip.from, to: chip.to }
          : undefined;
      return { blocks: [hit], selectedRange };
    }
  }
  for (const chip of chips ?? []) {
    if (chip.from === undefined || chip.to === undefined) continue;
    const hit = blocks.find(
      (block) => chip.from! >= block.textStart && chip.to! <= block.textEnd,
    );
    if (hit) {
      return { blocks: [hit], selectedRange: { from: chip.from, to: chip.to } };
    }
  }
  if (input.blockIndex !== undefined) {
    const scoped = blocks.filter((block) => block.topIndex === input.blockIndex);
    if (scoped.length > 0) return { blocks: scoped };
  }
  return { blocks };
}

function resolveQuoteAnchor(input: {
  doc: PmDoc;
  quote: string;
  prefix?: string;
  suffix?: string;
  blockIndex?: number;
  chips?: readonly ChatChip[] | null;
}): { ok: true; match: QuoteMatch } | { ok: false; conflict: PatchConflict; blockIndex?: number } {
  const blocks = collectTextBlocks(input.doc);
  const preferred = preferredBlocks(
    blocks,
    { before: input.quote, after: "", summary: "", blockIndex: input.blockIndex },
    input.chips,
  );

  if (preferred.selectedRange) {
    const block = preferred.blocks[0]!;
    const startOffset = preferred.selectedRange.from - block.textStart;
    const endOffset = preferred.selectedRange.to - block.textStart;
    const selected = block.text.slice(startOffset, endOffset);
    if (selected === input.quote || deepNormalize(selected) === deepNormalize(input.quote)) {
      return {
        ok: true,
        match: {
          block,
          startOffset,
          endOffset,
          pmFrom: preferred.selectedRange.from,
          pmTo: preferred.selectedRange.to,
        },
      };
    }
  }

  let scopedMatches = preferred.blocks.flatMap((block) =>
    findQuoteMatches(block, input.quote).filter((match) =>
      contextMatches(block, match, input.prefix, input.suffix),
    ),
  );
  let chosen = chooseUniqueMatch(scopedMatches, {
    message: "目标文本在指定块中已变化，无法安全应用修改。",
    blockId: preferred.blocks[0]?.blockId,
  });
  if (chosen.ok) return chosen;
  if (scopedMatches.length > 1) {
    return {
      ok: false,
      conflict: chosen.conflict,
      blockIndex: preferred.blocks[0]?.topIndex,
    };
  }

  scopedMatches = blocks.flatMap((block) =>
    findQuoteMatches(block, input.quote).filter((match) =>
      contextMatches(block, match, input.prefix, input.suffix),
    ),
  );
  chosen = chooseUniqueMatch(scopedMatches, {
    message: "目标文本已变化或所在块已被删除，无法安全应用修改。",
  });
  if (chosen.ok) return chosen;
  const missingPreferredBlock =
    input.blockIndex !== undefined && preferred.blocks.length === 0;
  return {
    ok: false,
    conflict: {
      ...chosen.conflict,
      kind: missingPreferredBlock ? "block_removed" : chosen.conflict.kind,
    },
    blockIndex: input.blockIndex,
  };
}

function chooseDistinctFuzzyCandidates(candidates: FuzzyCandidate[]): FuzzyCandidate[] {
  const ordered = candidates
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.match.pmFrom - b.match.pmFrom);
  const distinct: FuzzyCandidate[] = [];
  for (const candidate of ordered) {
    const overlapsExisting = distinct.some((existing) => {
      if (existing.match.block.blockId !== candidate.match.block.blockId) return false;
      return (
        candidate.match.pmFrom < existing.match.pmTo &&
        existing.match.pmFrom < candidate.match.pmTo
      );
    });
    if (!overlapsExisting) distinct.push(candidate);
  }
  return distinct;
}

function fuzzyCandidatesInBlock(
  block: TextBlockRef,
  quoteChars: readonly string[],
  range?: { from: number; to: number },
): FuzzyCandidate[] {
  const indexed = buildFuzzyIndex(block.text);
  if (indexed.length < SERVER_REANCHOR_MIN_NORMALIZED_LENGTH) return [];
  const quoteLength = quoteChars.length;
  const slack = Math.max(2, Math.floor(quoteLength * SERVER_REANCHOR_WINDOW_VARIANCE));
  const minWindow = Math.max(SERVER_REANCHOR_MIN_NORMALIZED_LENGTH, quoteLength - slack);
  const maxWindow = Math.min(indexed.length, quoteLength + slack);
  const candidates: FuzzyCandidate[] = [];
  const seen = new Set<string>();

  for (let start = 0; start <= indexed.length - minWindow; start++) {
    for (let length = minWindow; length <= maxWindow; length++) {
      const end = start + length;
      if (end > indexed.length) break;
      const first = indexed[start]!;
      const last = indexed[end - 1]!;
      const pmFrom = block.textStart + first.start;
      const pmTo = block.textStart + last.end;
      if (range && (pmFrom < range.from || pmTo > range.to)) continue;
      const key = `${pmFrom}:${pmTo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const confidence = fuzzySimilarity(
        quoteChars,
        indexed.slice(start, end).map((item) => item.ch),
      );
      if (confidence < SERVER_REANCHOR_CANDIDATE_FLOOR) continue;
      candidates.push({
        confidence,
        match: {
          block,
          startOffset: first.start,
          endOffset: last.end,
          pmFrom,
          pmTo,
        },
      });
    }
  }

  return chooseDistinctFuzzyCandidates(candidates);
}

function selectedChipRanges(
  blocks: readonly TextBlockRef[],
  chips: readonly ChatChip[] | null | undefined,
): Array<{ block: TextBlockRef; range: { from: number; to: number } }> {
  const out: Array<{ block: TextBlockRef; range: { from: number; to: number } }> = [];
  for (const chip of chips ?? []) {
    if (chip.from === undefined || chip.to === undefined) continue;
    const from = Math.min(chip.from, chip.to);
    const to = Math.max(chip.from, chip.to);
    const block = blocks.find((candidate) => from >= candidate.textStart && to <= candidate.textEnd);
    if (!block) continue;
    out.push({ block, range: { from, to } });
  }
  return out;
}

function resolveServerReanchor(input: {
  doc: PmDoc;
  quote: string;
  blockIndex?: number;
  chips?: readonly ChatChip[] | null;
}):
  | { ok: true; match: QuoteMatch; telemetry: ServerReanchorTelemetry }
  | { ok: false; telemetry: ServerReanchorTelemetry } {
  const quoteChars = buildFuzzyIndex(input.quote).map((item) => item.ch);
  if (quoteChars.length < SERVER_REANCHOR_MIN_NORMALIZED_LENGTH) {
    return { ok: false, telemetry: { attempted: true, applied: false, matchCount: 0 } };
  }

  const blocks = collectTextBlocks(input.doc);
  let candidates: FuzzyCandidate[] = [];

  if (input.blockIndex !== undefined) {
    const scoped = blocks.filter((block) => block.topIndex === input.blockIndex);
    candidates = scoped.flatMap((block) => fuzzyCandidatesInBlock(block, quoteChars));
  } else {
    const selected = selectedChipRanges(blocks, input.chips);
    if (selected.length > 0) {
      candidates = selected.flatMap(({ block, range }) =>
        fuzzyCandidatesInBlock(block, quoteChars, range),
      );
    } else {
      candidates = blocks.flatMap((block) => fuzzyCandidatesInBlock(block, quoteChars));
    }
  }

  const distinct = chooseDistinctFuzzyCandidates(candidates);
  const [best, second] = distinct;
  const confidence = best?.confidence;
  const highConfidenceCount = distinct.filter(
    (candidate) => candidate.confidence >= SERVER_REANCHOR_MIN_CONFIDENCE,
  ).length;
  const telemetryBase: ServerReanchorTelemetry = {
    attempted: true,
    applied: false,
    ...(confidence !== undefined ? { confidence } : {}),
    matchCount: highConfidenceCount,
  };
  if (!best) return { ok: false, telemetry: telemetryBase };
  const margin = best.confidence - (second?.confidence ?? 0);
  if (
    best.confidence < SERVER_REANCHOR_MIN_CONFIDENCE ||
    highConfidenceCount !== 1 ||
    (second && margin < SERVER_REANCHOR_MIN_MARGIN)
  ) {
    return { ok: false, telemetry: telemetryBase };
  }
  return {
    ok: true,
    match: best.match,
    telemetry: {
      ...telemetryBase,
      applied: true,
      matchCount: 1,
      confidence: best.confidence,
    },
  };
}

function textToInlineNodes(text: string, marks?: readonly PmMark[]): PmInlineNode[] {
  if (text.length === 0) return [];
  const nodes: PmInlineNode[] = [];
  text.split("\n").forEach((part, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (part.length > 0) {
      nodes.push(marks && marks.length > 0 ? { type: "text", text: part, marks: [...marks] } : { type: "text", text: part });
    }
  });
  return nodes;
}

export function parseStructuredAfter(rawAfter: string): PmBlockNode[] | null {
  const parsed = markdownToPm(rawAfter);
  const blocks = parsed.content;
  if (blocks.length === 0) return null;
  const hasHardStructuralBlock = blocks.some((block) =>
    block.type === "table" ||
    block.type === "blockquote" ||
    block.type === "codeBlock" ||
    block.type === "horizontalRule" ||
    block.type === "image",
  );
  const isPureList =
    blocks.length === 1 &&
    (blocks[0]?.type === "bulletList" || blocks[0]?.type === "orderedList");
  return hasHardStructuralBlock || isPureList ? blocks : null;
}

function isWholeBlockReplacement(match: QuoteMatch, before: string): boolean {
  return normalizeWhitespace(before) === normalizeWhitespace(match.block.text);
}

function replaceTopBlockWithBlocks(
  doc: PmDoc,
  match: QuoteMatch,
  blocks: readonly PmBlockNode[],
): PmDoc | null {
  if (match.block.path.length !== 1) return null;
  const topIndex = match.block.topIndex;
  if (topIndex < 0 || topIndex >= doc.content.length) return null;
  return normalizePmDoc({
    ...doc,
    content: [
      ...doc.content.slice(0, topIndex),
      ...blocks,
      ...doc.content.slice(topIndex + 1),
    ],
  });
}

function insertBlocksAfterTopIndex(
  doc: PmDoc,
  topIndex: number,
  blocks: readonly PmBlockNode[],
): PmDoc | null {
  if (blocks.length === 0) return null;
  if (topIndex < 0 || topIndex >= doc.content.length) return null;
  return normalizePmDoc({
    ...doc,
    content: [
      ...doc.content.slice(0, topIndex + 1),
      ...blocks,
      ...doc.content.slice(topIndex + 1),
    ],
  });
}

function insertBlocksAfterTopBlock(
  doc: PmDoc,
  match: QuoteMatch,
  blocks: readonly PmBlockNode[],
): PmDoc | null {
  return insertBlocksAfterTopIndex(doc, match.block.topIndex, blocks);
}

function isInsertionPrefixBlock(
  node: PmBlockNode,
): node is PmBlockNode & { content?: PmInlineNode[] } {
  return node.type === "paragraph" || node.type === "heading" || node.type === "penNote";
}

function structuredInsertionPlan(
  match: QuoteMatch,
  before: string,
  blocks: readonly PmBlockNode[],
): { inlineReplacement: string | null; blocksToInsert: PmBlockNode[] } | null {
  const [first, ...rest] = blocks;
  if (!first) return null;
  if (!isInsertionPrefixBlock(first)) {
    return { inlineReplacement: null, blocksToInsert: [...blocks] };
  }

  const firstText = inlineText(first.content);
  if (rest.length === 0) {
    return { inlineReplacement: null, blocksToInsert: [first] };
  }
  if (
    deepNormalize(firstText) === deepNormalize(match.block.text) ||
    deepNormalize(firstText) === deepNormalize(before)
  ) {
    return { inlineReplacement: null, blocksToInsert: rest };
  }
  return { inlineReplacement: firstText, blocksToInsert: rest };
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

function markForFormat(format: PatchFormat): { op: "add" | "remove"; mark: PmMark } {
  switch (format) {
    case "bold":
      return { op: "add", mark: { type: "bold" } };
    case "unbold":
      return { op: "remove", mark: { type: "bold" } };
  }
}

function applyMarkToInlineContent(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
  format: PatchFormat,
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;
  const { op, mark } = markForFormat(format);

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

    if (before) next.push(setTextNodeMarks({ ...node, text: before }, node.marks ? [...node.marks] : undefined));
    if (middle) {
      const marks =
        op === "add"
          ? addMark(node.marks, mark)
          : removeMark(node.marks, mark);
      next.push(setTextNodeMarks({ ...node, text: middle }, marks));
    }
    if (after) next.push(setTextNodeMarks({ ...node, text: after }, node.marks ? [...node.marks] : undefined));

    offset = nodeTo;
  }

  return next;
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
    if (node.type === "text" && start >= offset && start <= offset + len) {
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

function updateNodeAtPath(
  nodes: readonly PmBlockNode[],
  path: readonly number[],
  update: (node: PmBlockNode) => PmBlockNode,
): PmBlockNode[] {
  const [head, ...rest] = path;
  if (head === undefined) return [...nodes];
  return nodes.map((node, index): PmBlockNode => {
    if (index !== head) return node;
    if (rest.length === 0) return update(node);
    if (!("content" in node) || !Array.isArray(node.content)) return node;
    return {
      ...node,
      content: updateNodeAtPath(node.content as PmBlockNode[], rest, update),
    } as PmBlockNode;
  });
}

function replaceTextInDoc(
  doc: PmDoc,
  match: QuoteMatch,
  replacement: string,
): PmDoc {
  const from = match.pmFrom - match.block.textStart;
  const to = match.pmTo - match.block.textStart;
  const content = updateNodeAtPath(doc.content, match.block.path, (node) => {
    if (!isInlineTextBlock(node)) return node;
    return {
      ...node,
      content: replaceInlineContent(node.content, from, to, replacement),
    } as PmBlockNode;
  });
  return normalizePmDoc({ ...doc, content });
}

export function compileSuggestionFromBeforeAfter(input: {
  doc: PmDoc;
  docId: string;
  baseVersion: number;
  suggestionId: string;
  patch: BeforeAfterPatchInput;
  chips?: readonly ChatChip[] | null;
}): CompileSuggestionResult {
  if (input.patch.format) {
    return {
      ok: false,
      error: "format patches require candidate diff draft mode",
      blockIndex: input.patch.blockIndex,
    };
  }

  const before = stripLeadingHeadingMarker(input.patch.before);
  const rawAfter = stripLeadingHeadingMarker(input.patch.after);
  if (before.trim().length === 0) {
    return { ok: false, error: "before text is empty", blockIndex: input.patch.blockIndex };
  }

  const resolved = resolveQuoteAnchor({
    doc: input.doc,
    quote: before,
    blockIndex: input.patch.blockIndex,
    chips: input.chips,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.conflict.message,
      conflictKind: resolved.conflict.kind,
      blockIndex: resolved.blockIndex,
    };
  }

  const { match } = resolved;
  const structuredAfter = parseStructuredAfter(rawAfter);
  if (structuredAfter) {
    return {
      ok: false,
      error: "block-level after needs candidate diff draft mode",
      blockIndex: match.block.topIndex,
    };
  }
  const after = match.block.node.type === "codeBlock"
    ? rawAfter
    : sanitizeMarkdownInline(rawAfter);
  const prefix = match.block.text.slice(Math.max(0, match.startOffset - CONTEXT_CHARS), match.startOffset);
  const suffix = match.block.text.slice(match.endOffset, match.endOffset + CONTEXT_CHARS);
  const step: PmStep = {
    stepType: "replace",
    from: match.pmFrom,
    to: match.pmTo,
    slice: {
      content: textToInlineNodes(after, inheritedMarks(inlineBlockContent(match.block.node), match.startOffset)),
      openStart: 0,
      openEnd: 0,
    },
  };
  const suggestion: DocSuggestion = {
    id: input.suggestionId,
    docId: input.docId,
    baseVersion: input.baseVersion,
    baseSchemaVersion: input.doc.attrs.schemaVersion,
    status: "reviewing",
    anchor: {
      blockId: match.block.blockId,
      pmFrom: match.pmFrom,
      pmTo: match.pmTo,
      quote: before,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
      textHash: hashText(before),
    },
    patch: { kind: "prosemirror_steps", steps: [step] },
    preview: { deleteText: before, insertText: after },
    summary: input.patch.summary,
  };

  return {
    ok: true,
    record: {
      before,
      after,
      blockIndex: match.block.topIndex,
      suggestion,
    },
  };
}

export function applySuggestionToDoc(
  doc: PmDoc,
  suggestion: DocSuggestion,
  currentVersion: number,
): { ok: true; doc: PmDoc; step: PmStep } | { ok: false; conflict: PatchConflict } {
  const resolved = resolveQuoteAnchor({
    doc,
    quote: suggestion.anchor.quote,
    prefix: suggestion.anchor.prefix,
    suffix: suggestion.anchor.suffix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      conflict: {
        ...resolved.conflict,
        suggestionId: suggestion.id,
        currentVersion,
      },
    };
  }
  const actualText = resolved.match.block.text.slice(
    resolved.match.startOffset,
    resolved.match.endOffset,
  );
  if (hashText(actualText) !== suggestion.anchor.textHash) {
    return {
      ok: false,
      conflict: {
        kind: "target_text_changed",
        message: "目标文本内容已变化，未应用修改。",
        suggestionId: suggestion.id,
        blockId: suggestion.anchor.blockId,
        currentVersion,
      },
    };
  }
  const nextDoc = replaceTextInDoc(doc, resolved.match, suggestion.preview.insertText);
  const step: PmStep = {
    stepType: "replace",
    from: resolved.match.pmFrom,
    to: resolved.match.pmTo,
    slice: {
      content: textToInlineNodes(
        suggestion.preview.insertText,
        inheritedMarks(inlineBlockContent(resolved.match.block.node), resolved.match.startOffset),
      ),
      openStart: 0,
      openEnd: 0,
    },
  };
  return { ok: true, doc: nextDoc, step };
}

function applySuggestionAtStoredRange(
  doc: PmDoc,
  suggestion: DocSuggestion,
  currentVersion: number,
): { ok: true; doc: PmDoc; step: PmStep } | { ok: false; conflict: PatchConflict } {
  const block = collectTextBlocks(doc).find(
    (candidate) =>
      candidate.blockId === suggestion.anchor.blockId &&
      suggestion.anchor.pmFrom >= candidate.textStart &&
      suggestion.anchor.pmTo <= candidate.textEnd,
  );
  if (!block) {
    return {
      ok: false,
      conflict: {
        kind: "block_removed",
        message: "目标块已不存在，未应用修改。",
        suggestionId: suggestion.id,
        blockId: suggestion.anchor.blockId,
        currentVersion,
      },
    };
  }
  const startOffset = suggestion.anchor.pmFrom - block.textStart;
  const endOffset = suggestion.anchor.pmTo - block.textStart;
  const actualText = block.text.slice(startOffset, endOffset);
  if (hashText(actualText) !== suggestion.anchor.textHash) {
    return {
      ok: false,
      conflict: {
        kind: "target_text_changed",
        message: "目标文本内容已变化，未应用修改。",
        suggestionId: suggestion.id,
        blockId: suggestion.anchor.blockId,
        currentVersion,
      },
    };
  }
  const match: QuoteMatch = {
    block,
    startOffset,
    endOffset,
    pmFrom: suggestion.anchor.pmFrom,
    pmTo: suggestion.anchor.pmTo,
  };
  const nextDoc = replaceTextInDoc(doc, match, suggestion.preview.insertText);
  const step: PmStep = {
    stepType: "replace",
    from: suggestion.anchor.pmFrom,
    to: suggestion.anchor.pmTo,
    slice: {
      content: textToInlineNodes(
        suggestion.preview.insertText,
        inheritedMarks(inlineBlockContent(block.node), startOffset),
      ),
      openStart: 0,
      openEnd: 0,
    },
  };
  return { ok: true, doc: nextDoc, step };
}

export function applySuggestionsToDoc(
  doc: PmDoc,
  suggestions: readonly DocSuggestion[],
  currentVersion: number,
): ApplySuggestionsResult {
  let nextDoc = doc;
  const steps: PmStep[] = [];
  const conflicts: PatchConflict[] = [];
  const ordered = suggestions
    .slice()
    .sort((a, b) => b.anchor.pmFrom - a.anchor.pmFrom);
  for (const suggestion of ordered) {
    const storedRangeResult = applySuggestionAtStoredRange(nextDoc, suggestion, currentVersion);
    const result = storedRangeResult.ok
      ? storedRangeResult
      : applySuggestionToDoc(nextDoc, suggestion, currentVersion);
    if (!result.ok) {
      conflicts.push(storedRangeResult.ok ? result.conflict : storedRangeResult.conflict);
      continue;
    }
    nextDoc = result.doc;
    steps.push(result.step);
  }
  return { nextDoc, steps, conflicts };
}

export function applyBeforeAfterPatchToDoc(input: {
  doc: PmDoc;
  patch: BeforeAfterPatchInput;
  chips?: readonly ChatChip[] | null;
}): ApplyBeforeAfterPatchResult {
  const before = stripLeadingHeadingMarker(input.patch.before);
  let effectiveBefore = before;
  let reanchor: ServerReanchorTelemetry | undefined;
  const after = stripLeadingHeadingMarker(input.patch.after);
  const structuredAfter = parseStructuredAfter(after);
  if (before.trim().length === 0) {
    if (
      structuredAfter &&
      input.patch.blockIndex !== undefined &&
      input.doc.content[input.patch.blockIndex]
    ) {
      const structuredDoc = insertBlocksAfterTopIndex(
        input.doc,
        input.patch.blockIndex,
        structuredAfter,
      );
      if (structuredDoc) {
        return {
          ok: true,
          doc: structuredDoc,
          before,
          after,
          blockIndex: input.patch.blockIndex,
        };
      }
    }
    return { ok: false, error: "before text is empty", blockIndex: input.patch.blockIndex };
  }

  let resolved = resolveQuoteAnchor({
    doc: input.doc,
    quote: before,
    blockIndex: input.patch.blockIndex,
    chips: input.chips,
  });
  if (!resolved.ok) {
    if (isServerReanchorEnabled() && resolved.conflict.kind === "target_text_changed") {
      const reanchored = resolveServerReanchor({
        doc: input.doc,
        quote: before,
        blockIndex: input.patch.blockIndex,
        chips: input.chips,
      });
      reanchor = reanchored.telemetry;
      if (reanchored.ok) {
        resolved = { ok: true, match: reanchored.match };
        effectiveBefore = reanchored.match.block.text.slice(
          reanchored.match.startOffset,
          reanchored.match.endOffset,
        );
      }
    }
  }
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.conflict.message,
      conflictKind: resolved.conflict.kind,
      blockIndex: resolved.blockIndex,
      ...(reanchor ? { reanchor } : {}),
    };
  }

  if (input.patch.format) {
    const from = resolved.match.pmFrom - resolved.match.block.textStart;
    const to = resolved.match.pmTo - resolved.match.block.textStart;
    const content = updateNodeAtPath(input.doc.content, resolved.match.block.path, (node) => {
      if (!isInlineTextBlock(node)) return node;
      return {
        ...node,
        content: applyMarkToInlineContent(node.content, from, to, input.patch.format!),
      } as PmBlockNode;
    });
    return {
      ok: true,
      doc: normalizePmDoc({ ...input.doc, content }),
      before: effectiveBefore,
      after: effectiveBefore,
      blockIndex: resolved.match.block.topIndex,
      ...(reanchor ? { reanchor } : {}),
    };
  }

  if (structuredAfter && isWholeBlockReplacement(resolved.match, effectiveBefore)) {
    const structuredDoc = replaceTopBlockWithBlocks(input.doc, resolved.match, structuredAfter);
    if (structuredDoc) {
      return {
        ok: true,
        doc: structuredDoc,
        before: effectiveBefore,
        after,
        blockIndex: resolved.match.block.topIndex,
        ...(reanchor ? { reanchor } : {}),
      };
    }
  }
  if (structuredAfter) {
    const plan = structuredInsertionPlan(resolved.match, effectiveBefore, structuredAfter);
    if (plan) {
      const docWithInlineReplacement = plan.inlineReplacement === null
        ? input.doc
        : replaceTextInDoc(input.doc, resolved.match, plan.inlineReplacement);
      const structuredDoc = insertBlocksAfterTopBlock(
        docWithInlineReplacement,
        resolved.match,
        plan.blocksToInsert,
      );
      if (structuredDoc) {
        return {
          ok: true,
          doc: structuredDoc,
          before: effectiveBefore,
          after,
          blockIndex: resolved.match.block.topIndex,
          ...(reanchor ? { reanchor } : {}),
        };
      }
    }
  }

  return {
    ok: true,
    doc: replaceTextInDoc(input.doc, resolved.match, after),
    before: effectiveBefore,
    after,
    blockIndex: resolved.match.block.topIndex,
    ...(reanchor ? { reanchor } : {}),
  };
}

export function applySuggestionDirectly(
  doc: PmDoc,
  suggestion: DocSuggestion,
): PmDoc {
  const match = collectTextBlocks(doc).find(
    (block) =>
      suggestion.anchor.pmFrom >= block.textStart &&
      suggestion.anchor.pmTo <= block.textEnd,
  );
  if (!match) return doc;
  return replaceTextInDoc(
    doc,
    {
      block: match,
      startOffset: suggestion.anchor.pmFrom - match.textStart,
      endOffset: suggestion.anchor.pmTo - match.textStart,
      pmFrom: suggestion.anchor.pmFrom,
      pmTo: suggestion.anchor.pmTo,
    },
    suggestion.preview.insertText,
  );
}
