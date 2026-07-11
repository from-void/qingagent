import type {
  BridgeFrame,
  CommitReviewGroups,
  DiffHunk,
  DocSuggestion,
  LegacySection,
  PatchConflict,
  ToolCallStatus,
} from "@qingagent/contract-ts";
import { pmToLegacySections, type PmDoc } from "@qingagent/pm-schema";
import { mastra } from "../mastra.js";
import type { SessionState, SuggestionRecord } from "./sessionState.js";
import { updateToolCallInChatHistory } from "./sessionState.js";
import { buildDocumentSnapshot } from "./docGenerator.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { applySuggestionsToDoc } from "./pmPatch.js";
import { applyDiffHunks } from "./proposalDiff.js";
import { createSuggestionFromDiffHunk, diffHunkToStep } from "./draftReviewSuggestions.js";
import { rebaseRemainingPendingDraft } from "./pendingDraftRebase.js";
import { updateDocumentSuggestionStatus } from "../db/documentSuggestionsRepo.js";
import { documentDraftRepo } from "../db/documentDraftRepo.js";
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
import { docDiffReady, toolCallUpdated } from "./frames.js";
import { buildSuggestionToolCallSpec } from "./toolCards.js";
import { deriveTitleFromSections } from "./title.js";
import { schedulePersist } from "./threadPersistence.js";

const logger = mastra.getLogger();

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

async function* settleResolvedReviewRecords(
  state: SessionState,
  records: readonly SuggestionRecord[],
): AsyncGenerator<BridgeFrame> {
  for (const record of records) {
    const verdict = state.patchVerdicts.get(record.suggestion.id);
    const terminalStatus = verdict === "rejected" ? "rejected" : "committed";
    const nextSuggestion: DocSuggestion = { ...record.suggestion, status: terminalStatus };
    await updateDocumentSuggestionStatus(nextSuggestion.id, terminalStatus).catch(() => undefined);
    const spec = buildSuggestionToolCallSpec(nextSuggestion, { kind: terminalStatus });
    yield toolCallUpdated(record.messageId, record.suggestion.id, spec);
    updateToolCallInChatHistory(state, record.messageId, record.suggestion.id, spec);
    record.suggestion = nextSuggestion;
    deleteSettledRecord(state, record);
  }
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
): AsyncGenerator<BridgeFrame> {
  const byId = new Map(conflicts.map((conflict) => [conflict.suggestionId, conflict]));
  for (const record of records) {
    const id = record.suggestion.id;
    const verdict = state.patchVerdicts.get(id);
    if (verdict === "rejected") {
      const nextSuggestion: DocSuggestion = { ...record.suggestion, status: "rejected" };
      await updateDocumentSuggestionStatus(id, "rejected").catch(() => undefined);
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
    await updateDocumentSuggestionStatus(id, "conflict", conflict).catch(() => undefined);
    const spec = buildSuggestionToolCallSpec(nextSuggestion, {
      kind: "failed",
      data: { retriable: false, reason: conflict.message },
    });
    yield toolCallUpdated(record.messageId, id, spec);
    updateToolCallInChatHistory(state, record.messageId, id, spec);
    record.suggestion = nextSuggestion;
    deleteSettledRecord(state, record);
  }
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

export function* updatePatchVerdict(
  state: SessionState,
  patchId: string | undefined,
  verdict: "accepted" | "rejected",
  reviewBatchId?: string,
): Generator<BridgeFrame> {
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
    state.patchVerdicts.set(id, verdict);
    const suggestion: DocSuggestion = {
      ...suggestionRecord.suggestion,
      status: verdict,
    };
    suggestionRecord.suggestion = suggestion;
    state.suggestions.set(id, suggestionRecord);
    updateDocumentSuggestionStatus(id, verdict).catch(() => undefined);
    const spec = buildSuggestionToolCallSpec(suggestion, status);
    yield toolCallUpdated(suggestionRecord.messageId, id, spec);
    updateToolCallInChatHistory(state, suggestionRecord.messageId, id, spec);
  }
}

// ---------------------------------------------------------------------------
// commitPatches — apply accepted patches and emit new doc version
// ---------------------------------------------------------------------------

function rebuildPendingReviewAfterRebase(input: {
  state: SessionState;
  committedDoc: PmDoc;
  committedVersion: number;
  nextDraftDoc: PmDoc;
  hunks: DiffHunk[];
  previousRemainingRecords: readonly SuggestionRecord[];
}): DocSuggestion[] {
  const { state, committedDoc, committedVersion, nextDraftDoc, hunks } = input;
  const previousById = new Map(
    input.previousRemainingRecords.map((record) => [record.suggestion.id, record]),
  );
  const fallbackMessageId =
    input.previousRemainingRecords[0]?.messageId ??
    `rebased-pending-review:${state.docId}:${committedVersion}`;

  const suggestions = hunks.map((hunk) =>
    createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion: committedVersion,
      baseSchemaVersion: committedDoc.attrs.schemaVersion,
    }),
  );

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
    const previous = previousById.get(suggestion.id);
    state.suggestions.set(suggestion.id, {
      messageId: previous?.messageId ?? fallbackMessageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    });
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
    yield* settleResolvedReviewRecords(state, records);
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
      if (rebase.status === "pending") {
        const suggestions = rebuildPendingReviewAfterRebase({
          state,
          committedDoc: currentPmDoc(state),
          committedVersion: state.docVersion,
          nextDraftDoc: rebase.nextDraftDoc,
          hunks: rebase.hunks,
          previousRemainingRecords: remainingRecords,
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
            buildSuggestionToolCallSpec(record.suggestion, { kind: "reviewing" }),
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
  // 跳过集合在 apply 闭包内产生,captured 到外层以便提交成功后据此结算 + 提示用户。
  // (commitDocumentOp 在带 opId 的提交路径里 apply 恰好执行一次,captured 值即最终结果。)
  let skippedHunks: DiffHunk[] = [];
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
      summary: `提交 ${accepted.length} 处局部修改`,
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
          return {
            nextDoc: applyResult.doc,
            // steps 只为真正落上的 hunk 生成——被跳过的 hunk 不再写进 document_ops(修记假账)。
            steps: applyResult.applied.map((hunk) =>
              diffHunkToStep(
                hunk,
                hunk.anchor.pmFrom ?? 0,
                hunk.anchor.pmTo ?? hunk.anchor.pmFrom ?? 0,
              ),
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

  advanceLastContentEditedAt(state, result, previousDocVersion);
  state.doc = result.doc;
  state.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
  state.docVersion = result.docVersion;
  state._directionChangeAskedSinceLastWrite = false;
  if (shouldCommitDiffHunks) {
    const nextTitle = deriveTitleFromSections(state.legacySections);
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

  yield* settleResolvedReviewRecords(state, settledRecords);
  if (skippedRecords.length > 0) {
    const message = `有 ${skippedRecords.length} 处修改因文档已变化而失效，未写入；其余修改已提交。`;
    yield* settleUnappliedReviewRecords(
      state,
      skippedRecords,
      skippedRecords.map((record): PatchConflict => ({
        kind: "block_removed",
        message,
        suggestionId: record.suggestion.id,
        blockId: record.suggestion.anchor.blockId,
      })),
      message,
    );
  }

  const doc = buildDocumentSnapshot(state.legacySections, state.docVersion, result.doc);
  yield { kind: "documentSnapshotWritten", data: { doc } };

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
    if (rebase.status === "pending") {
      const suggestions = rebuildPendingReviewAfterRebase({
        state,
        committedDoc: result.doc,
        committedVersion: result.docVersion,
        nextDraftDoc: rebase.nextDraftDoc,
        hunks: rebase.hunks,
        previousRemainingRecords: remainingRecords,
      });
      yield docDiffReady(result.docVersion, suggestions, result.doc, rebase.nextDraftDoc);
      for (const record of state.suggestions.values()) {
        yield toolCallUpdated(
          record.messageId,
          record.suggestion.id,
          buildSuggestionToolCallSpec(record.suggestion, { kind: "reviewing" }),
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

  yield { kind: "docCommitted", data: { sessionId: state.sessionId, version: state.docVersion } };
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

  const commitIds = [...new Set([...acceptIds, ...rejectIds])];

  for (const id of acceptIds) {
    if (state.patchVerdicts.get(id) !== "accepted") {
      for (const frame of updatePatchVerdict(state, id, "accepted")) yield frame;
    }
  }
  for (const id of rejectIds) {
    if (state.patchVerdicts.get(id) !== "rejected") {
      for (const frame of updatePatchVerdict(state, id, "rejected")) yield frame;
    }
  }

  if (commitIds.length === 0) {
    yield reviewNoopCompletionFrame(state, "commit");
    return;
  }
  for await (const frame of commitPatches(state, commitIds)) {
    yield frame;
  }
}
