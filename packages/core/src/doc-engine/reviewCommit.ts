import type {
  BridgeFrame,
  CommitReviewGroups,
  DiffHunk,
  DocSuggestion,
  PatchConflict,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import {
  carryOverMovedBlockUserAttrs,
  detectMovedBlockUserAttrLosses,
  getDeterministicId,
  getPmContentHash,
  isAbnormalDocumentCollapse,
  type PmDoc,
  type PmStep,
} from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import type { SessionState, SuggestionRecord } from "../session/sessionState.js";
import {
  updatePatchSummaryOutcomeInChatHistory,
  updateToolCallInChatHistoryIfPresent,
} from "../session/sessionState.js";
import { buildDocumentSnapshot } from "./docGenerator.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { applySuggestionsToDoc } from "./pmPatch.js";
import { applyDiffHunks } from "./proposalDiff.js";
import {
  createSuggestionBatchId,
  createSuggestionFromDiffHunk,
  isWholeDocumentSuggestionBatchId,
} from "./draftReviewSuggestions.js";
import {
  rebaseRemainingPendingDraft,
  type DroppedPendingDraftRecord,
} from "./pendingDraftRebase.js";
import {
  LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
  persistMappedAnnotationGroups,
  replaceRebasedReview,
  settleRejectedDocumentReview,
  updateDocumentSuggestionStatusInBatch,
} from "@qingagent/db";
import { documentDraftRepo } from "@qingagent/db";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveExternalEditing,
  emitProjectedDocState,
} from "./docStateMachine.js";
import {
  clearInMemoryDraftDocs,
  clearReviewDiffState,
  clearStaleReviewStreamLock,
  clonePmDoc,
  currentPmDoc,
} from "./draftScratch.js";
import { transitionAndProjectDocState } from "./docStateSync.js";
import { docDiffReady, toolCallUpdated } from "../agent-run/frames.js";
import { buildSuggestionToolCallSpec } from "../agent-run/toolCards.js";
import { deriveTitleFromDoc } from "../session/title.js";
import { schedulePersist } from "../session/threadPersistence.js";
import {
  buildAnnotationMappingSteps,
  diffHunkToPmStep,
  mapAnnotationGroupsThroughSteps,
  pmDocContentSize,
} from "./annotationMapping.js";

const logger = mastra.getLogger();

function movedBlockUserAttrLossNotice(oldDoc: PmDoc, newDoc: PmDoc): string | undefined {
  const losses = detectMovedBlockUserAttrLosses(oldDoc, newDoc);
  if (losses.length === 0) return undefined;
  if (losses.length > 1) {
    return "部分图表或表格移动后，原有手工布局未能完整承接，请检查版式。";
  }
  return losses[0] === "diagram"
    ? "图表移动后，原有手工布局未能完整承接，请检查新图布局。"
    : "表格移动后，原有表头或列宽未能完整承接，请检查表格布局。";
}

// ---------------------------------------------------------------------------
// updatePatchVerdict — accept or reject a single patch
// ---------------------------------------------------------------------------

function reviewBatchIdForRecord(record: SuggestionRecord): string {
  return record.suggestion.reviewBatchId ?? record.diffHunk?.reviewBatchId ?? record.suggestion.id;
}

function reviewCommitOpId(
  state: SessionState,
  records: readonly SuggestionRecord[],
): string {
  const suggestions = records
    .map((record) => [
      record.suggestion.baseVersion,
      record.suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
      record.suggestion.id,
      state.patchVerdicts.get(record.suggestion.id) ?? record.suggestion.status,
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return getDeterministicId("review-commit-op", {
    docId: state.docId,
    suggestions,
  });
}

function recordsByReviewBatchId(state: SessionState, reviewBatchId: string): SuggestionRecord[] {
  return [...state.suggestions.values()].filter(
    (record) => reviewBatchIdForRecord(record) === reviewBatchId,
  );
}

function diffHunkForRecord(record: SuggestionRecord): DiffHunk | undefined {
  return record.diffHunk ?? record.suggestion.diffHunk;
}

type ReviewCommandName = "accept" | "reject" | "commit" | "verdict";

interface ReviewIdExpansionOptions {
  command: ReviewCommandName;
  skipped: string;
}

function logSkippedReviewTarget(
  state: SessionState,
  input: {
    command: ReviewCommandName;
    skipped: string;
    reviewBatchId?: string;
    patchId?: string;
    stateSuggestionRecordCount: number;
    remainingValidIdCount: number;
  },
): void {
  logger.warn("Skipped unknown or resolved review target", {
    sessionId: state.sessionId,
    command: input.command,
    ...(input.reviewBatchId !== undefined ? { reviewBatchId: input.reviewBatchId } : {}),
    ...(input.patchId !== undefined ? { patchId: input.patchId } : {}),
    stateSuggestionRecordCount: input.stateSuggestionRecordCount,
    skipped: input.skipped,
    remainingValidIdCount: input.remainingValidIdCount,
  });
}

function reviewNoopCompletionFrame(state: SessionState, command: ReviewCommandName): BridgeFrame {
  const stateForWire = deriveContentState(state);
  const activeOverlay = deriveActiveOverlay(state);
  const agentBusy = deriveAgentBusy(state);
  const externalEditing = deriveExternalEditing(state);
  state._lastEmittedWireKind = `${stateForWire.kind}:${activeOverlay ?? "none"}:${agentBusy ? "busy" : "idle"}:${externalEditing ? "external" : "native"}`;
  logger.warn("Completed review command as no-op", {
    sessionId: state.sessionId,
    command,
    remainingSuggestionCount: state.suggestions.size,
    state: stateForWire.kind,
    activeOverlay,
    agentBusy,
  });
  return {
    kind: "docStateChanged",
    data: {
      state: stateForWire,
      activeOverlay,
      agentBusy,
      externalEditing,
      reviewCompletion: "noop",
    },
  };
}

export function expandReviewIds(
  state: SessionState,
  ids: readonly string[] = [],
  reviewBatchIds: readonly string[] = [],
  options: ReviewIdExpansionOptions = { command: "verdict", skipped: "reviewTarget" },
): string[] {
  const selected = new Map<string, SuggestionRecord>();
  for (const id of ids) {
    const record = state.suggestions.get(id);
    if (!record) {
      logSkippedReviewTarget(state, {
        command: options.command,
        patchId: id,
        stateSuggestionRecordCount: state.suggestions.size,
        skipped: options.skipped,
        remainingValidIdCount: selected.size,
      });
      continue;
    }
    selected.set(id, record);
  }

  for (const reviewBatchId of reviewBatchIds) {
    const records = recordsByReviewBatchId(state, reviewBatchId);
    if (records.length === 0) {
      logSkippedReviewTarget(state, {
        command: options.command,
        reviewBatchId,
        stateSuggestionRecordCount: state.suggestions.size,
        skipped: options.skipped,
        remainingValidIdCount: selected.size,
      });
      continue;
    }
    for (const record of records) {
      selected.set(record.suggestion.id, record);
    }
  }

  return [...state.suggestions.keys()].filter((id) => selected.has(id));
}

function shouldSettleRecord(state: SessionState, record: SuggestionRecord): boolean {
  return state.suggestions.get(record.suggestion.id) === record;
}

function deleteSettledRecord(state: SessionState, record: SuggestionRecord): void {
  if (!shouldSettleRecord(state, record)) return;
  const id = record.suggestion.id;
  state.suggestions.delete(id);
  state.patchVerdicts.delete(id);
}

async function persistSuggestionStatus(
  state: SessionState,
  suggestion: DocSuggestion,
  status: DocSuggestion["status"],
  conflict?: PatchConflict,
  client?: Parameters<typeof updateDocumentSuggestionStatusInBatch>[6],
): Promise<void> {
  const rowsAffected = await updateDocumentSuggestionStatusInBatch(
    state.docId,
    suggestion.baseVersion,
    suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
    suggestion.id,
    status,
    conflict,
    client,
  );
  if (rowsAffected === 0) {
    throw new Error(
      `Document suggestion not found: ${state.docId}@${suggestion.baseVersion}:${suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID}:${suggestion.id}`,
    );
  }
}

const SUGGESTION_PERSIST_FAILURE_MESSAGE = "审阅状态保存失败，请重试本项。";

function suggestionPersistenceFailedFrame(
  state: SessionState,
  record: SuggestionRecord,
  attemptedStatus: DocSuggestion["status"],
  error: unknown,
): BridgeFrame {
  logger.error("Persisting document suggestion status failed", {
    sessionId: state.sessionId,
    docId: state.docId,
    suggestionId: record.suggestion.id,
    baseVersion: record.suggestion.baseVersion,
    status: attemptedStatus,
    error: error instanceof Error ? error.message : String(error),
  });
  const spec = buildSuggestionToolCallSpec(record.suggestion, {
    kind: "failed",
    data: { retriable: true, reason: SUGGESTION_PERSIST_FAILURE_MESSAGE },
  });
  updateToolCallInChatHistoryIfPresent(state, record.messageId, record.suggestion.id, spec);
  return toolCallUpdated(record.messageId, record.suggestion.id, spec);
}

async function* settleResolvedReviewRecords(
  state: SessionState,
  records: readonly SuggestionRecord[],
  options: {
    alreadyPersisted?: boolean;
    unresolvedStatus?: Extract<DocSuggestion["status"], "committed" | "rejected">;
  } = {},
): AsyncGenerator<BridgeFrame, boolean> {
  let allPersisted = true;
  for (const record of records) {
    const verdict = state.patchVerdicts.get(record.suggestion.id);
    const terminalStatus =
      verdict === "rejected"
        ? "rejected"
        : verdict === "accepted"
          ? "committed"
          : options.unresolvedStatus ?? "committed";
    const nextSuggestion: DocSuggestion = { ...record.suggestion, status: terminalStatus };
    if (!options.alreadyPersisted) {
      try {
        await persistSuggestionStatus(
          state,
          nextSuggestion,
          terminalStatus,
        );
      } catch (error) {
        allPersisted = false;
        yield suggestionPersistenceFailedFrame(state, record, terminalStatus, error);
        continue;
      }
    }
    const spec = buildSuggestionToolCallSpec(nextSuggestion, { kind: terminalStatus });
    yield toolCallUpdated(record.messageId, record.suggestion.id, spec);
    updateToolCallInChatHistoryIfPresent(state, record.messageId, record.suggestion.id, spec);
    record.suggestion = nextSuggestion;
    deleteSettledRecord(state, record);
  }
  return allPersisted;
}

function conflictForFailedRecord(
  record: SuggestionRecord,
  conflict: PatchConflict | undefined,
  fallbackReason: string,
): PatchConflict {
  return conflict ?? {
    kind: "version_conflict",
    message: fallbackReason,
    suggestionId: record.suggestion.id,
    blockId: record.suggestion.anchor.blockId,
  };
}

async function* settleUnappliedReviewRecords(
  state: SessionState,
  records: readonly SuggestionRecord[],
  conflicts: readonly PatchConflict[],
  fallbackReason: string,
  options: { alreadyPersisted?: boolean } = {},
): AsyncGenerator<BridgeFrame, boolean> {
  let allPersisted = true;
  const byId = new Map(conflicts.map((conflict) => [conflict.suggestionId, conflict]));
  for (const record of records) {
    const id = record.suggestion.id;
    const verdict = state.patchVerdicts.get(id);
    if (verdict === "rejected") {
      const nextSuggestion: DocSuggestion = { ...record.suggestion, status: "rejected" };
      if (!options.alreadyPersisted) {
        try {
          await persistSuggestionStatus(state, nextSuggestion, "rejected");
        } catch (error) {
          allPersisted = false;
          yield suggestionPersistenceFailedFrame(state, record, "rejected", error);
          continue;
        }
      }
      const spec = buildSuggestionToolCallSpec(nextSuggestion, { kind: "rejected" });
      yield toolCallUpdated(record.messageId, id, spec);
      updateToolCallInChatHistoryIfPresent(state, record.messageId, id, spec);
      record.suggestion = nextSuggestion;
      deleteSettledRecord(state, record);
      continue;
    }

    const conflict = conflictForFailedRecord(record, byId.get(id), fallbackReason);
    const nextSuggestion: DocSuggestion = {
      ...record.suggestion,
      status: "conflict",
      conflict,
    };
    if (!options.alreadyPersisted) {
      try {
        await persistSuggestionStatus(state, nextSuggestion, "conflict", conflict);
      } catch (error) {
        allPersisted = false;
        yield suggestionPersistenceFailedFrame(state, record, "conflict", error);
        continue;
      }
    }
    const spec = buildSuggestionToolCallSpec(nextSuggestion, {
      kind: "failed",
      data: { retriable: false, reason: conflict.message },
    });
    yield toolCallUpdated(record.messageId, id, spec);
    updateToolCallInChatHistoryIfPresent(state, record.messageId, id, spec);
    record.suggestion = nextSuggestion;
    deleteSettledRecord(state, record);
  }
  return allPersisted;
}

const DROPPED_REBASE_MESSAGE = "目标位置已被前序修改改变,该条已失效,未写入";

async function* settleDroppedRebaseRecords(
  state: SessionState,
  dropped: readonly DroppedPendingDraftRecord[],
): AsyncGenerator<BridgeFrame, boolean> {
  if (dropped.length === 0) return true;
  const records = dropped.map((item) => item.record);
  return yield* settleUnappliedReviewRecords(
    state,
    records,
    records.map((record): PatchConflict => ({
      kind: "block_removed",
      message: DROPPED_REBASE_MESSAGE,
      suggestionId: record.suggestion.id,
      blockId: record.suggestion.anchor.blockId,
    })),
    DROPPED_REBASE_MESSAGE,
  );
}

async function* finishSettledReviewState(
  state: SessionState,
  persistReason: string,
): AsyncGenerator<BridgeFrame> {
  if (state.suggestions.size === 0) {
    await documentDraftRepo.clear(state.docId).catch((err) => {
      logger.warn("Failed to clear pending draft after review settlement", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    clearReviewDiffState(state);
    clearInMemoryDraftDocs(state);
    clearStaleReviewStreamLock(state);
    if (state.docState.kind === "editing") {
      yield* emitProjectedDocState(state, "patches_committed_idle");
    } else {
      yield* transitionAndProjectDocState(state, { kind: "editing" }, "patches_committed_idle");
    }
  } else {
    yield* emitProjectedDocState(state, "patches_committed_idle");
  }

  schedulePersist(state, persistReason).catch((err) =>
    logger.error("Persist after review settlement failed", {
      reason: persistReason,
      error: String(err),
    }),
  );
}

/**
 * 写入失败时保留候选及其 verdict，用户可原地重试。失败不能沿成功结算通路清 draft，
 * 也不能回发 canonical snapshot 覆盖 preview；后者会让前端 reducer 清掉 docDiff。
 */
function reviewCommitFailedFrame(
  state: SessionState,
  reason: string,
): BridgeFrame {
  const stateForWire = deriveContentState(state);
  const activeOverlay = deriveActiveOverlay(state);
  const agentBusy = deriveAgentBusy(state);
  const externalEditing = deriveExternalEditing(state);
  state._lastEmittedWireKind =
    `${stateForWire.kind}:${activeOverlay ?? "none"}:${agentBusy ? "busy" : "idle"}:${externalEditing ? "external" : "native"}`;
  logger.warn("Review commit failed; keeping candidates for retry", {
    sessionId: state.sessionId,
    docId: state.docId,
    docVersion: state.docVersion,
    suggestionCount: state.suggestions.size,
    reason,
  });
  return {
    kind: "docStateChanged",
    data: { state: stateForWire, activeOverlay, agentBusy, externalEditing },
  };
}

function reviewToolCallStatus(suggestion: DocSuggestion): ToolCallStatus {
  if (suggestion.status === "accepted" || suggestion.status === "rejected") {
    return { kind: suggestion.status };
  }
  return { kind: "reviewing" };
}

export async function* updatePatchVerdict(
  state: SessionState,
  patchId: string | undefined,
  verdict: "accepted" | "rejected",
  reviewBatchId?: string,
): AsyncGenerator<BridgeFrame> {
  const expandedIds = expandReviewIds(
    state,
    patchId ? [patchId] : [],
    reviewBatchId ? [reviewBatchId] : [],
    { command: verdict === "accepted" ? "accept" : "reject", skipped: "patchVerdictTarget" },
  );
  if (expandedIds.length === 0) {
    yield reviewNoopCompletionFrame(state, verdict === "accepted" ? "accept" : "reject");
    return;
  }
  const status: ToolCallStatus =
    verdict === "accepted" ? { kind: "accepted" } : { kind: "rejected" };
  for (const id of expandedIds) {
    const suggestionRecord = state.suggestions.get(id)!;
    const suggestion: DocSuggestion = {
      ...suggestionRecord.suggestion,
      status: verdict,
    };
    try {
      await persistSuggestionStatus(state, suggestion, verdict);
    } catch (error) {
      yield suggestionPersistenceFailedFrame(state, suggestionRecord, verdict, error);
      continue;
    }
    state.patchVerdicts.set(id, verdict);
    suggestionRecord.suggestion = suggestion;
    state.suggestions.set(id, suggestionRecord);
    const spec = buildSuggestionToolCallSpec(suggestion, status);
    yield toolCallUpdated(suggestionRecord.messageId, id, spec);
    updateToolCallInChatHistoryIfPresent(state, suggestionRecord.messageId, id, spec);
  }
}

// ---------------------------------------------------------------------------
// commitPatches — apply accepted patches and emit new doc version
// ---------------------------------------------------------------------------

async function rebuildPendingReviewAfterRebase(input: {
  state: SessionState;
  committedDoc: PmDoc;
  committedVersion: number;
  nextDraftDoc: PmDoc;
  hunks: DiffHunk[];
  previousRemainingRecords: readonly SuggestionRecord[];
}): Promise<DocSuggestion[]> {
  const { state, committedDoc, committedVersion, nextDraftDoc, hunks } = input;
  const previousByHunkId = new Map<string, SuggestionRecord>();
  const previousByBlockAndText = new Map<string, SuggestionRecord[]>();
  const previousByPathAndText = new Map<string, SuggestionRecord[]>();
  const previousByText = new Map<string, SuggestionRecord[]>();
  const appendPrevious = (
    target: Map<string, SuggestionRecord[]>,
    key: string,
    record: SuggestionRecord,
  ): void => {
    target.set(key, [...(target.get(key) ?? []), record]);
  };
  const hunkTextKey = (hunk: DiffHunk): string => JSON.stringify([
    hunk.op,
    hunk.beforeText ?? "",
    hunk.afterText ?? "",
  ]);
  const hunkBlockIdentity = (hunk: DiffHunk, fallback = ""): string => {
    if (hunk.blockPath.length > 1) {
      const item = hunk.before?.[0] ?? hunk.after?.[0];
      const attrs = item && "attrs" in item
        ? item.attrs as { blockId?: unknown }
        : undefined;
      if (typeof attrs?.blockId === "string" && attrs.blockId.length > 0) {
        return attrs.blockId;
      }
    }
    return hunk.anchor.blockId ?? fallback;
  };
  for (const record of input.previousRemainingRecords) {
    const hunk = record.diffHunk;
    if (!hunk) continue;
    previousByHunkId.set(hunk.hunkId, record);
    const textKey = hunkTextKey(hunk);
    appendPrevious(previousByText, textKey, record);
    appendPrevious(previousByBlockAndText, JSON.stringify([
      hunkBlockIdentity(hunk, record.suggestion.anchor.blockId),
      textKey,
    ]), record);
    appendPrevious(previousByPathAndText, JSON.stringify([
      record.blockPath ?? hunk.blockPath,
      textKey,
    ]), record);
  }
  const claimedPreviousIds = new Set<string>();
  const previousByNewHunkId = new Map<string, SuggestionRecord>();
  const claimUnique = (records: readonly SuggestionRecord[] | undefined): SuggestionRecord | undefined => {
    const available = records?.filter(
      (record) => !claimedPreviousIds.has(record.suggestion.id),
    ) ?? [];
    return available.length === 1 ? available[0] : undefined;
  };
  for (const hunk of hunks) {
    const textKey = hunkTextKey(hunk);
    const exact = previousByHunkId.get(hunk.hunkId);
    const previous = exact && !claimedPreviousIds.has(exact.suggestion.id)
      ? exact
      : claimUnique(previousByBlockAndText.get(JSON.stringify([
          hunkBlockIdentity(hunk),
          textKey,
        ])))
        ?? claimUnique(previousByPathAndText.get(JSON.stringify([hunk.blockPath, textKey])))
        ?? claimUnique(previousByText.get(textKey));
    if (!previous) continue;
    claimedPreviousIds.add(previous.suggestion.id);
    previousByNewHunkId.set(hunk.hunkId, previous);
  }
  const fallbackMessageId =
    input.previousRemainingRecords[0]?.messageId ??
    `rebased-pending-review:${state.docId}:${committedVersion}`;

  const wholeDocument = input.previousRemainingRecords.some((record) =>
    isWholeDocumentSuggestionBatchId(record.suggestion.batchId)
  );
  const batchId = createSuggestionBatchId(committedVersion, nextDraftDoc, { wholeDocument });
  const suggestions = hunks.map((hunk) => {
    const suggestion = createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion: committedVersion,
      baseSchemaVersion: committedDoc.attrs.schemaVersion,
      batchId,
    });
    const previous = previousByNewHunkId.get(hunk.hunkId);
    const verdict = previous
      ? state.patchVerdicts.get(previous.suggestion.id) ??
        (previous.suggestion.status === "accepted" || previous.suggestion.status === "rejected"
          ? previous.suggestion.status
          : undefined)
      : undefined;
    return verdict ? { ...suggestion, status: verdict } : suggestion;
  });

  const previousBatches = new Map<string, {
    baseVersion: number;
    batchId: string;
    suggestionIds: string[];
  }>();
  for (const record of input.previousRemainingRecords) {
    const previousBatchId = record.suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID;
    const key = JSON.stringify([record.suggestion.baseVersion, previousBatchId]);
    const previous = previousBatches.get(key) ?? {
      baseVersion: record.suggestion.baseVersion,
      batchId: previousBatchId,
      suggestionIds: [],
    };
    previous.suggestionIds.push(record.suggestion.id);
    previousBatches.set(key, previous);
  }
  await replaceRebasedReview({
    draft: {
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      baseVersion: committedVersion,
      baseHash: getPmContentHash(committedDoc),
      draftPmDoc: nextDraftDoc,
      batchId,
      reviewBatchId: suggestions[0]?.reviewBatchId ?? null,
      groupMode: suggestions[0]?.groupMode ?? null,
    },
    suggestions,
    previousSuggestions: [...previousBatches.values()],
  });

  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.suggestionBaseDoc = clonePmDoc(committedDoc);
  state.suggestionBaseVersion = committedVersion;
  state.docDraftBaseDoc = clonePmDoc(committedDoc);
  state.docDraftBaseVersion = committedVersion;
  state.docDraftCandidateDoc = clonePmDoc(nextDraftDoc);

  suggestions.forEach((suggestion, index) => {
    const hunk = hunks[index]!;
    const previous = previousByNewHunkId.get(suggestion.id);
    state.suggestions.set(suggestion.id, {
      messageId: previous?.messageId ?? fallbackMessageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
    if (suggestion.status === "accepted" || suggestion.status === "rejected") {
      state.patchVerdicts.set(suggestion.id, suggestion.status);
    }
  });

  return suggestions;
}

export async function* commitPatches(
  state: SessionState,
  ids: string[],
): AsyncGenerator<BridgeFrame> {
  const oldBaseDoc = state.docDraftBaseDoc ?? state.suggestionBaseDoc ?? currentPmDoc(state);
  const oldDraftDoc = state.docDraftCandidateDoc ?? oldBaseDoc;
  const expandedIds = expandReviewIds(state, ids, [], {
    command: "commit",
    skipped: "patchCommitTarget",
  });
  if (expandedIds.length === 0) {
    yield reviewNoopCompletionFrame(state, "commit");
    return;
  }
  const records = expandedIds.map((id) => state.suggestions.get(id)!);
  const acceptedRecords = records
    .filter((record) => state.patchVerdicts.get(record.suggestion.id) !== "rejected");
  const accepted = acceptedRecords.map((record) => record.suggestion);
  const acceptedDiffHunks = acceptedRecords
    .map(diffHunkForRecord)
    .filter((hunk): hunk is DiffHunk => hunk !== undefined);
  const modernDiffPayloadRequired =
    state.docDraftCandidateDoc != null ||
    state.docDraftBaseDoc != null ||
    acceptedRecords.some(
      (record) =>
        record.diffHunk !== undefined ||
        record.suggestion.diffHunk !== undefined,
    );
  const modernDiffPayloadIncomplete =
    modernDiffPayloadRequired &&
    acceptedDiffHunks.length !== acceptedRecords.length;
  const shouldCommitDiffHunks =
    acceptedRecords.length > 0 &&
    !modernDiffPayloadIncomplete &&
    acceptedDiffHunks.length === acceptedRecords.length;
  const wholeCandidateDoc = state.docDraftCandidateDoc
    ? clonePmDoc(state.docDraftCandidateDoc)
    : null;
  const wholeCandidateAccepted =
    wholeCandidateDoc !== null &&
    records.length === state.suggestions.size &&
    acceptedRecords.length === records.length;
  const candidateBaseContentHash = getPmContentHash(oldBaseDoc);

  if (accepted.length === 0) {
    const settlesEntireReview = records.length === state.suggestions.size;
    if (settlesEntireReview) {
      const firstSuggestion = records[0]!.suggestion;
      try {
        await settleRejectedDocumentReview({
          docId: state.docId,
          draft: {
            batchId:
              firstSuggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
            baseVersion: firstSuggestion.baseVersion,
            baseHash: candidateBaseContentHash,
          },
          suggestions: records.map((record) => record.suggestion),
        });
      } catch (error) {
        for (const record of records) {
          yield suggestionPersistenceFailedFrame(state, record, "rejected", error);
        }
        yield reviewCommitFailedFrame(state, "rejected_only_atomic_settlement_failed");
        return;
      }
    }
    const recordsSettled = yield* settleResolvedReviewRecords(state, records, {
      alreadyPersisted: settlesEntireReview,
    });
    if (!recordsSettled) {
      yield* finishSettledReviewState(state, "commitPatches:rejected_only_persist_failed");
      return;
    }
    const remainingRecords = [...state.suggestions.values()];
    if (remainingRecords.length > 0) {
      const rebase = await rebaseRemainingPendingDraft({
        docId: state.docId,
        threadId: state.threadId ?? state.sessionId,
        oldBaseDoc,
        oldDraftDoc,
        committedDoc: currentPmDoc(state),
        committedVersion: state.docVersion,
        remainingRecords,
        persist: false,
        persistPending: false,
      });
      if (rebase.status !== "conflict") {
        const droppedSettled = yield* settleDroppedRebaseRecords(state, rebase.dropped);
        if (!droppedSettled) {
          yield* finishSettledReviewState(state, "commitPatches:rebase_drop_persist_failed");
          return;
        }
      }
      if (rebase.status === "pending") {
        const droppedIds = new Set(rebase.dropped.map((item) => item.record.suggestion.id));
        const suggestions = await rebuildPendingReviewAfterRebase({
          state,
          committedDoc: currentPmDoc(state),
          committedVersion: state.docVersion,
          nextDraftDoc: rebase.nextDraftDoc,
          hunks: rebase.hunks,
          previousRemainingRecords: remainingRecords.filter(
            (record) => !droppedIds.has(record.suggestion.id),
          ),
        });
        yield docDiffReady(
          state.docVersion,
          suggestions,
          currentPmDoc(state),
          rebase.nextDraftDoc,
          isWholeDocumentSuggestionBatchId(suggestions[0]?.batchId),
        );
        for (const record of state.suggestions.values()) {
          yield toolCallUpdated(
            record.messageId,
            record.suggestion.id,
            buildSuggestionToolCallSpec(
              record.suggestion,
              reviewToolCallStatus(record.suggestion),
            ),
          );
        }
      } else if (rebase.status === "conflict") {
        yield* settleUnappliedReviewRecords(
          state,
          remainingRecords,
          remainingRecords.map((record): PatchConflict => ({
            kind: "block_removed",
            message: `待审草稿更新失败，请重试。`,
            suggestionId: record.suggestion.id,
            blockId: record.suggestion.anchor.blockId,
          })),
          "待审草稿更新失败，请重试。",
        );
      } else {
        const clearedSettled = yield* settleResolvedReviewRecords(
          state,
          remainingRecords.filter((record) => shouldSettleRecord(state, record)),
          { unresolvedStatus: "rejected" },
        );
        if (!clearedSettled) {
          yield* finishSettledReviewState(state, "commitPatches:rebase_clear_persist_failed");
          return;
        }
        clearReviewDiffState(state);
      }
    } else {
      clearReviewDiffState(state);
    }
    if (state.suggestions.size === 0) {
      if (!settlesEntireReview) {
        await documentDraftRepo.clear(state.docId).catch((err) => {
          logger.warn("Failed to clear pending draft after rejected-only commit", {
            sessionId: state.sessionId,
            docId: state.docId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      clearInMemoryDraftDocs(state);
      clearStaleReviewStreamLock(state);
      // 诊断 p01:全拒绝收尾此前只发 docStateChanged 不带正文——若前端 state.doc
      // 因任何原因落后(典型:手动编辑保存后前端未同步),拒绝后界面会回退到陈旧
      // 文档,表现为"拒绝把手动编辑一起回滚了"。这里显式回发服务端 canonical
      // 快照纠偏,保证拒绝后的所见即当前真实文档。
      yield {
        kind: "documentSnapshotWritten",
        data: {
          doc: buildDocumentSnapshot(
            state.docVersion,
            currentPmDoc(state),
          ),
        },
      };
      // 标题只跟随已经生效的正文。除防止新候选在审阅期提前改标题外，这里还要
      // 修复历史版本可能已经持久化的候选标题，并通过 sessionMeta 纠正所有客户端。
      const effectiveTitle = state.titlePinned ? null : deriveTitleFromDoc(currentPmDoc(state));
      if (effectiveTitle) {
        state.title = effectiveTitle;
        yield {
          kind: "sessionMeta",
          data: { sessionId: state.sessionId, title: effectiveTitle },
        };
      }
      yield* transitionAndProjectDocState(state, { kind: "editing" }, "patches_committed_idle");
    } else {
      yield* emitProjectedDocState(state, "patches_committed_idle");
    }
    schedulePersist(state, "commitPatches:rejected_only").catch((err) =>
      logger.error("Persist after commitPatches rejected-only failed", { error: String(err) }),
    );
    return;
  }

  // 审核提交按 blockId 锚定应用;目标块被并发删除的 hunk 会被 applyDiffHunks 跳过。
  // 首次提交的 summary 在 apply 闭包后按真实结果生成；提交后的审阅结算还会从
  // document_ops.steps 恢复 suggestionId，保证 DB 已提交后的幂等重放不丢失部分 conflict。
  let skippedHunks: DiffHunk[] = [];
  let appliedHunkCount = 0;
  let transactionSettlementPersisted = false;
  type PendingAnnotationMapping = {
    mapped: ReturnType<typeof mapAnnotationGroupsThroughSteps>;
    replacedOrigins: string[];
  };
  let transactionAnnotationMapping: PendingAnnotationMapping | null = null;
  let result: Awaited<ReturnType<typeof commitDocumentOp>>;
  const previousDocVersion = state.docVersion;
  const reconcileCommittedResult = (
    committed: Extract<Awaited<ReturnType<typeof commitDocumentOp>>, { status: "committed" }>,
  ): void => {
    if (!shouldCommitDiffHunks) return;
    const persistedAppliedIds = new Set(
      (committed.steps ?? [])
        .flatMap((step) => [
          ...(step.suggestionId ? [step.suggestionId] : []),
          ...(step.suggestionIds ?? []),
        ])
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    if (persistedAppliedIds.size > 0) {
      appliedHunkCount = acceptedDiffHunks.filter((hunk) =>
        persistedAppliedIds.has(hunk.hunkId)
      ).length;
      skippedHunks = acceptedDiffHunks.filter((hunk) =>
        !persistedAppliedIds.has(hunk.hunkId)
      );
      return;
    }
  };
  const partitionReviewRecords = (): {
    settledRecords: SuggestionRecord[];
    skippedRecords: SuggestionRecord[];
  } => {
    const skippedHunkIds = new Set(skippedHunks.map((hunk) => hunk.hunkId));
    const skippedRecords = skippedHunkIds.size === 0
      ? []
      : records.filter((record) => {
          const hunk = diffHunkForRecord(record);
          return hunk !== undefined && skippedHunkIds.has(hunk.hunkId);
        });
    return {
      skippedRecords,
      settledRecords: skippedRecords.length === 0
        ? records
        : records.filter((record) => !skippedRecords.includes(record)),
    };
  };
  const skippedSettlementMessage = (skippedCount: number): string =>
    `${appliedHunkCount} 处已写入，${skippedCount} 处因文档变化失效。`;
  try {
    result = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: state.docVersion,
      ...(wholeCandidateAccepted
        ? { baseContentHash: candidateBaseContentHash }
        : {}),
      opId: reviewCommitOpId(state, records),
      opKind: "patch_steps",
      actorType: "agent",
      summary: () => {
        if (!shouldCommitDiffHunks || skippedHunks.length === 0) {
          return `提交 ${accepted.length} 处局部修改`;
        }
        return `提交 ${appliedHunkCount} 处局部修改，${skippedHunks.length} 处因文档变化失效`;
      },
      ...(shouldCommitDiffHunks && state.docVersion === 0
        ? {
            createIfMissing: {
              title: state.title,
              docState: "editing",
              lastSyncedVersion: state.lastSyncedDocumentSnapshot,
            },
          }
        : {}),
      apply: (currentDoc) => {
        // modern candidate-diff 批次不得因单条记录损坏/恢复缺失 diffHunk 而静默
        // 降级到 legacy quote patch；两条路径语义不同，降级可能写出非候选终稿。
        if (modernDiffPayloadIncomplete) {
          return {
            nextDoc: currentDoc,
            conflicts: acceptedRecords.map((record): PatchConflict => ({
              kind: "target_text_changed",
              message: "待审修改数据不完整，本次修改未写入，请重试。",
              suggestionId: record.suggestion.id,
              blockId: record.suggestion.anchor.blockId,
              currentVersion: state.docVersion,
            })),
          };
        }
        if (shouldCommitDiffHunks) {
          // 整批采纳时，候选文档是本轮审阅的权威终稿。版本号与 baseContentHash
          // 已共同证明 currentDoc 仍是候选生成时的基线，因此直接整体落库；
          // 逐 hunk 回放仅用于部分采纳，避免大批次因一条内部定位偏差整批回滚。
          if (wholeCandidateAccepted && wholeCandidateDoc) {
            // 兼容修复前已生成、仍在待审的候选：快路径拍快照前再做一次同批移动承接。
            const candidateWithMovedBlockAttrs = carryOverMovedBlockUserAttrs(
              currentDoc,
              wholeCandidateDoc,
            ).doc;
            if (isAbnormalDocumentCollapse(currentDoc, candidateWithMovedBlockAttrs)) {
              return {
                nextDoc: currentDoc,
                conflicts: acceptedRecords.map((record): PatchConflict => ({
                  kind: "schema_invalid",
                  message: "候选文档异常坍缩，本次修改未写入，候选已保留。",
                  suggestionId: record.suggestion.id,
                  blockId: record.suggestion.anchor.blockId,
                  currentVersion: state.docVersion,
                })),
              };
            }
            if (
              getPmContentHash(candidateWithMovedBlockAttrs) ===
              getPmContentHash(currentDoc)
            ) {
              return {
                nextDoc: currentDoc,
                conflicts: acceptedRecords.map((record): PatchConflict => ({
                  kind: "target_text_changed",
                  message: "候选与当前正文相同，本次未创建空版本，候选已保留。",
                  suggestionId: record.suggestion.id,
                  blockId: record.suggestion.anchor.blockId,
                  currentVersion: state.docVersion,
                })),
              };
            }
            appliedHunkCount = acceptedDiffHunks.length;
            skippedHunks = [];
            return {
              nextDoc: clonePmDoc(candidateWithMovedBlockAttrs),
              steps: [{
                stepType: "replace",
                from: 0,
                to: pmDocContentSize(currentDoc),
                slice: {
                  content: clonePmDoc(candidateWithMovedBlockAttrs).content,
                  openStart: 0,
                  openEnd: 0,
                },
                suggestionIds: acceptedDiffHunks.map((hunk) => hunk.hunkId),
              }],
            };
          }
          const applyResult = applyDiffHunks(currentDoc, acceptedDiffHunks, {
            oldBaseDoc,
          });
          skippedHunks = applyResult.skipped;
          appliedHunkCount = applyResult.applied.length;
          // 目标块被删除可沿既有“跳过该 hunk、提交其余项”语义结算；块仍在但内容/行内范围
          // 对不上，说明用户正文已漂移，整批必须事务回滚，不能用空 steps 记一次假提交。
          const changedTargets = applyResult.skippedDetails
            .filter((detail) => !detail.reason.startsWith("missing target block"));
          if (changedTargets.length > 0) {
            return {
              nextDoc: currentDoc,
              conflicts: changedTargets.map(({ hunk }): PatchConflict => ({
                kind: "target_text_changed",
                message: "文档正文已变化，本次修改未写入。请刷新后重新生成审阅。",
                suggestionId: hunk.hunkId,
                blockId: hunk.anchor.blockId,
                currentVersion: state.docVersion,
              })),
            };
          }
          // 所有目标都已被删除时不能把空 steps 当成一次成功提交，否则会制造空版本，
          // 还会让审阅项看起来像已落盘。部分目标删除仍保留既有“提交存活项”语义。
          if (applyResult.applied.length === 0 && acceptedDiffHunks.length > 0) {
            return {
              nextDoc: currentDoc,
              conflicts: applyResult.skippedDetails.map(({ hunk }): PatchConflict => ({
                kind: "block_removed",
                message: "待修改内容已不存在，本次修改未写入。请刷新后重新生成审阅。",
                suggestionId: hunk.hunkId,
                blockId: hunk.anchor.blockId,
                currentVersion: state.docVersion,
              })),
            };
          }
          // 损坏/历史 hunk 可能被标成 applied，却没有改变正文。提交层再做一次内容 hash
          // 总兜底，禁止相同 nextDoc 写出空版本或“已提交”假状态。
          if (getPmContentHash(applyResult.doc) === getPmContentHash(currentDoc)) {
            return {
              nextDoc: currentDoc,
              conflicts: applyResult.applied.map((hunk): PatchConflict => ({
                kind: "target_text_changed",
                message: "本次修改没有产生有效正文变化，未写入。请刷新后重新生成审阅。",
                suggestionId: hunk.hunkId,
                blockId: hunk.anchor.blockId,
                currentVersion: state.docVersion,
              })),
            };
          }
          return {
            nextDoc: applyResult.doc,
            // steps 只为真正落上的 hunk 生成——被跳过的 hunk 不再写进 document_ops(修记假账)。
            steps: applyResult.applied
              .map((hunk) =>
                ({
                  ...diffHunkToPmStep(currentDoc, hunk),
                  // 只作为 document_ops 幂等结算元数据落库，不进入 suggestion wire step。
                  suggestionId: hunk.hunkId,
                }),
              )
              // 与正文应用顺序一致：高位先行，后续 step 仍可使用提交前文档坐标。
              .sort((left, right) => {
                const leftFrom = typeof left.from === "number" ? left.from : Number.NEGATIVE_INFINITY;
                const rightFrom = typeof right.from === "number" ? right.from : Number.NEGATIVE_INFINITY;
                return rightFrom - leftFrom;
              }),
          };
        }
        const applied = applySuggestionsToDoc(currentDoc, accepted, state.docVersion);
        return {
          nextDoc: applied.nextDoc,
          steps: applied.steps,
          conflicts: applied.conflicts,
        };
      },
    }, {
      transactionalEffect: async ({ client, result: committed }) => {
        reconcileCommittedResult(committed);
        let nextAnnotationMapping: PendingAnnotationMapping | null = null;
        const committedAnnotationSteps = (committed.steps ?? []) as PmStep[];
        const annotationMappingSteps = wholeCandidateAccepted && wholeCandidateDoc
          ? buildAnnotationMappingSteps(oldBaseDoc, committed.doc)
          : committedAnnotationSteps;
        if (state.annotationGroups.length > 0 && annotationMappingSteps.length > 0) {
          const replacedOrigins = [
            ...new Set(state.annotationGroups.map((group) => group.origin)),
          ];
          const mapped = mapAnnotationGroupsThroughSteps(
            state.annotationGroups,
            annotationMappingSteps,
            committed.doc,
          );
          await persistMappedAnnotationGroups(
            state.docId,
            mapped.groups,
            mapped.survivingAnchorIndexes,
            client,
          );
          nextAnnotationMapping = { mapped, replacedOrigins };
        }

        const { settledRecords, skippedRecords } = partitionReviewRecords();
        for (const record of settledRecords) {
          const terminalStatus =
            state.patchVerdicts.get(record.suggestion.id) === "rejected"
              ? "rejected"
              : "committed";
          await persistSuggestionStatus(
            state,
            { ...record.suggestion, status: terminalStatus },
            terminalStatus,
            undefined,
            client,
          );
        }
        const message = skippedSettlementMessage(skippedRecords.length);
        for (const record of skippedRecords) {
          const conflict: PatchConflict = {
            kind: "block_removed",
            message,
            suggestionId: record.suggestion.id,
            blockId: record.suggestion.anchor.blockId,
          };
          await persistSuggestionStatus(
            state,
            { ...record.suggestion, status: "conflict", conflict },
            "conflict",
            conflict,
            client,
          );
        }
        transactionAnnotationMapping = nextAnnotationMapping;
        transactionSettlementPersisted = true;
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "提交失败，本次修改未写入。";
    logger.error("Commit document operation threw while settling review records", {
      sessionId: state.sessionId,
      docId: state.docId,
      suggestionIds: records.map((record) => record.suggestion.id),
      error: reason,
    });
    yield reviewCommitFailedFrame(state, reason);
    return;
  }

  if (result.status === "patch_conflict") {
    const reason =
      result.conflicts[0]?.message ??
      "修改和当前文档冲突，本次修改未写入。";
    yield reviewCommitFailedFrame(state, reason);
    return;
  }
  if (result.status === "conflict") {
    yield reviewCommitFailedFrame(
      state,
      `文档已更新到 v${result.currentVersion}，本次修改未写入。`,
    );
    return;
  }
  if (result.status === "validation_error" || result.status === "not_found") {
    yield reviewCommitFailedFrame(
      state,
      result.status === "validation_error"
        ? "修改后的文档格式有问题，未写入。"
        : "文档不存在，本次修改未写入。",
    );
    return;
  }

  if (!transactionSettlementPersisted) reconcileCommittedResult(result);

  advanceLastContentEditedAt(state, result, previousDocVersion);
  state.doc = result.doc;
  state.docVersion = result.docVersion;
  state._directionChangeAskedSinceLastWrite = false;
  let annotationMapping: PendingAnnotationMapping | null = transactionAnnotationMapping;
  if (!transactionSettlementPersisted) {
    const committedAnnotationSteps = (result.steps ?? []) as PmStep[];
    const annotationMappingSteps = wholeCandidateAccepted && wholeCandidateDoc
      ? buildAnnotationMappingSteps(oldBaseDoc, result.doc)
      : committedAnnotationSteps;
    if (state.annotationGroups.length > 0 && annotationMappingSteps.length > 0) {
      const replacedOrigins = [...new Set(state.annotationGroups.map((group) => group.origin))];
      const mapped = mapAnnotationGroupsThroughSteps(
        state.annotationGroups,
        annotationMappingSteps,
        result.doc,
      );
      await persistMappedAnnotationGroups(
        state.docId,
        mapped.groups,
        mapped.survivingAnchorIndexes,
      );
      annotationMapping = { mapped, replacedOrigins };
    }
  }
  if (annotationMapping) {
    const { mapped, replacedOrigins } = annotationMapping;
    state.annotationGroups = mapped.groups;
    yield {
      kind: "annotationGroupsReady",
      data: {
        groups: mapped.groups,
        replacedOrigins,
        ...(mapped.invalidatedAnchorCount > 0
          ? { invalidatedAnchorCount: mapped.invalidatedAnchorCount }
          : {}),
      },
    };
    if (mapped.unlocatedGroupCount > 0) {
      logger.warn("Annotation groups became unlocated while committing review", {
        sessionId: state.sessionId,
        docId: state.docId,
        survivingGroupCount: mapped.groups.length,
        unlocatedGroupCount: mapped.unlocatedGroupCount,
      });
    }
  }
  if (shouldCommitDiffHunks) {
    const nextTitle = state.titlePinned ? null : deriveTitleFromDoc(state.doc);
    if (nextTitle) {
      state.title = nextTitle;
      yield {
        kind: "sessionMeta",
        data: { sessionId: state.sessionId, title: state.title },
      };
    }
  }

  // 失效 hunk(目标块被并发删除等)对应的 suggestion 按"未应用"结算,不能显示为已提交;
  // 沿既有 settleUnappliedReviewRecords 冲突帧通路把失效原因带给前端(不新造帧类型)。
  const { settledRecords, skippedRecords } = partitionReviewRecords();

  const doc = buildDocumentSnapshot(state.docVersion, result.doc);
  yield { kind: "documentSnapshotWritten", data: { doc } };

  const settledPersisted = yield* settleResolvedReviewRecords(
    state,
    settledRecords,
    { alreadyPersisted: transactionSettlementPersisted },
  );
  let skippedPersisted = true;
  if (skippedRecords.length > 0) {
    const message = skippedSettlementMessage(skippedRecords.length);
    skippedPersisted = yield* settleUnappliedReviewRecords(
      state,
      skippedRecords,
      skippedRecords.map((record): PatchConflict => ({
        kind: "block_removed",
        message,
        suggestionId: record.suggestion.id,
        blockId: record.suggestion.anchor.blockId,
      })),
      message,
      { alreadyPersisted: transactionSettlementPersisted },
    );
  }
  if (!settledPersisted || !skippedPersisted) {
    yield* finishSettledReviewState(state, "commitPatches:settlement_persist_failed");
    return;
  }

  const remainingRecords = [...state.suggestions.values()];
  if (remainingRecords.length > 0) {
    const rebase = await rebaseRemainingPendingDraft({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      oldBaseDoc,
      oldDraftDoc,
      committedDoc: result.doc,
      committedVersion: result.docVersion,
      remainingRecords,
      persist: false,
      persistPending: false,
    });
    if (rebase.status !== "conflict") {
      const droppedSettled = yield* settleDroppedRebaseRecords(state, rebase.dropped);
      if (!droppedSettled) {
        yield* finishSettledReviewState(state, "commitPatches:rebase_drop_persist_failed");
        return;
      }
    }
    if (rebase.status === "pending") {
      const droppedIds = new Set(rebase.dropped.map((item) => item.record.suggestion.id));
      const suggestions = await rebuildPendingReviewAfterRebase({
        state,
        committedDoc: result.doc,
        committedVersion: result.docVersion,
        nextDraftDoc: rebase.nextDraftDoc,
        hunks: rebase.hunks,
        previousRemainingRecords: remainingRecords.filter(
          (record) => !droppedIds.has(record.suggestion.id),
        ),
      });
      yield docDiffReady(
        result.docVersion,
        suggestions,
        result.doc,
        rebase.nextDraftDoc,
        isWholeDocumentSuggestionBatchId(suggestions[0]?.batchId),
      );
      for (const record of state.suggestions.values()) {
        yield toolCallUpdated(
          record.messageId,
          record.suggestion.id,
          buildSuggestionToolCallSpec(
            record.suggestion,
            reviewToolCallStatus(record.suggestion),
          ),
        );
      }
    } else if (rebase.status === "conflict") {
      yield* settleUnappliedReviewRecords(
        state,
        remainingRecords,
        remainingRecords.map((record): PatchConflict => ({
          kind: "block_removed",
          message: `待审草稿更新失败，请重试。`,
          suggestionId: record.suggestion.id,
          blockId: record.suggestion.anchor.blockId,
        })),
        "待审草稿更新失败，请重试。",
      );
    } else {
      const clearedSettled = yield* settleResolvedReviewRecords(
        state,
        remainingRecords.filter((record) => shouldSettleRecord(state, record)),
        { unresolvedStatus: "committed" },
      );
      if (!clearedSettled) {
        yield* finishSettledReviewState(state, "commitPatches:rebase_clear_persist_failed");
        return;
      }
      clearReviewDiffState(state);
    }
  } else {
    clearReviewDiffState(state);
  }

  if (skippedRecords.length > 0 && appliedHunkCount === 0) {
    updatePatchSummaryOutcomeInChatHistory(
      state,
      records.map((record) => record.suggestion.id),
      "failed",
    );
  } else {
    updatePatchSummaryOutcomeInChatHistory(
      state,
      records.map((record) => record.suggestion.id),
      "committed",
      shouldCommitDiffHunks ? appliedHunkCount : accepted.length,
      shouldCommitDiffHunks ? skippedRecords.length : 0,
    );
  }

  const commitNotice = movedBlockUserAttrLossNotice(oldBaseDoc, result.doc);
  yield {
    kind: "docCommitted",
    data: {
      sessionId: state.sessionId,
      version: state.docVersion,
      ...(commitNotice ? { notice: commitNotice } : {}),
      appliedCount: shouldCommitDiffHunks ? appliedHunkCount : accepted.length,
      conflictCount: shouldCommitDiffHunks ? skippedHunks.length : 0,
    },
  };
  if (state.suggestions.size === 0) {
    await documentDraftRepo.clear(state.docId).catch((err) => {
      logger.warn("Failed to clear pending draft after commit", {
        sessionId: state.sessionId,
        docId: state.docId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    clearInMemoryDraftDocs(state);
    clearStaleReviewStreamLock(state);
    yield* transitionAndProjectDocState(
      state,
      { kind: "editing" },
      "patches_committed_idle",
    );
  } else {
    yield* emitProjectedDocState(state, "patches_committed_idle");
  }

  schedulePersist(state, "commitPatches").catch((err) =>
    logger.error("Persist after commitPatches failed", { error: String(err) }),
  );
}

export async function* commitReviewGroups(
  state: SessionState,
  command: CommitReviewGroups,
): AsyncGenerator<BridgeFrame> {
  const acceptReviewBatchIds = command.acceptReviewBatchIds ?? [];
  const rejectReviewBatchIds = command.rejectReviewBatchIds ?? [];
  const keepPendingReviewBatchIds = command.keepPendingReviewBatchIds ?? [];
  for (const reviewBatchId of keepPendingReviewBatchIds) {
    const records = recordsByReviewBatchId(state, reviewBatchId);
    if (records.length === 0) {
      logSkippedReviewTarget(state, {
        command: "commit",
        reviewBatchId,
        stateSuggestionRecordCount: state.suggestions.size,
        skipped: "keepPendingReviewBatchId",
        remainingValidIdCount: 0,
      });
    }
  }

  const acceptIds = expandReviewIds(state, [], acceptReviewBatchIds, {
    command: "commit",
    skipped: "acceptReviewBatchId",
  });
  const rejectIds = expandReviewIds(state, [], rejectReviewBatchIds, {
    command: "commit",
    skipped: "rejectReviewBatchId",
  });
  const overlapping = acceptIds.find((id) => rejectIds.includes(id));
  if (overlapping) {
    throw new Error(`Review batch cannot be both accepted and rejected: ${overlapping}`);
  }

  for (const id of acceptIds) {
    if (state.patchVerdicts.get(id) !== "accepted") {
      for await (const frame of updatePatchVerdict(state, id, "accepted")) yield frame;
    }
  }
  for (const id of rejectIds) {
    if (state.patchVerdicts.get(id) !== "rejected") {
      for await (const frame of updatePatchVerdict(state, id, "rejected")) yield frame;
    }
  }

  const commitIds = [...new Set([
    ...acceptIds.filter((id) => state.patchVerdicts.get(id) === "accepted"),
    ...rejectIds.filter((id) => state.patchVerdicts.get(id) === "rejected"),
  ])];

  if (commitIds.length === 0) {
    if (acceptIds.length === 0 && rejectIds.length === 0) {
      yield reviewNoopCompletionFrame(state, "commit");
    }
    return;
  }
  for await (const frame of commitPatches(state, commitIds)) {
    yield frame;
  }
}
