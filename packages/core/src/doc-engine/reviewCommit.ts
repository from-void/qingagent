import type {
  BridgeFrame,
  CommitReviewGroups,
  DiffHunk,
  DocSuggestion,
  LegacySection,
  PatchConflict,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import { getPmContentHash, pmToLegacySections, type PmDoc, type PmStep } from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import type { SessionState, SuggestionRecord } from "../session/sessionState.js";
import { updateToolCallInChatHistory } from "../session/sessionState.js";
import { buildDocumentSnapshot } from "./docGenerator.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { applySuggestionsToDoc } from "./pmPatch.js";
import { applyDiffHunks } from "./proposalDiff.js";
import { createSuggestionFromDiffHunk, diffHunkToStep } from "./draftReviewSuggestions.js";
import {
  rebaseRemainingPendingDraft,
  type DroppedPendingDraftRecord,
} from "./pendingDraftRebase.js";
import {
  ignoreRebasedDocumentSuggestions,
  persistMappedAnnotationGroups,
  updateDocumentSuggestionStatus,
  upsertDocumentSuggestion,
} from "@qingagent/db";
import { documentDraftRepo } from "@qingagent/db";
import { documentRepo } from "@qingagent/db";
import {
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
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
import { deriveTitleFromSections } from "../session/title.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { mapAnnotationGroupsThroughSteps } from "./annotationMapping.js";

const logger = mastra.getLogger();

async function canonicalSnapshotAfterReviewConflict(state: SessionState): Promise<BridgeFrame | null> {
  const current = await documentRepo.load(state.docId).catch((error) => {
    logger.error("Failed to reload canonical document after review conflict", {
      sessionId: state.sessionId,
      docId: state.docId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (!current?.pmDoc) return null;
  state.doc = current.pmDoc;
  state.legacySections = current.legacySections;
  state.docVersion = current.docVersion;
  return {
    kind: "documentSnapshotWritten",
    data: {
      doc: buildDocumentSnapshot(state.legacySections, state.docVersion, state.doc),
    },
  };
}

// ---------------------------------------------------------------------------
// updatePatchVerdict — accept or reject a single patch
// ---------------------------------------------------------------------------

function reviewBatchIdForRecord(record: SuggestionRecord): string {
  return record.suggestion.reviewBatchId ?? record.diffHunk?.reviewBatchId ?? record.suggestion.id;
}

function recordsByReviewBatchId(state: SessionState, reviewBatchId: string): SuggestionRecord[] {
  return [...state.suggestions.values()].filter(
    (record) => reviewBatchIdForRecord(record) === reviewBatchId,
  );
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
  state._lastEmittedWireKind = `${stateForWire.kind}:${activeOverlay ?? "none"}:${agentBusy ? "busy" : "idle"}`;
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
    data: { state: stateForWire, activeOverlay, agentBusy },
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
        stateSuggestionRecordCount: 0,
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
        stateSuggestionRecordCount: 0,
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
  state.patchValidationResults.delete(id);
}

async function persistSuggestionStatus(
  state: SessionState,
  id: string,
  baseVersion: number,
  status: DocSuggestion["status"],
  conflict?: PatchConflict,
): Promise<void> {
  const rowsAffected = await updateDocumentSuggestionStatus(
    state.docId,
    baseVersion,
    id,
    status,
    conflict,
  );
  if (rowsAffected === 0) {
    throw new Error(`Document suggestion not found: ${state.docId}@${baseVersion}:${id}`);
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
  updateToolCallInChatHistory(state, record.messageId, record.suggestion.id, spec);
  return toolCallUpdated(record.messageId, record.suggestion.id, spec);
}

async function* settleResolvedReviewRecords(
  state: SessionState,
  records: readonly SuggestionRecord[],
): AsyncGenerator<BridgeFrame, boolean> {
  let allPersisted = true;
  for (const record of records) {
    const verdict = state.patchVerdicts.get(record.suggestion.id);
    const terminalStatus = verdict === "rejected" ? "rejected" : "committed";
    const nextSuggestion: DocSuggestion = { ...record.suggestion, status: terminalStatus };
    try {
      await persistSuggestionStatus(
        state,
        nextSuggestion.id,
        nextSuggestion.baseVersion,
        terminalStatus,
      );
    } catch (error) {
      allPersisted = false;
      yield suggestionPersistenceFailedFrame(state, record, terminalStatus, error);
      continue;
    }
    const spec = buildSuggestionToolCallSpec(nextSuggestion, { kind: terminalStatus });
    yield toolCallUpdated(record.messageId, record.suggestion.id, spec);
    updateToolCallInChatHistory(state, record.messageId, record.suggestion.id, spec);
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
): AsyncGenerator<BridgeFrame, boolean> {
  let allPersisted = true;
  const byId = new Map(conflicts.map((conflict) => [conflict.suggestionId, conflict]));
  for (const record of records) {
    const id = record.suggestion.id;
    const verdict = state.patchVerdicts.get(id);
    if (verdict === "rejected") {
      const nextSuggestion: DocSuggestion = { ...record.suggestion, status: "rejected" };
      try {
        await persistSuggestionStatus(state, id, nextSuggestion.baseVersion, "rejected");
      } catch (error) {
        allPersisted = false;
        yield suggestionPersistenceFailedFrame(state, record, "rejected", error);
        continue;
      }
      const spec = buildSuggestionToolCallSpec(nextSuggestion, { kind: "rejected" });
      yield toolCallUpdated(record.messageId, id, spec);
      updateToolCallInChatHistory(state, record.messageId, id, spec);
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
    try {
      await persistSuggestionStatus(state, id, nextSuggestion.baseVersion, "conflict", conflict);
    } catch (error) {
      allPersisted = false;
      yield suggestionPersistenceFailedFrame(state, record, "conflict", error);
      continue;
    }
    const spec = buildSuggestionToolCallSpec(nextSuggestion, {
      kind: "failed",
      data: { retriable: false, reason: conflict.message },
    });
    yield toolCallUpdated(record.messageId, id, spec);
    updateToolCallInChatHistory(state, record.messageId, id, spec);
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
      await persistSuggestionStatus(state, id, suggestion.baseVersion, verdict);
    } catch (error) {
      yield suggestionPersistenceFailedFrame(state, suggestionRecord, verdict, error);
      continue;
    }
    state.patchVerdicts.set(id, verdict);
    suggestionRecord.suggestion = suggestion;
    state.suggestions.set(id, suggestionRecord);
    const spec = buildSuggestionToolCallSpec(suggestion, status);
    yield toolCallUpdated(suggestionRecord.messageId, id, spec);
    updateToolCallInChatHistory(state, suggestionRecord.messageId, id, spec);
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
  for (const record of input.previousRemainingRecords) {
    const hunk = record.diffHunk;
    if (!hunk) continue;
    previousByHunkId.set(hunk.hunkId, record);
    const textKey = hunkTextKey(hunk);
    appendPrevious(previousByText, textKey, record);
    appendPrevious(previousByBlockAndText, JSON.stringify([
      hunk.anchor.blockId ?? record.suggestion.anchor.blockId,
      textKey,
    ]), record);
    appendPrevious(previousByPathAndText, JSON.stringify([hunk.blockPath, textKey]), record);
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
          hunk.anchor.blockId ?? "",
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

  const suggestions = hunks.map((hunk) => {
    const suggestion = createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion: committedVersion,
      baseSchemaVersion: committedDoc.attrs.schemaVersion,
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

  for (const suggestion of suggestions) {
    await upsertDocumentSuggestion(suggestion);
  }
  const previousByBaseVersion = new Map<number, string[]>();
  for (const record of input.previousRemainingRecords) {
    const ids = previousByBaseVersion.get(record.suggestion.baseVersion) ?? [];
    ids.push(record.suggestion.id);
    previousByBaseVersion.set(record.suggestion.baseVersion, ids);
  }
  for (const [baseVersion, ids] of previousByBaseVersion) {
    await ignoreRebasedDocumentSuggestions(state.docId, baseVersion, ids);
  }

  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.patchValidationResults.clear();
  state.suggestionBaseDoc = clonePmDoc(committedDoc);
  state.suggestionBaseVersion = committedVersion;
  state.docDraftBaseDoc = clonePmDoc(committedDoc);
  state.docDraftBaseVersion = committedVersion;
  state.docDraftBaseSections = pmToLegacySections(committedDoc) as unknown as LegacySection[];
  state.docDraftCandidateDoc = clonePmDoc(nextDraftDoc);
  state.docDraftCandidateSections = pmToLegacySections(nextDraftDoc) as unknown as LegacySection[];

  suggestions.forEach((suggestion, index) => {
    const hunk = hunks[index]!;
    const previous = previousByNewHunkId.get(suggestion.id);
    state.suggestions.set(suggestion.id, {
      messageId: previous?.messageId ?? fallbackMessageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
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
    .map((record) => record.diffHunk)
    .filter((hunk): hunk is DiffHunk => hunk !== undefined);
  const shouldCommitDiffHunks =
    acceptedRecords.length > 0 && acceptedDiffHunks.length === acceptedRecords.length;

  if (accepted.length === 0) {
    const recordsSettled = yield* settleResolvedReviewRecords(state, records);
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
      }
    } else {
      clearReviewDiffState(state);
    }
    if (state.suggestions.size === 0) {
      await documentDraftRepo.clear(state.docId).catch((err) => {
        logger.warn("Failed to clear pending draft after rejected-only commit", {
          sessionId: state.sessionId,
          docId: state.docId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
            state.legacySections,
            state.docVersion,
            currentPmDoc(state),
          ),
        },
      };
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
  let commitResultCountsKnown = true;
  let legacyReplayUnknown = false;
  let result: Awaited<ReturnType<typeof commitDocumentOp>>;
  const previousDocVersion = state.docVersion;
  try {
    result = await commitDocumentOp({
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      resourceId: state.resourceId,
      expectedDocumentSnapshot: state.docVersion,
      opId: `patch:${state.sessionId}:${expandedIds.join(",")}:${state.docVersion}`,
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
        if (shouldCommitDiffHunks) {
          const applyResult = applyDiffHunks(currentDoc, acceptedDiffHunks, {
            oldBaseDoc,
            anchorByBlockId: true,
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
            steps: applyResult.applied.map((hunk) =>
              ({
                ...diffHunkToStep(
                  hunk,
                  hunk.anchor.pmFrom ?? 0,
                  hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
                ),
                // 只作为 document_ops 幂等结算元数据落库，不进入 suggestion wire step。
                suggestionId: hunk.hunkId,
              }),
            ),
          };
        }
        const applied = applySuggestionsToDoc(currentDoc, accepted, state.docVersion);
        return {
          nextDoc: applied.nextDoc,
          steps: applied.steps,
          conflicts: applied.conflicts,
        };
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
    yield* settleUnappliedReviewRecords(state, records, [], reason);
    yield* finishSettledReviewState(state, "commitPatches:exception");
    return;
  }

  if (result.status === "patch_conflict") {
    // canonical 快照必须先于 failed/解锁帧发出；否则客户端先移除 review overlay 时，
    // 会短暂露出内存里的旧 preview，形成一次可见的正文回退。
    const canonicalFrame = await canonicalSnapshotAfterReviewConflict(state);
    if (canonicalFrame) yield canonicalFrame;
    yield* settleUnappliedReviewRecords(
      state,
      records,
      result.conflicts,
      "修改和当前文档冲突，本次修改未写入。",
    );
    yield* finishSettledReviewState(state, "commitPatches:conflict");
    return;
  }
  if (result.status === "conflict") {
    const canonicalFrame = await canonicalSnapshotAfterReviewConflict(state);
    if (canonicalFrame) yield canonicalFrame;
    yield* settleUnappliedReviewRecords(
      state,
      records,
      accepted.map((suggestion): PatchConflict => ({
        kind: "version_conflict",
        message: `文档已被更新，本次修改未写入。`,
        suggestionId: suggestion.id,
        blockId: suggestion.anchor.blockId,
        currentVersion: result.currentVersion,
      })),
      "文档已被更新，本次修改未写入。",
    );
    yield* finishSettledReviewState(state, "commitPatches:conflict");
    return;
  }
  if (result.status === "validation_error" || result.status === "not_found") {
    yield* settleUnappliedReviewRecords(
      state,
      records,
      accepted.map((suggestion): PatchConflict => ({
        kind: result.status === "validation_error" ? "schema_invalid" : "version_conflict",
        message:
          result.status === "validation_error"
            ? "修改后的文档格式有问题，未写入。"
            : "文档不存在，本次修改未写入。",
        suggestionId: suggestion.id,
        blockId: suggestion.anchor.blockId,
      })),
      result.status === "validation_error"
        ? "修改后的文档格式有问题，未写入。"
        : "文档不存在，本次修改未写入。",
    );
    yield* finishSettledReviewState(state, "commitPatches:conflict");
    return;
  }

  if (shouldCommitDiffHunks) {
    const persistedAppliedIds = new Set(
      (result.steps ?? [])
        .map((step) => step.suggestionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    if (persistedAppliedIds.size > 0) {
      appliedHunkCount = acceptedDiffHunks.filter((hunk) => persistedAppliedIds.has(hunk.hunkId)).length;
      skippedHunks = acceptedDiffHunks.filter((hunk) => !persistedAppliedIds.has(hunk.hunkId));
    } else if (!result.createdNewVersion && acceptedDiffHunks.length > 0) {
      // 升级前 op 没有 suggestionId，无法诚实恢复部分成功计数；必须把全部项按未知冲突
      // 结算并省略计数，不能猜测某项已提交或伪报精确 0/0。
      commitResultCountsKnown = false;
      legacyReplayUnknown = true;
      skippedHunks = acceptedDiffHunks;
      appliedHunkCount = 0;
      logger.warn("Idempotent patch replay lacks persisted suggestion ids", {
        sessionId: state.sessionId,
        docId: state.docId,
        docVersion: result.docVersion,
      });
    }
  }

  advanceLastContentEditedAt(state, result, previousDocVersion);
  state.doc = result.doc;
  state.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
  state.docVersion = result.docVersion;
  state._directionChangeAskedSinceLastWrite = false;
  const committedAnnotationSteps = (result.steps ?? []) as PmStep[];
  if (state.annotationGroups.length > 0 && committedAnnotationSteps.length > 0) {
    const replacedOrigins = [...new Set(state.annotationGroups.map((group) => group.origin))];
    const mapped = mapAnnotationGroupsThroughSteps(
      state.annotationGroups,
      committedAnnotationSteps,
      result.doc,
    );
    state.annotationGroups = mapped.groups;
    await persistMappedAnnotationGroups(
      state.docId,
      mapped.groups,
      mapped.survivingAnchorIndexes,
    );
    yield {
      kind: "annotationGroupsReady",
      data: { groups: mapped.groups, replacedOrigins },
    };
  }
  if (shouldCommitDiffHunks) {
    const nextTitle = state.titlePinned ? null : deriveTitleFromSections(state.legacySections);
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
  const skippedHunkIds = new Set(skippedHunks.map((hunk) => hunk.hunkId));
  const skippedRecords = skippedHunkIds.size === 0
    ? []
    : records.filter((record) => record.diffHunk && skippedHunkIds.has(record.diffHunk.hunkId));
  const settledRecords = skippedRecords.length === 0
    ? records
    : records.filter((record) => !skippedRecords.includes(record));

  const doc = buildDocumentSnapshot(state.legacySections, state.docVersion, result.doc);
  yield { kind: "documentSnapshotWritten", data: { doc } };

  const settledPersisted = yield* settleResolvedReviewRecords(state, settledRecords);
  let skippedPersisted = true;
  if (skippedRecords.length > 0) {
    const message = legacyReplayUnknown
      ? "升级前的提交记录缺少逐项结果，无法确认这些修改是否写入；已刷新为当前文档，请重新审阅。"
      : `有 ${skippedRecords.length} 处修改因文档已变化而失效，未写入；其余修改已提交。`;
    skippedPersisted = yield* settleUnappliedReviewRecords(
      state,
      skippedRecords,
      skippedRecords.map((record): PatchConflict => ({
        kind: legacyReplayUnknown ? "version_conflict" : "block_removed",
        message,
        suggestionId: record.suggestion.id,
        blockId: record.suggestion.anchor.blockId,
      })),
      message,
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
      yield docDiffReady(result.docVersion, suggestions, result.doc, rebase.nextDraftDoc);
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
      clearReviewDiffState(state);
    }
  } else {
    clearReviewDiffState(state);
  }

  yield {
    kind: "docCommitted",
    data: {
      sessionId: state.sessionId,
      version: state.docVersion,
      ...(commitResultCountsKnown
        ? {
            appliedCount: shouldCommitDiffHunks ? appliedHunkCount : accepted.length,
            conflictCount: shouldCommitDiffHunks ? skippedHunks.length : 0,
          }
        : {}),
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
        stateSuggestionRecordCount: 0,
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
