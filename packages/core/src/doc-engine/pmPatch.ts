import crypto from "node:crypto";
import type {
  DocSuggestion,
  PatchConflict,
} from "@qingagent/contract-ts";
import {
  normalizePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
  type PmNode,
  type PmStep,
} from "@qingagent/pm-schema";

export interface ApplySuggestionsResult {
  nextDoc: PmDoc;
  steps: PmStep[];
  conflicts: PatchConflict[];
}

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

// 行内原子节点（PM nodeSize=1）统一用 U+FFFC 投影，保证 offset 与 PM 位置一致。
function inlineNodeLen(node: PmInlineNode): number {
  return node.type === "text" ? node.text.length : 1;
}

function inlineText(content: readonly PmInlineNode[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath" || node.type === "footnoteReference") return "￼";
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

function resolveQuoteAnchor(input: {
  doc: PmDoc;
  quote: string;
  prefix?: string;
  suffix?: string;
}): { ok: true; match: QuoteMatch } | { ok: false; conflict: PatchConflict } {
  const blocks = collectTextBlocks(input.doc);
  const matches = blocks.flatMap((block) =>
    findQuoteMatches(block, input.quote).filter((match) =>
      contextMatches(block, match, input.prefix, input.suffix),
    ),
  );
  return chooseUniqueMatch(matches, {
    message: "目标文本已变化或所在块已被删除，无法安全应用修改。",
  });
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
