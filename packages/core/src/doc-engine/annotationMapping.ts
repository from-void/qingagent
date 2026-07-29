import type {
  AnnotationGroup,
  DiffHunk,
  SuggestionAnchor,
} from "@qingagent/contract-ts";
import type { PmDoc, PmInlineNode, PmStep } from "@qingagent/pm-schema";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { projectInlineNodeText } from "../utils/pmTextBlocks.js";
import { diffHunkToStep } from "./draftReviewSuggestions.js";
import { buildDraftDiff } from "./proposalDiff.js";
import { normalizeAnnotationQuote } from "./textEditOps.js";

function nodeSize(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const value = node as { type?: unknown; text?: unknown; content?: unknown };
  if (value.type === "text") return typeof value.text === "string" ? value.text.length : 0;
  if (!Array.isArray(value.content)) return 1;
  const content = value.content;
  return 2 + content.reduce<number>((sum, child) => sum + nodeSize(child), 0);
}

export function pmDocContentSize(doc: PmDoc): number {
  return doc.content.reduce<number>((sum, child) => sum + nodeSize(child), 0);
}

function textBetweenPmDoc(doc: PmDoc, from: number, to: number): string {
  const chunks: string[] = [];
  const visit = (node: unknown, pos: number, isDoc = false): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: unknown; text?: unknown; content?: unknown };
    if (
      value.type === "text" ||
      value.type === "hardBreak" ||
      value.type === "inlineMath" ||
      value.type === "footnoteReference"
    ) {
      const text = projectInlineNodeText(value as PmInlineNode);
      const start = Math.max(0, from - pos);
      const end = Math.min(text.length, to - pos);
      if (start < end) chunks.push(text.slice(start, end));
      return;
    }
    const content = Array.isArray(value.content) ? value.content : [];
    let childPos = isDoc ? pos : pos + 1;
    for (const child of content) {
      const size = nodeSize(child);
      if (childPos < to && childPos + size > from) visit(child, childPos);
      childPos += size;
    }
  };
  visit(doc, 0, true);
  return chunks.join("");
}

function insertedSize(step: PmStep): number {
  const slice = step.slice as { content?: unknown; openStart?: number; openEnd?: number } | undefined;
  if (step.stepType !== "replace" || !Array.isArray(slice?.content)) return 0;
  return Math.max(0, slice.content.reduce<number>((sum, node) => sum + nodeSize(node), 0)
    - (slice.openStart ?? 0) - (slice.openEnd ?? 0));
}

export function mappingFromPmSteps(steps: readonly PmStep[]): Mapping {
  const mapping = new Mapping();
  for (const step of steps) {
    if (step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number") {
      mapping.appendMap(new StepMap([step.from, step.to - step.from, insertedSize(step)]));
    } else {
      mapping.appendMap(StepMap.empty);
    }
  }
  return mapping;
}

const INLINE_NODE_TYPES = new Set(["text", "hardBreak", "inlineMath", "footnoteReference"]);

function isBlockLevelHunk(hunk: DiffHunk): boolean {
  if (hunk.op === "markAdd" || hunk.op === "markRemove") return false;
  const nodes = [...(hunk.before ?? []), ...(hunk.after ?? [])];
  return nodes.some((node) => !INLINE_NODE_TYPES.has(node.type));
}

function topLevelBlockStart(doc: PmDoc, index: number): number {
  return doc.content
    .slice(0, index)
    .reduce<number>((sum, block) => sum + nodeSize(block), 0);
}

function resolveBlockIndex(doc: PmDoc, hunk: DiffHunk): number | null {
  const blockId = hunk.anchor.blockId;
  if (blockId) {
    const anchored = doc.content.findIndex((block) => block.attrs.blockId === blockId);
    if (anchored >= 0) return anchored;
  }
  const pathIndex = hunk.blockPath[0];
  return pathIndex !== undefined && pathIndex >= 0 && pathIndex <= doc.content.length
    ? pathIndex
    : null;
}

function blockHunkRange(doc: PmDoc, hunk: DiffHunk): { from: number; to: number } | null {
  const index = resolveBlockIndex(doc, hunk);
  if (index === null) return null;

  if (hunk.op === "insert") {
    const anchoredBlock = doc.content[index];
    if (hunk.anchor.blockId && anchoredBlock?.attrs.blockId === hunk.anchor.blockId) {
      const from = topLevelBlockStart(doc, index);
      const boundary = hunk.anchor.gravity === "after" ? from + nodeSize(anchoredBlock) : from;
      return { from: boundary, to: boundary };
    }
    const boundary = topLevelBlockStart(doc, index);
    return { from: boundary, to: boundary };
  }

  const beforeBlockCount = Math.max(
    1,
    (hunk.before ?? []).filter((node) => !INLINE_NODE_TYPES.has(node.type)).length,
  );
  if (index >= doc.content.length || index + beforeBlockCount > doc.content.length) return null;
  const from = topLevelBlockStart(doc, index);
  const to = doc.content
    .slice(index, index + beforeBlockCount)
    .reduce<number>((sum, block) => sum + nodeSize(block), from);
  return { from, to };
}

/**
 * 将 diff hunk 转成基于真实文档边界的 PM step。
 *
 * 块级 hunk 的 anchor.pmFrom/pmTo 是正文文本坐标或根本不存在，不能拿来替代
 * 顶层块边界；损坏的历史 hunk 若两套锚点都无法定位，则返回非 replace 步，
 * 让批注映射走原句校验而不是伪造位置 0 的插入。
 */
export function diffHunkToPmStep(baseDoc: PmDoc, hunk: DiffHunk): PmStep {
  if (isBlockLevelHunk(hunk)) {
    const range = blockHunkRange(baseDoc, hunk);
    return range
      ? diffHunkToStep(hunk, range.from, range.to)
      : { stepType: "annotationMappingUnknown" };
  }
  if (hunk.anchor.pmFrom === undefined) return { stepType: "annotationMappingUnknown" };
  return diffHunkToStep(
    hunk,
    hunk.anchor.pmFrom,
    hunk.anchor.pmTo ?? hunk.anchor.pmFrom,
  );
}

/**
 * 为“权威候选终稿整批落地”生成只供 annotation 锚点迁移使用的细粒度步骤。
 *
 * 正文事务仍可用一条全文 replace 原子落地，但该粗步骤不能表达哪些区域实际没改。
 * 这里从真实 base/final 文档重新求 diff，并按文档位置倒序排列：高位步骤先映射后，
 * 低位步骤的 base 坐标仍然有效，同时低位改动仍会正确平移高位锚点。
 */
export function buildAnnotationMappingSteps(baseDoc: PmDoc, finalDoc: PmDoc): PmStep[] {
  return buildDraftDiff(baseDoc, finalDoc)
    .map((hunk) => diffHunkToPmStep(baseDoc, hunk))
    .sort((left, right) => {
      const leftFrom = typeof left.from === "number" ? left.from : Number.NEGATIVE_INFINITY;
      const rightFrom = typeof right.from === "number" ? right.from : Number.NEGATIVE_INFINITY;
      const fromDelta = rightFrom - leftFrom;
      if (fromDelta !== 0) return fromDelta;
      const leftTo = typeof left.to === "number" ? left.to : leftFrom;
      const rightTo = typeof right.to === "number" ? right.to : rightFrom;
      return rightTo - leftTo;
    });
}

export type MappedAnnotationGroups = {
  groups: AnnotationGroup[];
  survivingAnchorIndexes: Map<string, number[]>;
  invalidatedAnchorIndexes: Map<string, number[]>;
  unlocatedGroupCount: number;
};

export function buildAnnotationMappingNotice(
  survivingGroupCount: number,
  unlocatedGroupCount: number,
): string {
  const located = `批注落地结果：${survivingGroupCount}处已定位`;
  return unlocatedGroupCount > 0
    ? `${located}；${unlocatedGroupCount}处因文档已改动未能定位。`
    : `${located}。`;
}

export function mapAnnotationGroupsThroughSteps(
  groups: readonly AnnotationGroup[],
  steps: readonly PmStep[],
  finalDoc?: PmDoc,
): MappedAnnotationGroups {
  const maps = steps.map((step) => step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number"
    ? new StepMap([step.from, step.to - step.from, insertedSize(step)])
    : StepMap.empty);
  const survivingAnchorIndexes = new Map<string, number[]>();
  const invalidatedAnchorIndexes = new Map<string, number[]>();
  let unlocatedGroupCount = 0;
  const mapped = groups.flatMap((group) => {
    const anchors: SuggestionAnchor[] = [];
    const indexes: number[] = [];
    const invalidIndexes: number[] = [];
    group.anchors.forEach((anchor, index) => {
      let from = anchor.pmFrom;
      let to = anchor.pmTo;
      let touched = false;
      let fallbackValidation = false;
      maps.forEach((map, stepIndex) => {
        const step = steps[stepIndex]!;
        if (step.stepType === "replace" && typeof step.from === "number" && typeof step.to === "number") {
          touched ||= step.from === step.to
            ? from < step.from && step.from < to
            : step.from < to && step.to > from;
        } else {
          // 未知/非 replace 步不猜坐标变化；最终仍用原句做一次兜底校验。
          fallbackValidation = true;
        }
        from = map.map(from, 1);
        to = map.map(to, -1);
      });
      const mappedQuote = finalDoc && (touched || fallbackValidation)
        ? textBetweenPmDoc(finalDoc, from, to)
        : anchor.quote;
      const textChanged = mappedQuote !== anchor.quote
        && normalizeAnnotationQuote(mappedQuote) !== normalizeAnnotationQuote(anchor.quote);
      if (from >= to || textChanged) {
        invalidIndexes.push(index);
        return;
      }
      anchors.push({ ...anchor, pmFrom: from, pmTo: to });
      indexes.push(index);
    });
    if (invalidIndexes.length > 0) invalidatedAnchorIndexes.set(group.id, invalidIndexes);
    // 同一问题的多个落点可以独立漂移：只忽略失效锚点，至少一个落点仍在就保留该组。
    if (anchors.length === 0) {
      unlocatedGroupCount += 1;
      return [];
    }
    survivingAnchorIndexes.set(group.id, indexes);
    return [{ ...group, anchors }];
  });
  return {
    groups: mapped,
    survivingAnchorIndexes,
    invalidatedAnchorIndexes,
    unlocatedGroupCount,
  };
}
