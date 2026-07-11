import type {
  DiffHunk,
  LegacySection,
} from "@qingagent/contract-ts";
import {
  findPmTableByBlockId,
  getPmContentHash,
  getStablePmJson,
  legacySectionsToPm,
  materializeDraftBlockIds,
  pmToLegacySections,
  pmToPlainText,
  pmTableLogicalGrid,
  type PmBlockNode,
  type PmDoc,
  type PmTableCellNode,
  type PmTableNode,
} from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import { documentDraftRepo } from "../db/documentDraftRepo.js";
import { hasCanonicalDoc } from "./docFacts.js";
import { buildDraftDiff } from "./proposalDiff.js";
import { cloneLegacySections } from "./docDiff.js";
import type { SessionState } from "./sessionState.js";

const logger = mastra.getLogger();

export function clonePmDoc(doc: PmDoc): PmDoc {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(doc) as PmDoc;
  }
  return JSON.parse(JSON.stringify(doc)) as PmDoc;
}

export function currentPmDoc(state: SessionState): PmDoc {
  return state.doc ?? legacySectionsToPm(state.legacySections as never);
}

export function hasNonEmptyCanonicalBase(state: SessionState, baseDoc: PmDoc): boolean {
  return hasCanonicalDoc(state) && pmToPlainText(baseDoc).trim().length > 0;
}

export function ensureDraftCandidateDoc(state: SessionState): PmDoc {
  if (!state.docDraftBaseDoc) {
    const baseDoc = materializeDraftBlockIds(currentPmDoc(state), { namespace: "draft.ensure" });
    state.docDraftBaseDoc = clonePmDoc(baseDoc);
    state.docDraftBaseSections = cloneLegacySections(state.legacySections);
    state.docDraftBaseVersion = state.docVersion;
  }
  if (!state.docDraftCandidateDoc) {
    state.docDraftCandidateDoc = clonePmDoc(state.docDraftBaseDoc);
    state.docDraftCandidateSections = pmToLegacySections(state.docDraftCandidateDoc) as unknown as LegacySection[];
  }
  return state.docDraftCandidateDoc;
}

export function getSectionText(section: LegacySection): string | null {
  if (section.kind === "image") {
    return section.data.caption ?? section.data.alt;
  }
  if ("text" in section.data && typeof section.data.text === "string") {
    return section.data.text;
  }
  if ("body" in section.data && typeof section.data.body === "string") {
    return section.data.body;
  }
  return null;
}

export function clearDraftMutationScratch(state: SessionState): void {
  state.patchValidationResults.clear();
}

export function clearInMemoryDraftDocs(state: SessionState): void {
  state.docDraftBaseSections = null;
  state.docDraftBaseVersion = null;
  state.docDraftBaseDoc = null;
  state.docDraftCandidateSections = null;
  state.docDraftCandidateDoc = null;
}

export function clearDraftConfirmationState(state: SessionState): void {
  clearInMemoryDraftDocs(state);
  clearDraftMutationScratch(state);
}

export function ensureDraftCandidate(state: SessionState): LegacySection[] {
  if (!state.docDraftBaseSections) {
    state.docDraftBaseSections = cloneLegacySections(state.legacySections);
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseDoc = clonePmDoc(currentPmDoc(state));
  }
  if (!state.docDraftCandidateSections) {
    state.docDraftCandidateSections = cloneLegacySections(state.docDraftBaseSections);
  }
  return state.docDraftCandidateSections;
}

export function replaceDraftCandidateDoc(
  state: SessionState,
  doc: PmDoc,
  legacySections?: LegacySection[],
): LegacySection[] {
  const materializedDoc = materializeDraftBlockIds(doc, { namespace: "draft.replace" });
  const sections = legacySections ?? (pmToLegacySections(materializedDoc) as unknown as LegacySection[]);
  if (!state.docDraftBaseSections) {
    state.docDraftBaseSections = cloneLegacySections(state.legacySections);
    state.docDraftBaseVersion = state.docVersion;
    state.docDraftBaseDoc = clonePmDoc(currentPmDoc(state));
  }
  state.docDraftBaseDoc ??= clonePmDoc(currentPmDoc(state));
  state.docDraftCandidateDoc = materializedDoc;
  state.docDraftCandidateSections = cloneLegacySections(sections);
  return state.docDraftCandidateSections;
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

function tableCellFingerprint(cell: PmTableCellNode | undefined): string | null {
  if (!cell) return null;
  const attrs = cell.attrs;
  return JSON.stringify({
    text: pmToPlainText({ type: "doc", attrs: { schemaVersion: 1 }, content: cell.content }).trim(),
    // 纯文本相同时仍需识别未选单元格里的 mark、链接及子块结构变化。
    content: getStablePmJson(cell.content),
    attrs: {
      colspan: attrs?.colspan ?? null,
      rowspan: attrs?.rowspan ?? null,
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
 * 未选单元格只比较纯文本和 cell attrs，不做任何结构修补或内容猜测。
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
  for (let rowIndex = 0; rowIndex < before.content.length; rowIndex += 1) {
    const beforeRow = beforeGrid[rowIndex]!;
    const afterRow = afterGrid[rowIndex]!;
    const prefixCount = selection.startIndex;
    const suffixCount = Math.max(0, beforeRow.length - selection.endIndex - 1);
    if (afterRow.length < prefixCount + suffixCount) {
      return scopeViolation({ ...selection, tableRef, rowIndex, columnIndex: prefixCount > 0 ? 0 : selection.endIndex + 1 });
    }
    for (let columnIndex = 0; columnIndex < prefixCount; columnIndex += 1) {
      if (tableCellFingerprint(beforeRow[columnIndex]) !== tableCellFingerprint(afterRow[columnIndex])) {
        return scopeViolation({ ...selection, tableRef, rowIndex, columnIndex });
      }
    }
    for (let offset = 0; offset < suffixCount; offset += 1) {
      const beforeColumnIndex = selection.endIndex + 1 + offset;
      const afterColumnIndex = afterRow.length - suffixCount + offset;
      if (tableCellFingerprint(beforeRow[beforeColumnIndex]) !== tableCellFingerprint(afterRow[afterColumnIndex])) {
        return scopeViolation({ ...selection, tableRef, rowIndex, columnIndex: beforeColumnIndex });
      }
    }
  }
  return { ok: true };
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

export function docHasBlockType(doc: PmDoc, type: PmBlockNode["type"]): boolean {
  let found = false;
  const visit = (block: PmBlockNode): void => {
    if (block.type === type) {
      found = true;
      return;
    }
    visitChildBlocks(block, visit);
  };
  for (const block of doc.content) {
    visit(block);
    if (found) break;
  }
  return found;
}

export function docHasHighlightMark(doc: PmDoc): boolean {
  let found = false;
  const visitInline = (content: readonly { type: string; marks?: readonly { type: string }[] }[] | undefined): void => {
    for (const node of content ?? []) {
      if (node.type === "text" && node.marks?.some((mark) => mark.type === "highlight")) {
        found = true;
        return;
      }
    }
  };
  const visit = (block: PmBlockNode): void => {
    if (found) return;
    if ("content" in block && Array.isArray(block.content)) visitInline(block.content as never);
    visitChildBlocks(block, visit);
  };
  for (const block of doc.content) {
    visit(block);
    if (found) break;
  }
  return found;
}

function visitChildBlocks(block: PmBlockNode, visit: (child: PmBlockNode) => void): void {
  switch (block.type) {
    case "blockquote":
    case "callout":
      block.content.forEach(visit);
      break;
    case "bulletList":
    case "orderedList":
      block.content.forEach((item) => item.content.forEach(visit));
      break;
    case "taskList":
      block.content.forEach((item) => item.content.forEach(visit));
      break;
    case "table":
      block.content.forEach((row) => row.content.forEach((cell) => cell.content.forEach(visit)));
      break;
    case "columnList":
      block.content.forEach((column) => column.content.forEach(visit));
      break;
    default:
      break;
  }
}

export function clearReviewDiffState(state: SessionState): void {
  state.suggestionBaseDoc = null;
  state.suggestionBaseVersion = null;
}

export function clearSuggestionReviewState(state: SessionState): void {
  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.patchValidationResults.clear();
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
