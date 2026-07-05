import type {
  DiffHunk,
  LegacySection,
} from "@qingagent/contract-ts";
import {
  getPmContentHash,
  legacySectionsToPm,
  materializeDraftBlockIds,
  pmToLegacySections,
  pmToPlainText,
  type PmBlockNode,
  type PmDoc,
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
