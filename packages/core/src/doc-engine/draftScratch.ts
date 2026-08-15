import type { DiffHunk } from "@qingagent/contract-ts";
import {
  PM_SCHEMA_VERSION,
  assertUniquePmBlockIds,
  findPmTableByBlockId,
  getPmContentHash,
  getStablePmJson,
  isGeneratedAiBlockId,
  materializeDraftBlockIds,
  pmToPlainText,
  pmTableLogicalGrid,
  safeParsePmDoc,
  type PmDoc,
  type PmTableCellNode,
  type PmTableNode,
} from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import { documentDraftRepo } from "@qingagent/db";
import { hasCanonicalDoc } from "./docFacts.js";
import { buildDraftDiff } from "./proposalDiff.js";
import type { SessionState } from "../session/sessionState.js";
import {
  assertTurnWriteAllowed,
  type TurnWriteGuard,
} from "../utils/turnWriteGuard.js";
import {
  currentDraftMutationRevision,
  DraftMutationConflictError,
} from "../utils/draftMutation.js";

export {
  currentDraftMutationRevision,
  DRAFT_MUTATION_CONFLICT_ERROR,
  DraftMutationConflictError,
} from "../utils/draftMutation.js";

const logger = mastra.getLogger();

function advanceDraftMutationRevision(state: SessionState): void {
  state._draftMutationRevision = currentDraftMutationRevision(state) + 1;
}

export function clonePmDoc(doc: PmDoc): PmDoc {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(doc) as PmDoc;
  }
  return JSON.parse(JSON.stringify(doc)) as PmDoc;
}

export function currentPmDoc(state: SessionState): PmDoc {
  return state.doc ?? {
    type: "doc",
    attrs: { schemaVersion: PM_SCHEMA_VERSION },
    content: [],
  };
}

export function hasNonEmptyCanonicalBase(state: SessionState, baseDoc: PmDoc): boolean {
  return hasCanonicalDoc(state) && pmToPlainText(baseDoc).trim().length > 0;
}

export function ensureDraftCandidateDoc(state: SessionState): PmDoc {
  if (!state.docDraftBaseDoc) {
    // canonical 基底的 blockId 是持久化身份，哪怕前缀仍是历史/合法的 `ai-block-*`
    // 也绝不能只在候选侧 materialize。否则 diff 锚点会记录改名后的 id，而审核提交
    // 从 documents 读取的基底仍保留原 id，最终把真实可应用修改误判为 block_removed。
    // 新生成块的临时 id 仍由 replaceDraftCandidateDoc / applyBlockEdits 在候选侧物化。
    const baseDoc = currentPmDoc(state);
    assertUniquePmBlockIds(baseDoc);
    state.docDraftBaseDoc = clonePmDoc(baseDoc);
    state.docDraftBaseVersion = state.docVersion;
  }
  if (!state.docDraftCandidateDoc) {
    state.docDraftCandidateDoc = clonePmDoc(state.docDraftBaseDoc);
    advanceDraftMutationRevision(state);
  }
  return state.docDraftCandidateDoc;
}

export function clearInMemoryDraftDocs(state: SessionState): void {
  state.docDraftBaseVersion = null;
  state.docDraftBaseDoc = null;
  state.docDraftCandidateDoc = null;
  advanceDraftMutationRevision(state);
}

export function clearDraftConfirmationState(state: SessionState): void {
  clearInMemoryDraftDocs(state);
}

/**
 * canonical 正文被用户写入后，旧候选不再有资格作为下一轮基线。
 * 内存先同步失效；持久化草稿清理失败时冷恢复仍会按 base hash 冲突关闭，不能阻断已成功的正文保存回执。
 */
export async function invalidateDraftStateAfterCanonicalWrite(state: SessionState): Promise<void> {
  clearDraftConfirmationState(state);
  clearSuggestionReviewState(state);
  await documentDraftRepo.clear(state.docId).catch((error) => {
    logger.warn("Failed to clear stale draft after canonical document write", {
      sessionId: state.sessionId,
      docId: state.docId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function replaceDraftCandidateDoc(
  state: SessionState,
  doc: PmDoc,
  writeGuard?: TurnWriteGuard,
  expectedMutationRevision?: number,
  options: { preserveExistingNodes?: boolean } = {},
): PmDoc {
  let materializedDoc: PmDoc;
  if (options.preserveExistingNodes) {
    const baseDoc = state.docDraftBaseDoc ?? currentPmDoc(state);
    const preservedIds = new Set(collectAllBlockIds(baseDoc));
    const needsMaterialization = collectAllBlockIds(doc).some(
      (blockId) => isGeneratedAiBlockId(blockId) && !preservedIds.has(blockId),
    );
    // 局部操作若没有引入新的 ai-block-*，直接复用候选节点；这样 canonical
    // 旧块的 blockId 与节点引用都不会被一次全篇 normalize/materialize 改写。
    materializedDoc = needsMaterialization
      ? materializeDraftBlockIds(doc, {
          namespace: "draft.replace",
          preserveIds: preservedIds,
        })
      : doc;
    if (!needsMaterialization) {
      assertUniquePmBlockIds(materializedDoc);
      // safeParse 只做 doc 级 schema 校验，不使用其重建后的 data，避免抵消
      // preserveExistingNodes 对未触碰节点引用的复用收益。
      const parsed = safeParsePmDoc(materializedDoc);
      if (!parsed.success) {
        throw new Error(`draft candidate 未过 pmDocSchema: ${parsed.error.message}`);
      }
    }
  } else {
    materializedDoc = materializeDraftBlockIds(doc, { namespace: "draft.replace" });
  }
  if (writeGuard) assertTurnWriteAllowed(state, writeGuard);
  if (
    expectedMutationRevision !== undefined &&
    currentDraftMutationRevision(state) !== expectedMutationRevision
  ) {
    throw new DraftMutationConflictError();
  }
  if (!state.docDraftBaseDoc) {
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseDoc = clonePmDoc(currentPmDoc(state));
  }
  state.docDraftBaseDoc ??= clonePmDoc(currentPmDoc(state));
  state.docDraftCandidateDoc = materializedDoc;
  advanceDraftMutationRevision(state);
  return state.docDraftCandidateDoc;
}

function collectAllBlockIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectAllBlockIds);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const attrs = record.attrs && typeof record.attrs === "object"
    ? record.attrs as Record<string, unknown>
    : null;
  const own = typeof attrs?.blockId === "string" ? [attrs.blockId] : [];
  return [...own, ...collectAllBlockIds(record.content)];
}

export async function saveDraftCandidateCheckpoint(opts: {
  state: SessionState;
  streamId: string;
  toolCallId: string;
}): Promise<void> {
  const { state, streamId, toolCallId } = opts;
  const draftDoc = state.docDraftCandidateDoc;
  if (!draftDoc) return;

  const baseDoc = state.docDraftBaseDoc ?? currentPmDoc(state);
  const baseVersion = state.docDraftBaseVersion ?? state.docVersion;
  await documentDraftRepo.saveCandidate({
    docId: state.docId,
    threadId: state.threadId ?? state.sessionId,
    baseVersion,
    baseHash: getPmContentHash(baseDoc),
    draftPmDoc: draftDoc,
    sourceStreamId: streamId,
    sourceToolCallId: toolCallId,
  });
}

export function currentDraftMutationStats(state: SessionState): { changed: boolean; hunkCount: number } {
  const draftDoc = state.docDraftCandidateDoc;
  if (!draftDoc) return { changed: false, hunkCount: 0 };
  const baseDoc = state.docDraftBaseDoc ?? currentPmDoc(state);
  const hunks = buildDraftDiff(baseDoc, draftDoc, {
    baseVersion: state.docDraftBaseVersion ?? state.docVersion,
  });
  return { changed: hunks.length > 0, hunkCount: hunks.length };
}

export function warnIfSelectionDiffEscapesSelectedBlocks(input: {
  state: SessionState;
  hunks: readonly DiffHunk[];
  streamId: string;
  runId: string;
}): void {
  const selectedBlockIds = new Set(
    (input.state._currentChips ?? [])
      .filter((chip) => chip.kind.kind === "selection")
      .map((chip) => chip.resourceRef?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (selectedBlockIds.size === 0) return;

  const escaped = input.hunks
    .map((hunk) => ({
      hunkId: hunk.hunkId,
      op: hunk.op,
      anchorBlockId: hunk.anchor.blockId ?? null,
      blockPath: hunk.blockPath,
    }))
    .filter((hunk) => !hunk.anchorBlockId || !selectedBlockIds.has(hunk.anchorBlockId));

  if (escaped.length === 0) return;
  logger.warn("Selection-scoped draft diff touched blocks outside selected block; allowing candidate", {
    sessionId: input.state.sessionId,
    streamId: input.streamId,
    runId: input.runId,
    selectedBlockIds: [...selectedBlockIds],
    escapedHunks: escaped,
  });
}

export interface TableSelectionScopeViolation {
  ok: false;
  tableRef: string;
  rowIndex: number;
  columnIndex: number;
  error: string;
}

export type TableSelectionScopeResult = { ok: true } | TableSelectionScopeViolation;

/**
 * cell 内的块 id 会在整表 replaceBlock 时由 aiIrToPm 重新派生，不代表内容变化。
 * diagram.svg 是客户端渲染缓存，aiIrToPm 也会归零；除此之外的 attrs、marks、文本与结构都保留。
 * attrs 里值为 null/undefined 的键与"键不存在"等价(PM attrs 的 null 即默认态):真实编辑器
 * 节点常带显式 textAlign:null 等默认键,aiIrToPm 重建节点则缺省不写——键集差异不是内容变化,
 * 不归一会造成"未选行逐字保留的整表替换"被假阳性拒绝(2026-07-12 浏览器验收实录)。
 */
function stripBlockIdsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBlockIdsDeep);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]) => {
    if (key !== "attrs" || !item || typeof item !== "object" || Array.isArray(item)) {
      return [[key, stripBlockIdsDeep(item)] as const];
    }
    const normalized = Object.entries(item)
      .filter(([attrName, attrValue]) =>
        attrName !== "blockId" &&
        !(record.type === "diagram" && attrName === "svg") &&
        attrValue !== null &&
        attrValue !== undefined)
      .map(([attrName, attrValue]) => [attrName, stripBlockIdsDeep(attrValue)] as const);
    // attrs 归一后为空时整个键丢弃,与"节点无 attrs"等价。
    return normalized.length > 0 ? [[key, Object.fromEntries(normalized)] as const] : [];
  }));
}

function tableCellFingerprint(cell: PmTableCellNode | undefined): string | null {
  if (!cell) return null;
  const attrs = cell.attrs;
  return JSON.stringify({
    type: cell.type,
    text: pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: cell.content }).trim(),
    // 纯文本相同时仍需识别未选单元格里的 mark、链接及子块结构变化。
    content: getStablePmJson(stripBlockIdsDeep(cell.content)),
    attrs: {
      // 显式默认值与缺省键等价:colspan/rowspan 缺省即 1,colwidth/backgroundColor 缺省即 null。
      colspan: attrs?.colspan ?? 1,
      rowspan: attrs?.rowspan ?? 1,
      colwidth: attrs?.colwidth ?? null,
      backgroundColor: attrs?.backgroundColor ?? null,
    },
  });
}

function replaceReferencedTable(value: unknown, tableRef: string, replacement: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceReferencedTable(item, tableRef, replacement));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const attrs = record.attrs;
  if (
    record.type === "table" &&
    attrs &&
    typeof attrs === "object" &&
    (attrs as Record<string, unknown>).blockId === tableRef
  ) {
    return replacement;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, replaceReferencedTable(item, tableRef, replacement)]),
  );
}

function documentOutsideTableFingerprint(doc: PmDoc, tableRef: string): string {
  return getStablePmJson(replaceReferencedTable(doc, tableRef, { type: "tableSelectionTarget" }));
}

function documentScopeViolation(tableRef: string, detail: string): TableSelectionScopeViolation {
  return {
    ok: false,
    tableRef,
    rowIndex: -1,
    columnIndex: -1,
    error: `表格选区越界:${detail};本轮仅允许修改表 ref="${tableRef}" 的选中范围，请先 readDraft 核对后重试。`,
  };
}

function scopeViolation(input: {
  tableRef: string;
  axis: "row" | "column";
  startIndex: number;
  endIndex: number;
  rowIndex: number;
  columnIndex: number;
}): TableSelectionScopeViolation {
  const axisLabel = input.axis === "row" ? "行" : "列";
  return {
    ok: false,
    tableRef: input.tableRef,
    rowIndex: input.rowIndex,
    columnIndex: input.columnIndex,
    error:
      `表格选区越界:未选中的 0-based 位置 row=${input.rowIndex}, column=${input.columnIndex} 发生变化;` +
      `本轮仅允许修改表 ref="${input.tableRef}" 的第 ${input.startIndex}..${input.endIndex} ${axisLabel},` +
      `请先 readDraft 核对后缩小 editDraft 操作范围重试。`,
  };
}

function compareRowsAt(
  before: PmTableNode,
  after: PmTableNode,
  beforeRowIndex: number,
  afterRowIndex: number,
  selection: { axis: "row" | "column"; startIndex: number; endIndex: number },
  tableRef: string,
): TableSelectionScopeResult {
  const beforeRow = pmTableLogicalGrid(before)[beforeRowIndex];
  const afterRow = pmTableLogicalGrid(after)[afterRowIndex];
  const width = Math.max(beforeRow?.length ?? 0, afterRow?.length ?? 0);
  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    if (tableCellFingerprint(beforeRow?.[columnIndex]) !== tableCellFingerprint(afterRow?.[columnIndex])) {
      return scopeViolation({ ...selection, tableRef, rowIndex: beforeRowIndex, columnIndex });
    }
  }
  return { ok: true };
}

/**
 * 比较表格编辑前后未选范围。选中轴允许增删，因此前缀按起点对齐、后缀按表尾对齐；
 * 未选单元格比较去除派生 blockId 后的完整内容和 cell attrs，不做任何结构修补或内容猜测。
 */
export function validateTableSelectionScope(input: {
  before: PmTableNode;
  after: PmTableNode | null;
  tableRef: string;
  selection: { axis: "row" | "column"; startIndex: number; endIndex: number };
}): TableSelectionScopeResult {
  const { before, after, tableRef, selection } = input;
  if (selection.axis === "row") {
    const prefixCount = selection.startIndex;
    const suffixCount = Math.max(0, before.content.length - selection.endIndex - 1);
    if (!after || after.content.length < prefixCount + suffixCount) {
      const rowIndex = prefixCount > 0 ? 0 : selection.endIndex + 1;
      return scopeViolation({ ...selection, tableRef, rowIndex, columnIndex: 0 });
    }
    for (let rowIndex = 0; rowIndex < prefixCount; rowIndex += 1) {
      const result = compareRowsAt(before, after, rowIndex, rowIndex, selection, tableRef);
      if (!result.ok) return result;
    }
    for (let offset = 0; offset < suffixCount; offset += 1) {
      const beforeRowIndex = selection.endIndex + 1 + offset;
      const afterRowIndex = after.content.length - suffixCount + offset;
      const result = compareRowsAt(before, after, beforeRowIndex, afterRowIndex, selection, tableRef);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  if (!after || before.content.length !== after.content.length) {
    return scopeViolation({ ...selection, tableRef, rowIndex: Math.min(before.content.length, after?.content.length ?? 0), columnIndex: 0 });
  }
  const beforeGrid = pmTableLogicalGrid(before);
  const afterGrid = pmTableLogicalGrid(after);
  const beforeWidth = Math.max(0, ...beforeGrid.map((row) => row.length));
  const afterWidth = Math.max(0, ...afterGrid.map((row) => row.length));
  const suffixCount = Math.max(0, beforeWidth - selection.endIndex - 1);
  if (afterWidth < selection.startIndex + suffixCount) {
    return scopeViolation({ ...selection, tableRef, rowIndex: 0, columnIndex: selection.startIndex > 0 ? 0 : selection.endIndex + 1 });
  }
  // 每个物理 cell 只按起点列归属一次；colspan 占位格不重复审计。
  for (const origin of tableCellOrigins(before)) {
    if (origin.columnIndex >= selection.startIndex && origin.columnIndex <= selection.endIndex) continue;
    const mappedColumn = origin.columnIndex < selection.startIndex
      ? origin.columnIndex
      : afterWidth - (beforeWidth - origin.columnIndex);
    if (tableCellFingerprint(origin.cell) !== tableCellFingerprint(afterGrid[origin.rowIndex]?.[mappedColumn])) {
      return scopeViolation({ ...selection, tableRef, rowIndex: origin.rowIndex, columnIndex: origin.columnIndex });
    }
  }
  return { ok: true };
}

function tableCellOrigins(table: PmTableNode): Array<{ rowIndex: number; columnIndex: number; cell: PmTableCellNode }> {
  const grid = pmTableLogicalGrid(table);
  const seen = new Set<PmTableCellNode>();
  const origins: Array<{ rowIndex: number; columnIndex: number; cell: PmTableCellNode }> = [];
  grid.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    if (seen.has(cell)) return;
    seen.add(cell);
    origins.push({ rowIndex, columnIndex, cell });
  }));
  return origins;
}

export function validateCurrentTableSelectionScopes(
  state: SessionState,
  beforeDoc: PmDoc,
  afterDoc: PmDoc,
): TableSelectionScopeResult {
  for (const chip of state._currentChips ?? []) {
    if (chip.kind.kind !== "selection" || !chip.tableSelection || !chip.resourceRef?.id) continue;
    const tableRef = chip.resourceRef.id;
    const before = findPmTableByBlockId(beforeDoc, tableRef);
    if (!before) return documentScopeViolation(tableRef, "选区目标表在编辑前已不存在");
    if (documentOutsideTableFingerprint(beforeDoc, tableRef) !== documentOutsideTableFingerprint(afterDoc, tableRef)) {
      return documentScopeViolation(tableRef, "目标表外的文档内容发生变化");
    }
    const after = findPmTableByBlockId(afterDoc, tableRef);
    const result = validateTableSelectionScope({ before, after, tableRef, selection: chip.tableSelection });
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function clearReviewDiffState(state: SessionState): void {
  state.suggestionBaseDoc = null;
  state.suggestionBaseVersion = null;
}

export function clearSuggestionReviewState(state: SessionState): void {
  state.suggestions.clear();
  state.patchVerdicts.clear();
  clearReviewDiffState(state);
}

export function clearStaleReviewStreamLock(state: SessionState): void {
  // /commit 是独立 REST 端点;整篇审点击"应用新版"前端会中止旧 SSE。
  // 若上一轮流的 finally 尚未跑完,session.streamId 会残留并让后续 updateDoc 被误判 not_editable。
  // 审阅项已全部提交/放弃且无挂起 run 时,这个 stream 锁已不是用户可见的生成任务。
  if (state.streamId && !state.runId) {
    state.streamId = null;
  }
}
