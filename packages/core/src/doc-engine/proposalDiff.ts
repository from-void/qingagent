import DiffMatchPatch from "diff-match-patch";
import type { DiffHunk, PmNode as ContractPmNode } from "@qingagent/contract-ts";
import {
  carryOverDiagramUserAttrs,
  carryOverMovedBlockUserAttrs,
  getDeterministicId,
  getStablePmJson,
  normalizePmDoc,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
  type PmNode,
} from "@qingagent/pm-schema";

type BlockPair = {
  baseIndex: number;
  draftIndex: number;
};

type PendingTextChange = {
  baseFrom: number;
  draftFrom: number;
};

type FlatTextUnit = {
  text: string;
  from: number;
  to: number;
  marks: PmMark[];
  atomKey?: string;
};

type MarkGroup = {
  op: "markAdd" | "markRemove" | "replace";
  baseFrom: number;
  baseTo: number;
  draftFrom: number;
  draftTo: number;
  marks: PmMark[];
  beforeMarks?: PmMark[];
  markKey: string;
};

type InlineTextBlock = PmBlockNode & { content?: PmInlineNode[] };

// ── 锚点清理门槛(core 唯一来源,web 一律不得再调)──────────────────────
// 连续公共段(dmp EQUAL)满足「grapheme 数 ≥ ANCHOR_MIN_GRAPHEMES 且不全是标点/空白」
// = 真锚点,保留成拆点;否则(单字 / 纯标点 / 纯空白)并入两侧改动区合成覆盖。
// 见 briefs/260710-review-diff-granularity-analysis.md §4 P1(★裁决:拆干净)。
const ANCHOR_MIN_GRAPHEMES = 2;
// 标点 + 空白 = 不承载语义的"平凡字符"。用 Unicode 属性覆盖中英文标点(。，、！？；：
// 及 ,.!?;: 等)与全部空白;命中不到非平凡字符的公共段不算真锚点。
const TRIVIAL_ANCHOR_CHAR = /[\p{P}\s]/u;

const TEXT_BLOCK_TYPES = new Set<PmBlockNode["type"]>(["paragraph", "heading", "penNote"]);
// 与 packages/pm-schema/src/types.ts 的 PmBlockNode 顶层块联合保持一致。
const BLOCK_NODE_TYPES = new Set<PmNode["type"]>([
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "image",
  "fileAttachment",
  "penNote",
  "table",
  "taskList",
  "callout",
  "blockMath",
  "diagram",
  "columnList",
] satisfies readonly PmBlockNode["type"][]);

export function buildDraftDiff(
  baseDoc: PmDoc,
  draftDoc: PmDoc,
  options: {
    baseVersion?: number;
    ignoreBlockIdentityOnlyReplacements?: boolean;
  } = {},
): DiffHunk[] {
  const normalizedBase = normalizePmDoc(baseDoc);
  const normalizedDraft = normalizePmDoc(draftDoc);
  const overlapRatio = calculateOverlapRatio(docPlainText(normalizedBase), docPlainText(normalizedDraft));
  const textStarts = collectTopLevelTextStarts(normalizedBase);
  const hunks: DiffHunk[] = [];
  const pairs = lcsPairs(
    blockAlignmentKeys(normalizedBase.content),
    blockAlignmentKeys(normalizedDraft.content),
  );

  let baseCursor = 0;
  let draftCursor = 0;
  for (const pair of pairs) {
    appendGapHunks({
      baseDoc: normalizedBase,
      draftDoc: normalizedDraft,
      baseStart: baseCursor,
      baseEnd: pair.baseIndex,
      draftStart: draftCursor,
      draftEnd: pair.draftIndex,
      textStarts,
      overlapRatio,
      hunks,
    });
    appendMatchedBlockHunks({
      baseBlock: normalizedBase.content[pair.baseIndex]!,
      draftBlock: normalizedDraft.content[pair.draftIndex]!,
      baseIndex: pair.baseIndex,
      draftIndex: pair.draftIndex,
      textStart: textStarts[pair.baseIndex] ?? 1,
      overlapRatio,
      hunks,
    });
    baseCursor = pair.baseIndex + 1;
    draftCursor = pair.draftIndex + 1;
  }

  appendGapHunks({
    baseDoc: normalizedBase,
    draftDoc: normalizedDraft,
    baseStart: baseCursor,
    baseEnd: normalizedBase.content.length,
    draftStart: draftCursor,
    draftEnd: normalizedDraft.content.length,
    textStarts,
    overlapRatio,
    hunks,
  });

  const effectiveHunks = options.ignoreBlockIdentityOnlyReplacements
    ? hunks.filter((hunk) => !isBlockIdentityOnlyReplacement(hunk) && !isNormalizedNoopHunk(hunk))
    : hunks;
  const groupedHunks = annotateReviewGroups(effectiveHunks, {
    baseVersion: options.baseVersion ?? 0,
  });
  Object.defineProperty(groupedHunks, "overlapRatio", {
    value: overlapRatio,
    enumerable: false,
    configurable: false,
  });
  return groupedHunks;
}

/**
 * 外部全文编译可能只重建 blockId；这种 replace 的可见文本与实际结构都没变，
 * 在调用方显式开启过滤时不能物化成审阅项。默认保留该 hunk，避免改变批注迁移、
 * pending draft 冷恢复等内部调用方的既有语义。
 *
 * diagram.svg 是可再生渲染缓存，null/undefined attrs 是 PM 默认态，均不算内容变化；
 * diagram.source、mark、块类型和其它有效 attrs 的变化仍会保留。
 */
function isBlockIdentityOnlyReplacement(hunk: DiffHunk): boolean {
  if (
    hunk.op !== "replace" ||
    hunk.beforeText !== hunk.afterText ||
    !hunk.beforeBlock ||
    !hunk.afterBlock
  ) {
    return false;
  }
  return getStablePmJson(normalizeIdentityComparison(hunk.beforeBlock)) ===
    getStablePmJson(normalizeIdentityComparison(hunk.afterBlock));
}

/**
 * P33 通用漏斗：只要 diff 已同时携带 before/after，就按与块身份过滤相同的
 * canonical 规则深比；不限 op 类型，也不依赖 beforeBlock/afterBlock 辅助字段。
 */
export function isNormalizedNoopHunk(hunk: DiffHunk): boolean {
  if (hunk.before === null || hunk.after === null) return false;
  return getStablePmJson(normalizeIdentityComparison(hunk.before)) ===
    getStablePmJson(normalizeIdentityComparison(hunk.after));
}

function normalizeIdentityComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeIdentityComparison);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, child]) => {
    if (key !== "attrs" || !child || typeof child !== "object" || Array.isArray(child)) {
      return [[key, normalizeIdentityComparison(child)] as const];
    }
    const normalizedAttrs = Object.entries(child as Record<string, unknown>)
      .filter(([attr, attrValue]) =>
        attr !== "blockId" &&
        !(record.type === "diagram" && attr === "svg") &&
        attrValue !== null &&
        attrValue !== undefined)
      .map(([attr, attrValue]) => [attr, normalizeIdentityComparison(attrValue)] as const);
    return normalizedAttrs.length > 0
      ? [[key, Object.fromEntries(normalizedAttrs)] as const]
      : [];
  }));
}

export function annotateReviewGroups(
  hunks: readonly DiffHunk[],
  options: { baseVersion?: number } = {},
): DiffHunk[] {
  void options;
  // 用户语义:一处 = 一个程序 diff hunk。reviewBatchId/groupMode 仍保留在 wire
  // contract 里兼容旧会话和前端协议层,但新生成的审阅批次不再按 blockId 原子合并。
  return hunks.map((hunk) => ({
    ...hunk,
    reviewBatchId: hunk.hunkId,
    groupMode: "independent",
  }));
}

export interface ApplyDiffHunksOptions {
  oldBaseDoc?: PmDoc;
}

export interface ApplyDiffHunksResult {
  doc: PmDoc;
  /** 实际落上的 hunk(保持传入顺序)。 */
  applied: DiffHunk[];
  /** 因目标块已被并发删除等原因被跳过、未落上的 hunk(保持传入顺序)。 */
  skipped: DiffHunk[];
  /** 跳过原因，供提交层区分“块删除可局部结算”和“块内容漂移必须整批回滚”。 */
  skippedDetails: Array<{ hunk: DiffHunk; reason: string }>;
}

export function applyDiffHunks(
  baseDoc: PmDoc,
  hunks: readonly DiffHunk[],
  options: ApplyDiffHunksOptions = {},
): ApplyDiffHunksResult {
  let doc = cloneValue(normalizePmDoc(baseDoc));
  // 落库排序(逆文档序)只影响应用顺序,不影响 applied/skipped 的对外顺序。
  const ordered = [...hunks].sort(compareHunksForApply);
  const appliedIds = new Set<string>();
  const skippedReasonById = new Map<string, string>();

  for (const hunk of ordered) {
    const applied = applyDiffHunkToDoc(doc, hunk, options);
    if (applied.ok) {
      doc = applied.doc;
      appliedIds.add(hunk.hunkId);
    } else {
      skippedReasonById.set(hunk.hunkId, applied.reason);
    }
  }

  // applied/skipped 按传入顺序回吐,便于调用方按原顺序生成 steps / 结算 suggestion。
  const applied: DiffHunk[] = [];
  const skipped: DiffHunk[] = [];
  for (const hunk of hunks) {
    (appliedIds.has(hunk.hunkId) ? applied : skipped).push(hunk);
  }

  const skippedDetails = skipped.map((hunk) => ({
    hunk,
    reason: skippedReasonById.get(hunk.hunkId) ?? `failed to apply ${hunk.hunkId}`,
  }));
  // delete/insert 是独立 hunk，单个 insert 分支看不到已删除块；整批回放完成后按
  // 唯一语义身份跨 hunk 承接，才能同时覆盖移动到前方/后方的两种应用顺序。
  const withMovedBlockAttrs = carryOverMovedBlockUserAttrs(baseDoc, doc);
  const appliedWithMovedBlockAttrs = applied.map((hunk) =>
    hunk.op === "insert"
      ? carryAppliedInsertHunkAttrs(hunk, withMovedBlockAttrs.doc)
      : hunk
  );
  return {
    doc: normalizePmDoc(withMovedBlockAttrs.doc),
    applied: appliedWithMovedBlockAttrs,
    skipped,
    skippedDetails,
  };
}

function carryAppliedInsertHunkAttrs(hunk: DiffHunk, appliedDoc: PmDoc): DiffHunk {
  const inserted = nodesToBlocks(hunk.after);
  if (inserted.length === 0) return hunk;
  const byBlockId = new Map(appliedDoc.content.map((block) => [block.attrs.blockId, block]));
  const carried = inserted.map((block) => byBlockId.get(block.attrs.blockId) ?? block);
  if (getStablePmJson(inserted) === getStablePmJson(carried)) return hunk;
  return {
    ...hunk,
    after: cloneValue(carried) as unknown as ContractPmNode[],
    ...(carried.length === 1
      ? { afterBlock: cloneValue(carried[0]) as DiffHunk["afterBlock"] }
      : { afterBlock: undefined }),
  };
}

export type ApplyDiffHunkToDocResult =
  | { ok: true; doc: PmDoc }
  | { ok: false; reason: string };

export function applyDiffHunkToDoc(
  baseDoc: PmDoc,
  hunk: DiffHunk,
  options: ApplyDiffHunksOptions = {},
): ApplyDiffHunkToDocResult {
  const doc = cloneValue(normalizePmDoc(baseDoc));
  const content = doc.content;
  const index = resolveApplyBlockIndex(doc, hunk);
  if (index === null || index < 0) {
    return { ok: false, reason: `missing target block for ${hunk.hunkId}` };
  }

  if (hunk.op === "insert") {
    const blocks = nodesToBlocks(hunk.after);
    if (blocks.length === 0) {
      return { ok: false, reason: `missing inserted blocks for ${hunk.hunkId}` };
    }
    const insertAt = hunk.anchor.gravity === "before" ? index : index + 1;
    const currentBlocks = content.slice(insertAt, insertAt + blocks.length);
    if (
      getStablePmJson(currentBlocks.map(stripDiagramSvgForCompare)) ===
        getStablePmJson(blocks.map(stripDiagramSvgForCompare))
    ) {
      return { ok: true, doc: normalizePmDoc(doc) };
    }
    content.splice(insertAt, 0, ...cloneValue(blocks));
    return { ok: true, doc: normalizePmDoc(doc) };
  }

  if (hunk.op === "delete") {
    const deleteCount = Math.max(1, nodesToBlocks(hunk.before).length);
    const expectedBlocks = nodesToBlocks(hunk.before);
    if (expectedBlocks.length === 0) {
      return { ok: false, reason: `missing expected block for ${hunk.hunkId}` };
    }
    const currentBlocks = content.slice(index, index + deleteCount);
    if (
      getStablePmJson(currentBlocks.map(stripDiagramSvgForCompare)) !==
        getStablePmJson(expectedBlocks.map(stripDiagramSvgForCompare))
    ) {
      return { ok: false, reason: `target block changed for ${hunk.hunkId}` };
    }
    content.splice(index, deleteCount);
    return { ok: true, doc: normalizePmDoc(doc) };
  }

  const currentBlock = content[index];
  if (!currentBlock) {
    return { ok: false, reason: `missing target block for ${hunk.hunkId}` };
  }

  if (isInlineEditableHunk(hunk) && isInlineTextBlock(currentBlock)) {
    if (hasPureInlineInsertEffect({
      currentDoc: doc,
      currentBlock,
      currentIndex: index,
      hunk,
      oldBaseDoc: options.oldBaseDoc,
    })) {
      return { ok: true, doc: normalizePmDoc(doc) };
    }
    const range = resolveInlineApplyRange({
      currentDoc: doc,
      currentBlock,
      currentIndex: index,
      hunk,
      oldBaseDoc: options.oldBaseDoc,
    });
    if (!range) {
      return { ok: false, reason: `missing inline range for ${hunk.hunkId}` };
    }
    const nextBlock =
      hunk.op === "markAdd" || hunk.op === "markRemove"
        ? {
            ...currentBlock,
            content: applyMarksToInlineContent(
              currentBlock.content,
              range.from,
              range.to,
              hunk.marks ?? [],
              hunk.op === "markAdd" ? "add" : "remove",
            ),
          }
        : {
            ...currentBlock,
            content: replaceInlineContentWithNodes(
              currentBlock.content,
              range.from,
              range.to,
              inlineReplacementNodes(hunk),
            ),
          };
    const compactedNextBlock = compactInlineBlock(nextBlock as PmBlockNode);
    const canonicalAfterBlock = canonicalAcceptedBlock(compactedNextBlock, hunk);
    content.splice(index, 1, canonicalAfterBlock ?? compactedNextBlock);
    return { ok: true, doc: normalizePmDoc(doc) };
  }

  const replacement = nodeToBlock(hunk.afterBlock) ?? nodesToBlocks(hunk.after)[0];
  if (!replacement) {
    return { ok: false, reason: `missing replacement block for ${hunk.hunkId}` };
  }
  const expected = nodeToBlock(hunk.beforeBlock) ?? nodesToBlocks(hunk.before)[0];
  if (!expected) {
    return { ok: false, reason: `missing expected block for ${hunk.hunkId}` };
  }
  if (
    getStablePmJson(stripDiagramSvgForCompare(currentBlock)) !==
      getStablePmJson(stripDiagramSvgForCompare(expected))
  ) {
    return { ok: false, reason: `target block changed for ${hunk.hunkId}` };
  }
  content.splice(index, 1, carryOverDiagramUserAttrs(currentBlock, cloneValue(replacement)));
  return { ok: true, doc: normalizePmDoc(doc) };
}

function appendGapHunks(input: {
  baseDoc: PmDoc;
  draftDoc: PmDoc;
  baseStart: number;
  baseEnd: number;
  draftStart: number;
  draftEnd: number;
  textStarts: number[];
  overlapRatio: number;
  hunks: DiffHunk[];
}): void {
  const baseCount = input.baseEnd - input.baseStart;
  const draftCount = input.draftEnd - input.draftStart;
  const pairCount = Math.min(baseCount, draftCount);

  for (let offset = 0; offset < pairCount; offset += 1) {
    const baseIndex = input.baseStart + offset;
    const draftIndex = input.draftStart + offset;
    appendMatchedBlockHunks({
      baseBlock: input.baseDoc.content[baseIndex]!,
      draftBlock: input.draftDoc.content[draftIndex]!,
      baseIndex,
      draftIndex,
      textStart: input.textStarts[baseIndex] ?? 1,
      overlapRatio: input.overlapRatio,
      hunks: input.hunks,
    });
  }

  const deleteStart = input.baseStart + pairCount;
  const deleteBlocks = input.baseDoc.content.slice(deleteStart, input.baseEnd);
  if (deleteBlocks.length > 0) {
    input.hunks.push(createBlockDeleteHunk(deleteBlocks, deleteStart, input.textStarts[deleteStart] ?? 1, input.overlapRatio));
  }

  const insertBlocks = input.draftDoc.content.slice(input.draftStart + pairCount, input.draftEnd);
  if (insertBlocks.length > 0) {
    input.hunks.push(createBlockInsertHunk(input.baseDoc, insertBlocks, input.baseStart + pairCount, input.overlapRatio));
  }
}

/** 比较两块的 attrs 是否一致(忽略 blockId 锚点 + diagram 的 svg 缓存)。键序无关。 */
function blockAttrsEqualIgnoringId(a: PmBlockNode, b: PmBlockNode): boolean {
  const strip = (block: PmBlockNode): Record<string, unknown> => {
    const attrs = { ...((block as { attrs?: Record<string, unknown> }).attrs ?? {}) };
    delete attrs.blockId;
    delete attrs.svg; // diagram 的 svg 是客户端渲染缓存,非文档语义
    delete attrs.overlay; // diagram overlay 是用户视觉域,不进入 AI 审核 diff
    return attrs;
  };
  const stable = (obj: Record<string, unknown>): string =>
    JSON.stringify(obj, Object.keys(obj).sort());
  return stable(strip(a)) === stable(strip(b));
}

/**
 * 比较前归一化:剥掉 diagram 的 svg(客户端渲染缓存,非文档语义)。
 * 否则 base 有缓存 svg、draft 无/不同就会产生假"替换图表"审阅(round-1 ccreview 发现)。
 */
function stripDiagramSvgForCompare(block: PmBlockNode): PmBlockNode {
  if (block.type !== "diagram") return block;
  const attrs = { ...(block.attrs as Record<string, unknown>) };
  delete attrs.svg;
  delete attrs.overlay;
  return { ...block, attrs } as PmBlockNode;
}

function appendMatchedBlockHunks(input: {
  baseBlock: PmBlockNode;
  draftBlock: PmBlockNode;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
  hunks: DiffHunk[];
}): void {
  if (
    getStablePmJson(stripDiagramSvgForCompare(input.baseBlock)) ===
    getStablePmJson(stripDiagramSvgForCompare(input.draftBlock))
  )
    return;

  if (!isInlineTextBlock(input.baseBlock) || !isInlineTextBlock(input.draftBlock) || input.baseBlock.type !== input.draftBlock.type) {
    input.hunks.push(createBlockReplaceHunk(input));
    return;
  }

  // 诊断 p06/p09:同型同文块此前只比 marks,块属性(heading level/codeBlock
  // language 等)差异不产出任何 hunk——编辑成功写进候选却永远进不了提交,
  // 表现为"模型谎报成功 DOM 未变"与"仅改属性的编辑被当 noop 丢弃"。
  // blockId 是锚点标识不算内容差异,剔除后比较其余 attrs。
  if (!blockAttrsEqualIgnoringId(input.baseBlock, input.draftBlock)) {
    input.hunks.push(createBlockReplaceHunk(input));
    return;
  }

  const baseBlock = input.baseBlock;
  const draftBlock = input.draftBlock;
  const baseText = inlineText(baseBlock.content);
  const draftText = inlineText(draftBlock.content);
  if (baseText === draftText) {
    appendInlineAtomReplaceHunks({
      baseBlock,
      draftBlock,
      baseIndex: input.baseIndex,
      draftIndex: input.draftIndex,
      textStart: input.textStart,
      overlapRatio: input.overlapRatio,
      hunks: input.hunks,
      baseText,
      draftText,
      baseFrom: 0,
      draftFrom: 0,
      length: baseText.length,
    });
    appendMarkHunks({
      baseBlock,
      draftBlock,
      baseIndex: input.baseIndex,
      draftIndex: input.draftIndex,
      textStart: input.textStart,
      overlapRatio: input.overlapRatio,
      hunks: input.hunks,
      baseFrom: 0,
      draftFrom: 0,
      length: baseText.length,
    });
    return;
  }

  const dmp = new DiffMatchPatch();
  // 弃用 diff_cleanupSemantic:它两头都坏——既把真锚点吞进改动区(晚风案:公共"晚风"
  // 被并入删除,造出假"新增晚风",正文绿字与卡片说法自相矛盾),又对中文短公共串清不
  // 干净、留下 EQUAL 碎点,害得下方在每段 EQUAL 硬切成"删 1~2 字"的碎渣 hunk。
  // 改用自定义锚点清理:真锚点(≥2 字非全标点)保留成 EQUAL 拆点,单字/纯标点公共段
  // 拆成同文 del+ins 并入两侧,促成"相邻增删=覆盖"。产出严格三态:纯增/纯删/覆盖。
  const diffs = cleanupAnchorDiffs(dmp.diff_main(baseText, draftText));

  let baseOffset = 0;
  let draftOffset = 0;
  let pending: PendingTextChange | null = null;

  const flushPending = (): void => {
    if (!pending) return;
    const hunk = createTextReplaceHunk({
      baseBlock,
      draftBlock,
      baseIndex: input.baseIndex,
      draftIndex: input.draftIndex,
      textStart: input.textStart,
      overlapRatio: input.overlapRatio,
      baseText,
      draftText,
      baseFrom: pending.baseFrom,
      baseTo: baseOffset,
      draftFrom: pending.draftFrom,
      draftTo: draftOffset,
    });
    if (hunk) input.hunks.push(hunk);
    pending = null;
  };

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      flushPending();
      appendInlineAtomReplaceHunks({
        baseBlock,
        draftBlock,
        baseIndex: input.baseIndex,
        draftIndex: input.draftIndex,
        textStart: input.textStart,
        overlapRatio: input.overlapRatio,
        hunks: input.hunks,
        baseText,
        draftText,
        baseFrom: baseOffset,
        draftFrom: draftOffset,
        length: text.length,
      });
      appendMarkHunks({
        baseBlock,
        draftBlock,
        baseIndex: input.baseIndex,
        draftIndex: input.draftIndex,
        textStart: input.textStart,
        overlapRatio: input.overlapRatio,
        hunks: input.hunks,
        baseFrom: baseOffset,
        draftFrom: draftOffset,
        length: text.length,
      });
      baseOffset += text.length;
      draftOffset += text.length;
      continue;
    }

    pending ??= { baseFrom: baseOffset, draftFrom: draftOffset };
    if (op === DiffMatchPatch.DIFF_DELETE) {
      baseOffset += text.length;
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      draftOffset += text.length;
    }
  }

  flushPending();
}

function appendInlineAtomReplaceHunks(input: {
  baseBlock: InlineTextBlock;
  draftBlock: InlineTextBlock;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
  hunks: DiffHunk[];
  baseText: string;
  draftText: string;
  baseFrom: number;
  draftFrom: number;
  length: number;
}): void {
  if (input.length <= 0) return;
  const baseUnits = flattenInlineUnits(input.baseBlock.content);
  const draftUnits = flattenInlineUnits(input.draftBlock.content);
  let baseOffset = input.baseFrom;
  let draftOffset = input.draftFrom;
  const baseEnd = input.baseFrom + input.length;
  while (baseOffset < baseEnd) {
    const baseUnit = unitAtOffset(baseUnits, baseOffset);
    const draftUnit = unitAtOffset(draftUnits, draftOffset);
    if (!baseUnit || !draftUnit) break;
    const unitLength = baseUnit.to - baseUnit.from;
    if (
      baseUnit.text === "￼" &&
      draftUnit.text === "￼" &&
      baseUnit.atomKey !== undefined &&
      draftUnit.atomKey !== undefined &&
      baseUnit.atomKey !== draftUnit.atomKey
    ) {
      const hunk = createInlineAtomReplaceHunk({
        baseBlock: input.baseBlock,
        draftBlock: input.draftBlock,
        baseIndex: input.baseIndex,
        draftIndex: input.draftIndex,
        textStart: input.textStart,
        overlapRatio: input.overlapRatio,
        baseText: input.baseText,
        draftText: input.draftText,
        baseFrom: baseOffset,
        baseTo: baseOffset + unitLength,
        draftFrom: draftOffset,
        draftTo: draftOffset + (draftUnit.to - draftUnit.from),
      });
      if (hunk) input.hunks.push(hunk);
    }
    baseOffset += unitLength;
    draftOffset += draftUnit.to - draftUnit.from;
  }
}

function createInlineAtomReplaceHunk(input: {
  baseBlock: InlineTextBlock;
  draftBlock: InlineTextBlock;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
  baseText: string;
  draftText: string;
  baseFrom: number;
  baseTo: number;
  draftFrom: number;
  draftTo: number;
}): DiffHunk {
  const before = inlineSliceAsNodes(input.baseBlock, input.baseFrom, input.baseTo);
  const after = inlineSliceAsNodes(input.draftBlock, input.draftFrom, input.draftTo);
  const beforeText = input.baseText.slice(input.baseFrom, input.baseTo);
  const afterText = input.draftText.slice(input.draftFrom, input.draftTo);
  const hunkId = createHunkId(
    "replace-inline-atom",
    input.baseIndex,
    input.draftIndex,
    input.baseFrom,
    input.baseTo,
    getStablePmJson(before),
    getStablePmJson(after),
  );
  return createUngroupedHunk({
    hunkId,
    op: "replace",
    blockPath: [input.baseIndex],
    anchor: {
      blockId: input.baseBlock.attrs.blockId,
      quoteBefore: beforeText,
      quoteAfter: afterText,
      pmFrom: input.textStart + input.baseFrom,
      pmTo: input.textStart + input.baseTo,
      anchorKind: "range",
    },
    before,
    after,
    beforeText,
    afterText,
    beforeBlock: cloneValue(input.baseBlock) as DiffHunk["beforeBlock"],
    afterBlock: cloneValue(input.draftBlock) as DiffHunk["afterBlock"],
    summary: "替换行内公式",
    overlapRatio: input.overlapRatio,
  });
}

function appendMarkHunks(input: {
  baseBlock: InlineTextBlock;
  draftBlock: InlineTextBlock;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
  hunks: DiffHunk[];
  baseFrom: number;
  draftFrom: number;
  length: number;
}): void {
  if (input.length <= 0) return;
  const baseUnits = flattenInlineUnits(input.baseBlock.content);
  const draftUnits = flattenInlineUnits(input.draftBlock.content);
  let activeAdd: MarkGroup | null = null;
  let activeRemove: MarkGroup | null = null;
  let activeReplace: MarkGroup | null = null;

  const flushAdd = (): void => {
    if (!activeAdd) return;
    input.hunks.push(createMarkHunk(input, activeAdd));
    activeAdd = null;
  };
  const flushRemove = (): void => {
    if (!activeRemove) return;
    input.hunks.push(createMarkHunk(input, activeRemove));
    activeRemove = null;
  };
  const flushReplace = (): void => {
    if (!activeReplace) return;
    input.hunks.push(createMarkHunk(input, activeReplace));
    activeReplace = null;
  };

  let baseOffset = input.baseFrom;
  let draftOffset = input.draftFrom;
  const baseEnd = input.baseFrom + input.length;
  while (baseOffset < baseEnd) {
    const baseUnit = unitAtOffset(baseUnits, baseOffset);
    const draftUnit = unitAtOffset(draftUnits, draftOffset);
    if (!baseUnit || !draftUnit || baseUnit.text !== draftUnit.text) {
      flushAdd();
      flushRemove();
      flushReplace();
      break;
    }

    const added = markSetDifference(draftUnit.marks, baseUnit.marks);
    const removed = markSetDifference(baseUnit.marks, draftUnit.marks);
    const baseUnitLength = baseUnit.to - baseUnit.from;
    const draftUnitLength = draftUnit.to - draftUnit.from;
    const replacedMarkType = added.some((addedMark) =>
      removed.some((removedMark) => removedMark.type === addedMark.type)
    );

    if (replacedMarkType) {
      flushAdd();
      flushRemove();
      const replaceKey = `${marksKey(removed)}=>${marksKey(added)}`;
      if (
        activeReplace &&
        activeReplace.baseTo === baseOffset &&
        activeReplace.draftTo === draftOffset &&
        activeReplace.markKey === replaceKey
      ) {
        activeReplace.baseTo = baseOffset + baseUnitLength;
        activeReplace.draftTo = draftOffset + draftUnitLength;
      } else {
        flushReplace();
        activeReplace = {
          op: "replace",
          baseFrom: baseOffset,
          baseTo: baseOffset + baseUnitLength,
          draftFrom: draftOffset,
          draftTo: draftOffset + draftUnitLength,
          marks: added,
          beforeMarks: removed,
          markKey: replaceKey,
        };
      }
      baseOffset += baseUnitLength;
      draftOffset += draftUnitLength;
      continue;
    }

    flushReplace();

    if (added.length === 0) {
      flushAdd();
    } else {
      const addKey = marksKey(added);
      if (
        activeAdd &&
        activeAdd.baseTo === baseOffset &&
        activeAdd.draftTo === draftOffset &&
        activeAdd.markKey === addKey
      ) {
        activeAdd.baseTo = baseOffset + baseUnitLength;
        activeAdd.draftTo = draftOffset + draftUnitLength;
      } else {
        flushAdd();
        activeAdd = {
          op: "markAdd",
          baseFrom: baseOffset,
          baseTo: baseOffset + baseUnitLength,
          draftFrom: draftOffset,
          draftTo: draftOffset + draftUnitLength,
          marks: added,
          markKey: addKey,
        };
      }
    }

    if (removed.length === 0) {
      flushRemove();
    } else {
      const removeKey = marksKey(removed);
      if (
        activeRemove &&
        activeRemove.baseTo === baseOffset &&
        activeRemove.draftTo === draftOffset &&
        activeRemove.markKey === removeKey
      ) {
        activeRemove.baseTo = baseOffset + baseUnitLength;
        activeRemove.draftTo = draftOffset + draftUnitLength;
      } else {
        flushRemove();
        activeRemove = {
          op: "markRemove",
          baseFrom: baseOffset,
          baseTo: baseOffset + baseUnitLength,
          draftFrom: draftOffset,
          draftTo: draftOffset + draftUnitLength,
          marks: removed,
          markKey: removeKey,
        };
      }
    }

    baseOffset += baseUnitLength;
    draftOffset += draftUnitLength;
  }

  flushAdd();
  flushRemove();
  flushReplace();
}

function createTextReplaceHunk(input: {
  baseBlock: InlineTextBlock;
  draftBlock: InlineTextBlock;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
  baseText: string;
  draftText: string;
  baseFrom: number;
  baseTo: number;
  draftFrom: number;
  draftTo: number;
}): DiffHunk | null {
  const minimized = minimizeTextChange(input.baseText, input.draftText, input.baseFrom, input.baseTo, input.draftFrom, input.draftTo);
  if (minimized.baseFrom === minimized.baseTo && minimized.draftFrom === minimized.draftTo) return null;

  const beforeText = input.baseText.slice(minimized.baseFrom, minimized.baseTo);
  const afterText = input.draftText.slice(minimized.draftFrom, minimized.draftTo);
  if (beforeText === afterText) return null;

  const hunkId = createHunkId("replace", input.baseIndex, input.draftIndex, minimized.baseFrom, minimized.baseTo, beforeText, afterText);
  return createUngroupedHunk({
    hunkId,
    op: "replace",
    blockPath: [input.baseIndex],
    anchor: {
      blockId: input.baseBlock.attrs.blockId,
      quoteBefore: beforeText,
      quoteAfter: afterText,
      pmFrom: input.textStart + minimized.baseFrom,
      pmTo: input.textStart + minimized.baseTo,
      anchorKind: "range",
    },
    before: inlineSliceAsNodes(input.baseBlock, minimized.baseFrom, minimized.baseTo),
    after: inlineSliceAsNodes(input.draftBlock, minimized.draftFrom, minimized.draftTo),
    beforeText,
    afterText,
    beforeBlock: cloneValue(input.baseBlock) as DiffHunk["beforeBlock"],
    afterBlock: cloneValue(input.draftBlock) as DiffHunk["afterBlock"],
    summary: "替换文本",
    overlapRatio: input.overlapRatio,
  });
}

function createMarkHunk(
  input: {
    baseBlock: InlineTextBlock;
    draftBlock: InlineTextBlock;
    baseIndex: number;
    textStart: number;
    overlapRatio: number;
  },
  group: MarkGroup,
): DiffHunk {
  const beforeText = inlineText(input.baseBlock.content).slice(group.baseFrom, group.baseTo);
  const afterText = inlineText(input.draftBlock.content).slice(group.draftFrom, group.draftTo);
  const hunkId = createHunkId(
    group.op,
    input.baseIndex,
    group.baseFrom,
    group.baseTo,
    group.draftFrom,
    group.draftTo,
    group.markKey,
  );
  return createUngroupedHunk({
    hunkId,
    op: group.op,
    blockPath: [input.baseIndex],
    anchor: {
      blockId: input.baseBlock.attrs.blockId,
      quoteBefore: beforeText,
      quoteAfter: afterText,
      pmFrom: input.textStart + group.baseFrom,
      pmTo: input.textStart + group.baseTo,
      anchorKind: "range",
    },
    before: inlineSliceAsNodes(input.baseBlock, group.baseFrom, group.baseTo),
    after: inlineSliceAsNodes(input.draftBlock, group.draftFrom, group.draftTo),
    ...(group.op === "markAdd" || group.op === "markRemove"
      ? { marks: cloneValue(group.marks) as DiffHunk["marks"] }
      : {}),
    beforeText,
    afterText,
    beforeBlock: cloneValue(input.baseBlock) as DiffHunk["beforeBlock"],
    afterBlock: cloneValue(input.draftBlock) as DiffHunk["afterBlock"],
    summary: group.op === "markAdd"
      ? `添加标记 ${markSummary(group.marks)}`
      : group.op === "markRemove"
        ? `移除标记 ${markSummary(group.marks)}`
        : `替换标记 ${markSummary(group.beforeMarks ?? [])} → ${markSummary(group.marks)}`,
    overlapRatio: input.overlapRatio,
  });
}

function createBlockInsertHunk(baseDoc: PmDoc, draftBlocks: readonly PmBlockNode[], insertIndex: number, overlapRatio: number): DiffHunk {
  const previous = baseDoc.content[insertIndex - 1];
  const next = baseDoc.content[insertIndex];
  const afterText = draftBlocks.map(blockPlainText).filter(Boolean).join("\n");
  const hunkId = createHunkId("insert", insertIndex, draftBlocks);
  return createUngroupedHunk({
    hunkId,
    op: "insert",
    blockPath: [insertIndex],
    anchor: {
      blockId: previous?.attrs.blockId ?? next?.attrs.blockId,
      quoteAfter: afterText,
      anchorKind: "position",
      gravity: previous ? "after" : "before",
    },
    before: null,
    after: cloneValue(draftBlocks) as unknown as ContractPmNode[],
    ...(draftBlocks.length === 1 ? { afterBlock: cloneValue(draftBlocks[0]) as DiffHunk["afterBlock"] } : {}),
    afterText,
    summary: "插入块",
    overlapRatio,
  });
}

function createBlockDeleteHunk(baseBlocks: readonly PmBlockNode[], baseIndex: number, textStart: number, overlapRatio: number): DiffHunk {
  const beforeText = baseBlocks.map(blockPlainText).filter(Boolean).join("\n");
  const hunkId = createHunkId("delete", baseIndex, beforeText, baseBlocks.map((block) => block.attrs.blockId));
  return createUngroupedHunk({
    hunkId,
    op: "delete",
    blockPath: [baseIndex],
    anchor: {
      blockId: baseBlocks[0]?.attrs.blockId,
      quoteBefore: beforeText,
      pmFrom: textStart,
      pmTo: textStart + beforeText.length,
      anchorKind: "range",
    },
    before: cloneValue(baseBlocks) as unknown as ContractPmNode[],
    after: null,
    ...(baseBlocks.length === 1 ? { beforeBlock: cloneValue(baseBlocks[0]) as DiffHunk["beforeBlock"] } : {}),
    beforeText,
    summary: "删除块",
    overlapRatio,
  });
}

function createBlockReplaceHunk(input: {
  baseBlock: PmBlockNode;
  draftBlock: PmBlockNode;
  baseIndex: number;
  draftIndex: number;
  textStart: number;
  overlapRatio: number;
}): DiffHunk {
  const beforeText = blockPlainText(input.baseBlock);
  const afterText = blockPlainText(input.draftBlock);
  const hunkId = createHunkId("replace-block", input.baseIndex, input.draftIndex, beforeText, afterText);
  return createUngroupedHunk({
    hunkId,
    op: "replace",
    blockPath: [input.baseIndex],
    anchor: {
      blockId: input.baseBlock.attrs.blockId,
      quoteBefore: beforeText,
      quoteAfter: afterText,
      pmFrom: input.textStart,
      pmTo: input.textStart + beforeText.length,
      anchorKind: "range",
    },
    before: [cloneValue(input.baseBlock) as unknown as ContractPmNode],
    after: [cloneValue(input.draftBlock) as unknown as ContractPmNode],
    beforeText,
    afterText,
    beforeBlock: cloneValue(input.baseBlock) as DiffHunk["beforeBlock"],
    afterBlock: cloneValue(input.draftBlock) as DiffHunk["afterBlock"],
    summary: "替换块",
    overlapRatio: input.overlapRatio,
  });
}

function lcsPairs(baseKeys: readonly string[], draftKeys: readonly string[]): BlockPair[] {
  const dp = Array.from({ length: baseKeys.length + 1 }, () => Array<number>(draftKeys.length + 1).fill(0));
  for (let i = baseKeys.length - 1; i >= 0; i -= 1) {
    for (let j = draftKeys.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = baseKeys[i] === draftKeys[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const pairs: BlockPair[] = [];
  let i = 0;
  let j = 0;
  while (i < baseKeys.length && j < draftKeys.length) {
    if (baseKeys[i] === draftKeys[j]) {
      pairs.push({ baseIndex: i, draftIndex: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function blockAlignmentKey(block: PmBlockNode): string {
  const blockId = block.attrs.blockId;
  if (blockId && !blockId.startsWith("ai-block-")) return `id:${blockId}`;
  return `fingerprint:${block.type}:${blockPlainText(block).normalize("NFC")}`;
}

function blockAlignmentKeys(blocks: readonly PmBlockNode[]): string[] {
  const occurrences = new Map<string, number>();
  return blocks.map((block) => {
    const key = blockAlignmentKey(block);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    // 相同块的第 n 次出现只与另一侧第 n 次出现对齐，消除重复块 LCS 多解。
    return `${key}\u0000occurrence:${occurrence}`;
  });
}

function minimizeTextChange(
  baseText: string,
  draftText: string,
  baseFrom: number,
  baseTo: number,
  draftFrom: number,
  draftTo: number,
): { baseFrom: number; baseTo: number; draftFrom: number; draftTo: number } {
  let before = baseText.slice(baseFrom, baseTo);
  let after = draftText.slice(draftFrom, draftTo);
  const prefix = commonPrefixLength(before, after);
  baseFrom += prefix;
  draftFrom += prefix;
  before = before.slice(prefix);
  after = after.slice(prefix);
  const suffix = commonSuffixLength(before, after);
  baseTo -= suffix;
  draftTo -= suffix;

  const [safeBaseFrom, safeBaseTo] = alignRangeToGrapheme(baseText, baseFrom, baseTo);
  const [safeDraftFrom, safeDraftTo] = alignRangeToGrapheme(draftText, draftFrom, draftTo);
  return {
    baseFrom: safeBaseFrom,
    baseTo: safeBaseTo,
    draftFrom: safeDraftFrom,
    draftTo: safeDraftTo,
  };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function alignRangeToGrapheme(text: string, from: number, to: number): [number, number] {
  const boundaries = graphemeBoundaries(text);
  let safeFrom = 0;
  let safeTo = text.length;
  for (const boundary of boundaries) {
    if (boundary <= from) safeFrom = boundary;
    if (boundary >= to) {
      safeTo = boundary;
      break;
    }
  }
  return [safeFrom, safeTo];
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => {
      segment(input: string): Iterable<{ segment: string; index: number }>;
    };
  }).Segmenter;

  if (Segmenter) {
    for (const part of new Segmenter("zh", { granularity: "grapheme" }).segment(text)) {
      if (!boundaries.includes(part.index)) boundaries.push(part.index);
      boundaries.push(part.index + part.segment.length);
    }
    return [...new Set(boundaries)].sort((a, b) => a - b);
  }

  let offset = 0;
  for (const char of text) {
    offset += char.length;
    boundaries.push(offset);
  }
  return boundaries;
}

/**
 * 真锚点判定:grapheme 数 ≥ ANCHOR_MIN_GRAPHEMES 且含至少一个非标点非空白字符。
 * 单字母(英文 a/I)、单字、纯标点、纯空白公共段都不算真锚点——一律并入两侧改动区。
 */
function isTextAnchor(text: string): boolean {
  if (text.length === 0) return false;
  if (graphemeBoundaries(text).length - 1 < ANCHOR_MIN_GRAPHEMES) return false;
  for (const ch of text) {
    if (!TRIVIAL_ANCHOR_CHAR.test(ch)) return true;
  }
  return false;
}

/**
 * 自定义锚点清理(替代 diff_cleanupSemantic):遍历 dmp diff,
 * 非真锚点的 EQUAL 段拆成同文 [DELETE][INSERT] 并入两侧改动区(合成覆盖),
 * 真锚点 EQUAL 段原样保留成拆点。产出交给下方按 EQUAL 硬切,自然得严格三态。
 * diff_main 内部已 cleanupMerge,EQUAL 段是极大公共串,锚点判定直接落在其上即可。
 */
function cleanupAnchorDiffs(diffs: [number, string][]): [number, string][] {
  const out: [number, string][] = [];
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL && !isTextAnchor(text)) {
      out.push([DiffMatchPatch.DIFF_DELETE, text]);
      out.push([DiffMatchPatch.DIFF_INSERT, text]);
    } else {
      out.push([op, text]);
    }
  }
  return out;
}

function flattenInlineUnits(content: readonly PmInlineNode[] | undefined): FlatTextUnit[] {
  const units: FlatTextUnit[] = [];
  let offset = 0;
  for (const node of content ?? []) {
    if (node.type === "hardBreak") {
      units.push({ text: "\n", from: offset, to: offset + 1, marks: [] });
      offset += 1;
      continue;
    }
    // 行内原子节点占 1 个单位，文本投影用 U+FFFC 占位（与 PM nodeSize 一致）。
    if (node.type === "inlineMath") {
      units.push({
        text: "￼",
        from: offset,
        to: offset + 1,
        marks: [],
        atomKey: `inlineMath:${node.attrs.latex}`,
      });
      offset += 1;
      continue;
    }
    if (node.type === "footnoteReference") {
      units.push({
        text: "￼",
        from: offset,
        to: offset + 1,
        marks: [],
        atomKey: `footnoteReference:${node.attrs.id}:${node.attrs.note}`,
      });
      offset += 1;
      continue;
    }

    for (const [from, to] of graphemeRanges(node.text)) {
      units.push({
        text: node.text.slice(from, to),
        from: offset + from,
        to: offset + to,
        marks: normalizeMarks(node.marks),
      });
    }
    offset += node.text.length;
  }
  return units;
}

function graphemeRanges(text: string): Array<[number, number]> {
  const boundaries = graphemeBoundaries(text);
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index]!;
    const to = boundaries[index + 1]!;
    if (from !== to) ranges.push([from, to]);
  }
  return ranges;
}

function unitAtOffset(units: readonly FlatTextUnit[], offset: number): FlatTextUnit | undefined {
  return units.find((unit) => offset >= unit.from && offset < unit.to);
}

function inlineSliceAsNodes(block: PmBlockNode, from: number, to: number): DiffHunk["before"] {
  if (!isInlineTextBlock(block)) return null;
  const nodes: PmInlineNode[] = [];
  let offset = 0;
  for (const node of block.content ?? []) {
    const length = node.type === "text" ? node.text.length : 1;
    const nodeFrom = offset;
    const nodeTo = offset + length;
    const sliceFrom = Math.max(from, nodeFrom);
    const sliceTo = Math.min(to, nodeTo);
    if (sliceFrom < sliceTo) {
      if (node.type === "hardBreak") {
        nodes.push({ type: "hardBreak" });
      } else if (node.type === "inlineMath") {
        nodes.push({ type: "inlineMath", attrs: { latex: node.attrs.latex } });
      } else if (node.type === "footnoteReference") {
        nodes.push({
          type: "footnoteReference",
          attrs: { id: node.attrs.id, note: node.attrs.note },
        });
      } else {
        const text = node.text.slice(sliceFrom - nodeFrom, sliceTo - nodeFrom);
        nodes.push(node.marks && node.marks.length > 0 ? { type: "text", text, marks: cloneValue(node.marks) } : { type: "text", text });
      }
    }
    offset = nodeTo;
  }
  return nodes as DiffHunk["before"];
}

function calculateOverlapRatio(baseText: string, draftText: string): number {
  const maxLength = Math.max(baseText.length, draftText.length);
  if (maxLength === 0) return 1;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(baseText, draftText);
  dmp.diff_cleanupSemantic(diffs);
  const common = diffs.reduce((sum, [op, text]) => op === DiffMatchPatch.DIFF_EQUAL ? sum + text.length : sum, 0);
  return common / maxLength;
}

function compareHunksForApply(left: DiffHunk, right: DiffHunk): number {
  const leftIndex = left.blockPath[0] ?? 0;
  const rightIndex = right.blockPath[0] ?? 0;
  if (leftIndex !== rightIndex) return rightIndex - leftIndex;
  const leftFrom = left.anchor.pmFrom ?? 0;
  const rightFrom = right.anchor.pmFrom ?? 0;
  if (leftFrom !== rightFrom) return rightFrom - leftFrom;
  return applyOpRank(left.op) - applyOpRank(right.op);
}

function applyOpRank(op: DiffHunk["op"]): number {
  if (op === "delete") return 0;
  if (op === "replace" || op === "markAdd" || op === "markRemove") return 1;
  return 2;
}

function resolveApplyBlockIndex(
  doc: PmDoc,
  hunk: DiffHunk,
): number | null {
  const blockId = hunk.anchor.blockId;
  if (blockId) {
    const anchored = doc.content.findIndex((block) => block.attrs.blockId === blockId);
    if (anchored >= 0) return anchored;
    return null;
  }
  const index = hunk.blockPath[0];
  return index === undefined || index < 0 || index > doc.content.length ? null : index;
}

function isInlineNode(node: PmNode): node is PmInlineNode {
  return node.type === "text" ||
    node.type === "hardBreak" ||
    node.type === "inlineMath" ||
    node.type === "footnoteReference";
}

function isInlineNodeList(nodes: DiffHunk["before"] | DiffHunk["after"]): boolean {
  return Array.isArray(nodes) && nodes.every((node) => isInlineNode(node as PmNode));
}

function isInlineEditableHunk(hunk: DiffHunk): boolean {
  if (hunk.op === "markAdd" || hunk.op === "markRemove") return true;
  return hunk.op === "replace" && isInlineNodeList(hunk.before) && isInlineNodeList(hunk.after);
}

function inlineReplacementNodes(hunk: DiffHunk): PmInlineNode[] {
  return Array.isArray(hunk.after) && isInlineNodeList(hunk.after)
    ? cloneValue(hunk.after as PmInlineNode[])
    : [];
}

function inlineNodeLen(node: PmInlineNode): number {
  return node.type === "text" ? node.text.length : 1;
}

function textToInlineNodes(text: string, marks?: readonly PmMark[]): PmInlineNode[] {
  if (text.length === 0) return [];
  const nodes: PmInlineNode[] = [];
  text.split("\n").forEach((part, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (part.length > 0) {
      nodes.push(
        marks && marks.length > 0
          ? { type: "text", text: part, marks: cloneValue(marks) as PmMark[] }
          : { type: "text", text: part },
      );
    }
  });
  return nodes;
}

function inheritedMarks(
  content: readonly PmInlineNode[] | undefined,
  start: number,
): PmMark[] | undefined {
  let offset = 0;
  for (const node of content ?? []) {
    const length = inlineNodeLen(node);
    if (node.type === "text" && start >= offset && start <= offset + length) {
      return node.marks ? cloneValue(node.marks) as PmMark[] : undefined;
    }
    offset += length;
  }
  return undefined;
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

function replaceInlineContentWithNodes(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
  replacementNodes: readonly PmInlineNode[],
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;
  let inserted = false;
  const replacement =
    replacementNodes.length > 0
      ? cloneValue(replacementNodes) as PmInlineNode[]
      : textToInlineNodes("", inheritedMarks(content, from));

  for (const node of content ?? []) {
    const length = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + length;
    if (nodeTo <= from || nodeFrom >= to) {
      if (!inserted && nodeFrom >= to) {
        next.push(...cloneValue(replacement));
        inserted = true;
      }
      next.push(cloneValue(node));
      offset = nodeTo;
      continue;
    }

    if (node.type === "text") {
      const keepBefore = Math.max(0, from - nodeFrom);
      const keepAfter = Math.min(length, to - nodeFrom);
      const [before, after] = splitTextNode(node, keepBefore, keepAfter);
      if (before) next.push(before);
      if (!inserted) {
        next.push(...cloneValue(replacement));
        inserted = true;
      }
      if (after) next.push(after);
    } else if (!inserted) {
      next.push(...cloneValue(replacement));
      inserted = true;
    }
    offset = nodeTo;
  }

  if (!inserted) next.push(...cloneValue(replacement));
  return next;
}

function sameMark(left: PmMark, right: PmMark): boolean {
  return getStablePmJson(left) === getStablePmJson(right);
}

function setTextNodeMarks(
  node: Extract<PmInlineNode, { type: "text" }>,
  marks: PmMark[] | undefined,
): PmInlineNode {
  return marks && marks.length > 0 ? { ...node, marks } : { type: "text", text: node.text };
}

function addMarks(
  current: readonly PmMark[] | undefined,
  marks: readonly PmMark[],
): PmMark[] | undefined {
  const next = current ? cloneValue(current) as PmMark[] : [];
  for (const mark of marks) {
    if (!next.some((candidate) => sameMark(candidate, mark))) {
      next.push(cloneValue(mark));
    }
  }
  return next.length > 0 ? next : undefined;
}

function removeMarks(
  current: readonly PmMark[] | undefined,
  marks: readonly PmMark[],
): PmMark[] | undefined {
  const next = (current ?? []).filter(
    (candidate) => !marks.some((mark) => sameMark(candidate, mark)),
  );
  return next.length > 0 ? cloneValue(next) as PmMark[] : undefined;
}

function applyMarksToInlineContent(
  content: readonly PmInlineNode[] | undefined,
  from: number,
  to: number,
  marks: readonly PmMark[],
  op: "add" | "remove",
): PmInlineNode[] {
  const next: PmInlineNode[] = [];
  let offset = 0;

  for (const node of content ?? []) {
    const length = inlineNodeLen(node);
    const nodeFrom = offset;
    const nodeTo = offset + length;

    if (node.type !== "text" || nodeTo <= from || nodeFrom >= to) {
      next.push(cloneValue(node));
      offset = nodeTo;
      continue;
    }

    const markFrom = Math.max(from, nodeFrom) - nodeFrom;
    const markTo = Math.min(to, nodeTo) - nodeFrom;
    const before = node.text.slice(0, markFrom);
    const middle = node.text.slice(markFrom, markTo);
    const after = node.text.slice(markTo);

    if (before) {
      next.push(setTextNodeMarks({ ...node, text: before }, node.marks ? cloneValue(node.marks) as PmMark[] : undefined));
    }
    if (middle) {
      const nextMarks = op === "add"
        ? addMarks(node.marks, marks)
        : removeMarks(node.marks, marks);
      next.push(setTextNodeMarks({ ...node, text: middle }, nextMarks));
    }
    if (after) {
      next.push(setTextNodeMarks({ ...node, text: after }, node.marks ? cloneValue(node.marks) as PmMark[] : undefined));
    }

    offset = nodeTo;
  }

  return next;
}

function stripNonSemanticBlockAttrs(block: PmBlockNode): Record<string, unknown> {
  const attrs = { ...((block as { attrs?: Record<string, unknown> }).attrs ?? {}) };
  delete attrs.blockId;
  delete attrs.svg;
  delete attrs.overlay;
  return attrs;
}

function sameMarks(left: readonly PmMark[] | undefined, right: readonly PmMark[] | undefined): boolean {
  return getStablePmJson(normalizeMarks(left)) === getStablePmJson(normalizeMarks(right));
}

function compactInlineContent(content: readonly PmInlineNode[] | undefined): PmInlineNode[] {
  const out: PmInlineNode[] = [];
  for (const node of content ?? []) {
    const last = out[out.length - 1];
    if (
      node.type === "text" &&
      last?.type === "text" &&
      sameMarks(last.marks, node.marks)
    ) {
      out[out.length - 1] = { ...last, text: last.text + node.text };
      continue;
    }
    out.push(cloneValue(node));
  }
  return out;
}

function compactInlineBlock(block: PmBlockNode): PmBlockNode {
  if (!isInlineTextBlock(block)) return block;
  return {
    ...block,
    content: compactInlineContent(block.content),
  } as PmBlockNode;
}

function canonicalInlineBlockForCompare(block: PmBlockNode): unknown {
  if (!isInlineTextBlock(block)) {
    return {
      type: block.type,
      attrs: stripNonSemanticBlockAttrs(block),
      content: "content" in block ? block.content : undefined,
    };
  }
  return {
    type: block.type,
    attrs: stripNonSemanticBlockAttrs(block),
    content: compactInlineContent(block.content),
  };
}

function canonicalAcceptedBlock(currentBlock: PmBlockNode, hunk: DiffHunk): PmBlockNode | null {
  const afterBlock = nodeToBlock(hunk.afterBlock);
  if (!afterBlock) return null;
  return getStablePmJson(canonicalInlineBlockForCompare(currentBlock)) ===
    getStablePmJson(canonicalInlineBlockForCompare(afterBlock))
    ? cloneValue(afterBlock)
    : null;
}

function mapTextOffset(oldText: string, currentText: string, oldOffset: number): number {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, currentText);
  dmp.diff_cleanupSemantic(diffs);
  let oldCursor = 0;
  let currentCursor = 0;
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      if (oldOffset <= oldCursor + text.length) {
        return currentCursor + Math.max(0, oldOffset - oldCursor);
      }
      oldCursor += text.length;
      currentCursor += text.length;
      continue;
    }
    if (op === DiffMatchPatch.DIFF_DELETE) {
      if (oldOffset <= oldCursor + text.length) return currentCursor;
      oldCursor += text.length;
      continue;
    }
    currentCursor += text.length;
  }
  return currentCursor;
}

function textDistance(left: string, right: string): number {
  if (left === right) return 0;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(left, right);
  dmp.diff_cleanupSemantic(diffs);
  return dmp.diff_levenshtein(diffs);
}

function findClosestTextMatch(text: string, quote: string, hint: number): number | null {
  if (quote.length === 0) return Math.min(Math.max(hint, 0), text.length);
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let index = text.indexOf(quote);
  while (index >= 0) {
    const distance = Math.abs(index - hint);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    index = text.indexOf(quote, index + Math.max(1, quote.length));
  }
  return best;
}

function inlineTextStartForDoc(doc: PmDoc, blockIndex: number): number | null {
  return collectTopLevelTextStarts(doc)[blockIndex] ?? null;
}

function relativeRangeFromHunk(
  hunk: DiffHunk,
  oldBaseDoc: PmDoc | undefined,
  currentDoc: PmDoc,
  currentIndex: number,
): { from: number; to: number; oldText: string } | null {
  const oldIndex = hunk.blockPath[0] ?? currentIndex;
  const rangeDoc = oldBaseDoc ?? currentDoc;
  const rangeIndex = oldBaseDoc ? oldIndex : currentIndex;
  const textStart = inlineTextStartForDoc(rangeDoc, rangeIndex);
  if (textStart === null || hunk.anchor.pmFrom === undefined) return null;
  const oldBlock = rangeDoc.content[rangeIndex];
  const oldText = oldBlock && isInlineTextBlock(oldBlock) ? inlineText(oldBlock.content) : "";
  const from = Math.max(0, hunk.anchor.pmFrom - textStart);
  const to = Math.max(from, (hunk.anchor.pmTo ?? hunk.anchor.pmFrom) - textStart);
  return { from, to, oldText };
}

type InlineApplyRangeCandidate = { from: number; to: number };

const PURE_INSERT_CONTEXT_RADIUS = 64;
const PURE_INSERT_MAX_CANDIDATES = 96;

function targetInlineTextFromHunk(hunk: DiffHunk): string | null {
  const afterBlock = nodeToBlock(hunk.afterBlock);
  return afterBlock && isInlineTextBlock(afterBlock) ? inlineText(afterBlock.content) : null;
}

function hasPureInlineInsertEffect(input: {
  currentDoc: PmDoc;
  currentBlock: InlineTextBlock;
  currentIndex: number;
  hunk: DiffHunk;
  oldBaseDoc?: PmDoc;
}): boolean {
  if (
    input.hunk.op !== "replace" ||
    (input.hunk.beforeText ?? "") !== "" ||
    (input.hunk.afterText ?? "") === "" ||
    !isInlineNodeList(input.hunk.after)
  ) {
    return false;
  }
  const relative = relativeRangeFromHunk(
    input.hunk,
    input.oldBaseDoc,
    input.currentDoc,
    input.currentIndex,
  );
  if (!relative) return false;
  const currentText = inlineText(input.currentBlock.content);
  const mappedFrom = mapTextOffset(relative.oldText, currentText, relative.from);
  const afterText = input.hunk.afterText ?? "";
  if (currentText.slice(mappedFrom, mappedFrom + afterText.length) !== afterText) {
    return false;
  }
  const currentSlice = inlineSliceAsNodes(
    input.currentBlock,
    mappedFrom,
    mappedFrom + afterText.length,
  );
  return getStablePmJson(compactInlineContent(currentSlice as PmInlineNode[])) ===
    getStablePmJson(compactInlineContent(input.hunk.after as PmInlineNode[]));
}

function addUniqueRangeCandidate(
  candidates: InlineApplyRangeCandidate[],
  seen: Set<string>,
  candidate: InlineApplyRangeCandidate,
): void {
  const key = `${candidate.from}:${candidate.to}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

function hasRangeCandidateCapacity(candidates: readonly InlineApplyRangeCandidate[]): boolean {
  return candidates.length < PURE_INSERT_MAX_CANDIDATES;
}

function addBoundedRangeCandidate(
  candidates: InlineApplyRangeCandidate[],
  seen: Set<string>,
  candidate: InlineApplyRangeCandidate,
): void {
  if (!hasRangeCandidateCapacity(candidates)) return;
  addUniqueRangeCandidate(candidates, seen, candidate);
}

function addInsertCandidateWindow(input: {
  candidates: InlineApplyRangeCandidate[];
  seen: Set<string>;
  center: number;
  textLength: number;
  radius: number;
}): void {
  const center = Math.min(Math.max(input.center, 0), input.textLength);
  addBoundedRangeCandidate(input.candidates, input.seen, { from: center, to: center });
  for (let offset = 1; offset <= input.radius && hasRangeCandidateCapacity(input.candidates); offset += 1) {
    const left = center - offset;
    const right = center + offset;
    if (left >= 0) addBoundedRangeCandidate(input.candidates, input.seen, { from: left, to: left });
    if (right <= input.textLength) addBoundedRangeCandidate(input.candidates, input.seen, { from: right, to: right });
  }
}

function addTargetDerivedInsertCandidates(input: {
  candidates: InlineApplyRangeCandidate[];
  seen: Set<string>;
  currentText: string;
  targetText: string;
  afterText: string;
}): void {
  if (input.afterText.length === 0) return;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(input.targetText, input.currentText);
  dmp.diff_cleanupSemantic(diffs);
  let currentCursor = 0;
  for (const [op, text] of diffs) {
    if (!hasRangeCandidateCapacity(input.candidates)) return;
    if (op === DiffMatchPatch.DIFF_EQUAL || op === DiffMatchPatch.DIFF_INSERT) {
      currentCursor += text.length;
      continue;
    }
    if (text.includes(input.afterText)) {
      addBoundedRangeCandidate(input.candidates, input.seen, {
        from: currentCursor,
        to: currentCursor,
      });
    }
  }
}

function addContextDerivedInsertCandidates(input: {
  candidates: InlineApplyRangeCandidate[];
  seen: Set<string>;
  currentText: string;
  oldText: string;
  oldFrom: number;
}): void {
  const contextLengths = [48, 32, 16, 8, 4, 2, 1];
  for (const length of contextLengths) {
    if (!hasRangeCandidateCapacity(input.candidates)) return;
    const left = input.oldText.slice(Math.max(0, input.oldFrom - length), input.oldFrom);
    const right = input.oldText.slice(input.oldFrom, input.oldFrom + length);
    if (left.length > 0) {
      let index = input.currentText.indexOf(left);
      while (index >= 0 && hasRangeCandidateCapacity(input.candidates)) {
        const candidate = index + left.length;
        if (right.length === 0 || input.currentText.startsWith(right, candidate)) {
          addBoundedRangeCandidate(input.candidates, input.seen, { from: candidate, to: candidate });
        }
        index = input.currentText.indexOf(left, index + 1);
      }
    } else if (right.length > 0) {
      let index = input.currentText.indexOf(right);
      while (index >= 0 && hasRangeCandidateCapacity(input.candidates)) {
        addBoundedRangeCandidate(input.candidates, input.seen, { from: index, to: index });
        index = input.currentText.indexOf(right, index + 1);
      }
    }
  }
}

function collectInlineRangeCandidates(input: {
  currentText: string;
  beforeText: string;
  afterText: string;
  mappedFrom: number;
  mappedTo: number;
  relative: { from: number; oldText: string };
  targetText: string | null;
}): InlineApplyRangeCandidate[] {
  const candidates: InlineApplyRangeCandidate[] = [];
  const seen = new Set<string>();
  const mappedFrom = Math.min(Math.max(input.mappedFrom, 0), input.currentText.length);
  const mappedTo = Math.min(Math.max(input.mappedTo, mappedFrom), input.currentText.length);

  if (input.beforeText.length === 0) {
    if (input.targetText === null) {
      addUniqueRangeCandidate(candidates, seen, { from: mappedFrom, to: mappedFrom });
      return candidates;
    }
    addInsertCandidateWindow({
      candidates,
      seen,
      center: mappedFrom,
      textLength: input.currentText.length,
      radius: PURE_INSERT_CONTEXT_RADIUS,
    });
    addTargetDerivedInsertCandidates({
      candidates,
      seen,
      currentText: input.currentText,
      targetText: input.targetText,
      afterText: input.afterText,
    });
    addContextDerivedInsertCandidates({
      candidates,
      seen,
      currentText: input.currentText,
      oldText: input.relative.oldText,
      oldFrom: input.relative.from,
    });
    return candidates;
  }

  let index = input.currentText.indexOf(input.beforeText);
  while (index >= 0) {
    addUniqueRangeCandidate(candidates, seen, {
      from: index,
      to: index + input.beforeText.length,
    });
    index = input.currentText.indexOf(input.beforeText, index + Math.max(1, input.beforeText.length));
  }

  if (input.currentText.slice(mappedFrom, mappedFrom + input.beforeText.length) === input.beforeText) {
    addUniqueRangeCandidate(candidates, seen, {
      from: mappedFrom,
      to: mappedFrom + input.beforeText.length,
    });
  }

  if (candidates.length === 0 && input.currentText.slice(mappedFrom, mappedTo) === input.beforeText) {
    addUniqueRangeCandidate(candidates, seen, { from: mappedFrom, to: mappedTo });
  }

  return candidates;
}

function contextDistance(input: {
  oldText: string;
  currentText: string;
  oldFrom: number;
  oldTo: number;
  currentFrom: number;
  currentTo: number;
}): number {
  const contextLength = 24;
  const oldLeft = input.oldText.slice(Math.max(0, input.oldFrom - contextLength), input.oldFrom);
  const oldRight = input.oldText.slice(input.oldTo, input.oldTo + contextLength);
  const currentLeft = input.currentText.slice(Math.max(0, input.currentFrom - contextLength), input.currentFrom);
  const currentRight = input.currentText.slice(input.currentTo, input.currentTo + contextLength);
  return textDistance(oldLeft, currentLeft.slice(-oldLeft.length)) +
    textDistance(oldRight, currentRight.slice(0, oldRight.length));
}

function chooseInlineApplyRange(input: {
  candidates: readonly InlineApplyRangeCandidate[];
  currentText: string;
  hunk: DiffHunk;
  targetText: string | null;
  mappedFrom: number;
  mappedTo: number;
  relative: { from: number; to: number; oldText: string };
}): InlineApplyRangeCandidate | null {
  const afterText = input.hunk.afterText ?? "";
  let best: InlineApplyRangeCandidate | null = null;
  let bestScore: [number, number, number, number] | null = null;

  for (const candidate of input.candidates) {
    const nextText = input.currentText.slice(0, candidate.from) +
      afterText +
      input.currentText.slice(candidate.to);
    const targetScore = input.targetText === null ? 0 : textDistance(nextText, input.targetText);
    const contextScore = contextDistance({
      oldText: input.relative.oldText,
      currentText: input.currentText,
      oldFrom: input.relative.from,
      oldTo: input.relative.to,
      currentFrom: candidate.from,
      currentTo: candidate.to,
    });
    const mappedScore = Math.abs(candidate.from - input.mappedFrom) + Math.abs(candidate.to - input.mappedTo);
    const score: [number, number, number, number] = [targetScore, contextScore, mappedScore, candidate.from];
    if (
      bestScore === null ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] === bestScore[2] && score[3] < bestScore[3])
    ) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function resolveInlineApplyRange(input: {
  currentDoc: PmDoc;
  currentBlock: InlineTextBlock;
  currentIndex: number;
  hunk: DiffHunk;
  oldBaseDoc?: PmDoc;
}): { from: number; to: number } | null {
  const relative = relativeRangeFromHunk(
    input.hunk,
    input.oldBaseDoc,
    input.currentDoc,
    input.currentIndex,
  );
  if (!relative) return null;
  const currentText = inlineText(input.currentBlock.content);
  const mappedFrom = mapTextOffset(relative.oldText, currentText, relative.from);
  const mappedTo = mapTextOffset(relative.oldText, currentText, relative.to);
  const beforeText = input.hunk.beforeText ?? "";
  const targetText = targetInlineTextFromHunk(input.hunk);
  const candidates = collectInlineRangeCandidates({
    currentText,
    beforeText,
    afterText: input.hunk.afterText ?? "",
    mappedFrom,
    mappedTo,
    relative,
    targetText,
  });
  const chosen = chooseInlineApplyRange({
    candidates,
    currentText,
    hunk: input.hunk,
    targetText,
    mappedFrom,
    mappedTo,
    relative,
  });
  if (chosen) return chosen;

  if (beforeText.length === 0) {
    const from = Math.min(Math.max(mappedFrom, 0), currentText.length);
    return { from, to: from };
  }

  const mappedSlice = currentText.slice(mappedFrom, mappedFrom + beforeText.length);
  if (mappedSlice === beforeText) {
    return { from: mappedFrom, to: mappedFrom + beforeText.length };
  }

  const matched = findClosestTextMatch(currentText, beforeText, mappedFrom);
  if (matched === null) return null;
  return { from: matched, to: matched + beforeText.length };
}

function collectTopLevelTextStarts(doc: PmDoc): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const block of doc.content) {
    starts.push(pos + 1);
    pos += nodeSize(block);
  }
  return starts;
}

function nodeSize(node: PmNode | PmDoc): number {
  if (node.type === "doc") return node.content.reduce((sum, child) => sum + nodeSize(child), 0);
  if (node.type === "text") return node.text.length;
  if (node.type === "hardBreak") return 1;
  if (!("content" in node) || !Array.isArray(node.content)) return 1;
  return 2 + node.content.reduce((sum, child) => sum + nodeSize(child as PmNode), 0);
}

function isInlineTextBlock(node: PmBlockNode): node is InlineTextBlock {
  return TEXT_BLOCK_TYPES.has(node.type);
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

function docPlainText(doc: PmDoc): string {
  return doc.content.map(blockPlainText).filter(Boolean).join("\n");
}

function blockPlainText(node: PmNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
    case "penNote":
    case "codeBlock":
      return (node.content ?? [])
        .map((child) => {
          if (child.type === "hardBreak") return "\n";
          if (child.type === "inlineMath") return child.attrs.latex;
          if (child.type === "footnoteReference") return child.attrs.note;
          return child.text;
        })
        .join("");
    case "blockquote":
      return node.content.map(blockPlainText).join("\n");
    case "bulletList":
    case "orderedList":
      return node.content.map(blockPlainText).join("\n");
    case "listItem":
      return node.content.map(blockPlainText).join("\n");
    case "horizontalRule":
      return "";
    case "image":
      return node.attrs.caption ?? node.attrs.alt ?? "";
    case "diagram":
      return node.attrs.source;
    case "fileAttachment":
      return node.attrs.filename;
    case "table":
      return node.content.map(blockPlainText).join("\n");
    case "tableRow":
      return node.content.map(blockPlainText).join("\t");
    case "tableCell":
    case "tableHeader":
      return node.content.map(blockPlainText).join("\n");
    case "taskList":
      return node.content.map(blockPlainText).join("\n");
    case "taskItem":
      return `${node.attrs.checked ? "[x]" : "[ ]"} ${node.content.map(blockPlainText).join("\n")}`;
    case "callout":
      return node.content.map(blockPlainText).join("\n");
    case "columnList":
      return node.content.map(blockPlainText).join("\n");
    case "column":
      return node.content.map(blockPlainText).join("\n");
    case "blockMath":
      return node.attrs.latex;
    case "inlineMath":
      return node.attrs.latex;
    case "footnoteReference":
      return node.attrs.note;
  }
}

function normalizeMarks(marks: readonly PmMark[] | undefined): PmMark[] {
  const byKey = new Map<string, PmMark>();
  for (const mark of marks ?? []) {
    byKey.set(getStablePmJson(mark), mark);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, mark]) => mark);
}

function markSetDifference(left: readonly PmMark[], right: readonly PmMark[]): PmMark[] {
  const rightKeys = new Set(right.map((mark) => getStablePmJson(mark)));
  return normalizeMarks(left.filter((mark) => !rightKeys.has(getStablePmJson(mark))));
}

function marksKey(marks: readonly PmMark[]): string {
  return normalizeMarks(marks).map((mark) => getStablePmJson(mark)).join("|");
}

function markSummary(marks: readonly PmMark[]): string {
  return normalizeMarks(marks).map((mark) => mark.type).join(",");
}

function createHunkId(...parts: unknown[]): string {
  return getDeterministicId("diff-hunk", parts);
}

function createUngroupedHunk(
  hunk: Omit<DiffHunk, "reviewBatchId" | "groupMode">,
): DiffHunk {
  return {
    ...hunk,
    reviewBatchId: hunk.hunkId,
    groupMode: "independent",
  };
}

function nodeToBlock(node: DiffHunk["afterBlock"]): PmBlockNode | undefined {
  if (!node || !BLOCK_NODE_TYPES.has(node.type)) return undefined;
  return node as PmBlockNode;
}

function nodesToBlocks(nodes: DiffHunk["before"] | DiffHunk["after"]): PmBlockNode[] {
  return (nodes ?? []).filter((node): node is PmBlockNode => BLOCK_NODE_TYPES.has(node.type));
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
