import type { BridgeFrame, DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  materializeDraftBlockIds,
  type PmDoc,
} from "@qingagent/pm-schema";
import {
  documentDraftRepo,
  findOpByDocumentVersion,
  getVersionSnapshotByDocumentSnapshot,
  listDocumentSuggestionStatusesInBatch,
  replaceRebasedReview,
  upsertDocumentSuggestion,
  type DocumentDraftRow,
} from "@qingagent/db";
import { mastra } from "../mastra.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { buildDraftDiff } from "./proposalDiff.js";
import {
  createSuggestionBatchId,
  createSuggestionFromDiffHunk,
  isWholeDocumentSuggestionBatchId,
} from "./draftReviewSuggestions.js";
import { rebaseRemainingPendingDraft } from "./pendingDraftRebase.js";
import type { SessionState, SuggestionRecord } from "../session/sessionState.js";

const logger = mastra.getLogger();

export type PendingDraftRehydrateResult =
  | { kind: "skipped" }
  | { kind: "restored"; frames: BridgeFrame[]; hunks: DiffHunk[] }
  | { kind: "conflict"; frames: BridgeFrame[] }
  | { kind: "empty_diff"; frames: BridgeFrame[] };

function clonePmDoc(doc: PmDoc): PmDoc {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(doc) as PmDoc;
  }
  return JSON.parse(JSON.stringify(doc)) as PmDoc;
}

function docDiffReady(
  baseVersion: number,
  suggestions: DocSuggestion[],
  previewDoc: PmDoc,
  editedDoc?: PmDoc,
  wholeDocument = false,
): BridgeFrame {
  return {
    kind: "docDiffReady",
    data: {
      baseVersion,
      suggestions,
      previewDoc,
      ...(editedDoc ? { editedDoc } : {}),
      ...(wholeDocument ? { wholeDocument: true } : {}),
    },
  };
}

function conflictFrame(sessionId: string): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId: `restored-pending-review:${sessionId}`,
        reason: "正文已变化，请重新生成本轮审阅。",
        retriable: false,
      },
    },
  };
}

function clearReviewDraftRuntime(state: SessionState): void {
  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.suggestionBaseDoc = null;
  state.suggestionBaseVersion = null;
  state.docDraftBaseDoc = null;
  state.docDraftBaseVersion = null;
  state.docDraftCandidateDoc = null;
}

function hunkContentKey(hunk: DiffHunk): string {
  return JSON.stringify([hunk.op, hunk.beforeText ?? "", hunk.afterText ?? ""]);
}

/**
 * RF3 崩溃恢复：canonical patch 已落库、旧批次结算完成，但 rebase 批次事务失败时，
 * document_ops.steps 是不会随进程丢失的恢复凭据。只有 op 精确承接草稿 baseVersion，
 * 且 suggestionId 命中旧批次时才重放，避免把普通并发编辑误判成可恢复 rebase。
 */
async function replayInterruptedReviewRebase(
  state: SessionState,
  row: DocumentDraftRow,
  currentDoc: PmDoc,
): Promise<boolean> {
  if (state.docVersion !== row.baseVersion + 1) return false;
  const op = await findOpByDocumentVersion(state.docId, state.docVersion);
  if (!op || op.opKind !== "patch_steps" || op.fromVersion !== row.baseVersion) return false;

  const oldVersion = await getVersionSnapshotByDocumentSnapshot(state.docId, row.baseVersion);
  if (!oldVersion || getPmContentHash(oldVersion.snapshotPm) !== row.baseHash) return false;

  const oldBaseDoc = oldVersion.snapshotPm;
  const oldDraftDoc = materializeDraftBlockIds(row.draftPmDoc, {
    namespace: "draft.rehydrate.rebase-old",
  });
  const oldHunks = buildDraftDiff(oldBaseDoc, oldDraftDoc, { baseVersion: row.baseVersion });
  const oldSuggestions = oldHunks.map((hunk) => createSuggestionFromDiffHunk({
    hunk,
    docId: state.docId,
    baseVersion: row.baseVersion,
    baseSchemaVersion: oldBaseDoc.attrs.schemaVersion,
    batchId: row.batchId,
  }));
  const oldSuggestionIds = new Set(oldSuggestions.map((suggestion) => suggestion.id));
  const appliedIds = new Set(
    (op.steps ?? [])
      .map((step) => step.suggestionId)
      .filter((id): id is string => typeof id === "string" && oldSuggestionIds.has(id)),
  );
  if (appliedIds.size === 0) return false;

  const statusRows = await listDocumentSuggestionStatusesInBatch(
    state.docId,
    row.baseVersion,
    row.batchId,
    oldSuggestions.map((suggestion) => suggestion.id),
  );
  const statuses = new Map(statusRows.map((status) => [status.id, status.status] as const));
  const messageId = `recovered-pending-review:${state.docId}:${state.docVersion}`;
  const remainingRecords: SuggestionRecord[] = [];
  oldSuggestions.forEach((suggestion, index) => {
    const status = statuses.get(suggestion.id) ?? suggestion.status;
    if (appliedIds.has(suggestion.id) || status === "committed" || status === "conflict" || status === "ignored") {
      return;
    }
    const hunk = oldHunks[index]!;
    remainingRecords.push({
      messageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion: status === "accepted" || status === "rejected"
        ? { ...suggestion, status }
        : suggestion,
      diffHunk: hunk,
    });
  });
  if (remainingRecords.length === 0) return false;

  const rebased = await rebaseRemainingPendingDraft({
    docId: state.docId,
    threadId: state.threadId ?? state.sessionId,
    oldBaseDoc,
    oldDraftDoc,
    committedDoc: currentDoc,
    committedVersion: state.docVersion,
    remainingRecords,
    persist: false,
  });
  if (rebased.status !== "pending") return false;

  const batchId = createSuggestionBatchId(state.docVersion, rebased.nextDraftDoc, {
    wholeDocument: isWholeDocumentSuggestionBatchId(row.batchId),
  });
  const available = [...remainingRecords];
  const rebasedSuggestions = rebased.hunks.map((hunk) => {
    const exactIndex = available.findIndex((record) => record.diffHunk?.hunkId === hunk.hunkId);
    const contentKey = hunkContentKey(hunk);
    const fallbackIndexes = available
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.diffHunk
        && hunkContentKey(record.diffHunk) === contentKey
        && (record.diffHunk.anchor.blockId ?? "") === (hunk.anchor.blockId ?? ""))
      .map(({ index }) => index);
    const matchedIndex = exactIndex >= 0
      ? exactIndex
      : fallbackIndexes.length === 1 ? fallbackIndexes[0]! : -1;
    const previous = matchedIndex >= 0 ? available.splice(matchedIndex, 1)[0] : undefined;
    const suggestion = createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion: state.docVersion,
      baseSchemaVersion: currentDoc.attrs.schemaVersion,
      batchId,
    });
    const status = previous?.suggestion.status;
    return status === "accepted" || status === "rejected"
      ? { ...suggestion, status }
      : suggestion;
  });

  await replaceRebasedReview({
    draft: {
      docId: state.docId,
      threadId: state.threadId ?? state.sessionId,
      baseVersion: state.docVersion,
      baseHash: getPmContentHash(currentDoc),
      draftPmDoc: rebased.nextDraftDoc,
      batchId,
      reviewBatchId: rebasedSuggestions[0]?.reviewBatchId ?? null,
      groupMode: rebasedSuggestions[0]?.groupMode ?? null,
    },
    suggestions: rebasedSuggestions,
    previousSuggestions: [{
      baseVersion: row.baseVersion,
      batchId: row.batchId,
      suggestionIds: oldSuggestions.map((suggestion) => suggestion.id),
    }],
  });
  logger.warn("Replayed interrupted pending-review rebase from document op", {
    sessionId: state.sessionId,
    docId: state.docId,
    fromVersion: row.baseVersion,
    toVersion: state.docVersion,
    recoveredSuggestionCount: rebasedSuggestions.length,
  });
  return true;
}

async function rehydrateFirstDraftCandidate(
  state: SessionState,
  row: DocumentDraftRow,
): Promise<PendingDraftRehydrateResult> {
  const sourceStreamId = row.sourceStreamId?.trim();
  if (!sourceStreamId) {
    await documentDraftRepo.markConflict({
      docId: state.docId,
      conflict: {
        kind: "missing_source_stream_id",
        status: row.status,
        baseVersion: row.baseVersion,
      },
    });
    logger.error("draft_candidate missing source_stream_id; marked conflict", {
      sessionId: state.sessionId,
      threadId: state.threadId,
      docId: state.docId,
    });
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  const draftDoc = materializeDraftBlockIds(row.draftPmDoc, { namespace: "draft.rehydrate.first" });
  const previousDocVersion = state.docVersion;
  const result = await commitDocumentOp({
    docId: state.docId,
    threadId: state.threadId ?? state.sessionId,
    resourceId: state.resourceId,
    expectedDocumentSnapshot: 0,
    opId: `generation:${state.sessionId}:${sourceStreamId}`,
    opKind: "replace_doc",
    actorType: "agent",
    summary: "AI 生成文档",
    createIfMissing: {
      title: state.title,
      docState: "editing",
      lastSyncedVersion: state.lastSyncedDocumentSnapshot,
    },
    apply: () => ({ nextDoc: draftDoc }),
  });

  if (result.status !== "committed") {
    await documentDraftRepo.markConflict({
      docId: state.docId,
      conflict: {
        kind: "first_draft_candidate_commit_failed",
        status: result.status,
        baseVersion: row.baseVersion,
      },
    });
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  advanceLastContentEditedAt(state, result, previousDocVersion);
  state.doc = result.doc;
  state.docVersion = result.docVersion;
  state.docState = { kind: "editing" };
  clearReviewDraftRuntime(state);
  await documentDraftRepo.clear(state.docId);
  return { kind: "restored", frames: [], hunks: [] };
}

export async function rehydratePendingDraft(
  state: SessionState,
  options: { readOnly?: boolean } = {},
): Promise<PendingDraftRehydrateResult> {
  const row = await documentDraftRepo.load(state.docId);
  if (!row || row.status === "conflict") {
    return { kind: "skipped" };
  }
  if (row.status === "draft_candidate" && row.baseVersion === 0) {
    // 首稿候选恢复会提交正文并清理草稿，只读快照不能把 GET 变成写请求。
    if (options.readOnly) return { kind: "skipped" };
    return rehydrateFirstDraftCandidate(state, row);
  }

  if (row.status !== "pending_review" && row.status !== "draft_candidate") {
    return { kind: "skipped" };
  }

  const currentDoc = state.doc;
  if (!currentDoc) {
    if (!options.readOnly) {
      await documentDraftRepo.markConflict({
        docId: state.docId,
        conflict: { kind: "missing_current_doc", baseVersion: row.baseVersion },
      });
    }
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  const currentHash = getPmContentHash(currentDoc);
  if (row.baseHash !== currentHash) {
    if (!options.readOnly && await replayInterruptedReviewRebase(state, row, currentDoc)) {
      return rehydratePendingDraft(state, options);
    }
    if (!options.readOnly) {
      await documentDraftRepo.markConflict({
        docId: state.docId,
        conflict: {
          kind: "base_hash_mismatch",
          baseVersion: row.baseVersion,
          expectedBaseHash: row.baseHash,
          currentHash,
        },
      });
    }
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  const draftDoc = materializeDraftBlockIds(row.draftPmDoc, { namespace: "draft.rehydrate" });
  const hunks = buildDraftDiff(currentDoc, draftDoc, { baseVersion: row.baseVersion });
  if (hunks.length === 0) {
    if (!options.readOnly) await documentDraftRepo.clear(state.docId);
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "empty_diff", frames: [] };
  }

  const baseVersion = row.baseVersion;
  const rebuiltSuggestions = hunks.map((hunk) =>
    createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion,
      baseSchemaVersion: currentDoc.attrs.schemaVersion,
      batchId: row.batchId,
    }),
  );
  const persistedStatusRows = await listDocumentSuggestionStatusesInBatch(
    state.docId,
    baseVersion,
    row.batchId,
    rebuiltSuggestions.map((suggestion) => suggestion.id),
  );
  const persistedStatuses = new Map(
    persistedStatusRows.map((record) => [record.id, record] as const),
  );
  if (!options.readOnly && persistedStatuses.size < rebuiltSuggestions.length) {
    for (const suggestion of rebuiltSuggestions) {
      if (!persistedStatuses.has(suggestion.id)) {
        await upsertDocumentSuggestion(suggestion);
      }
    }
  }
  const suggestions = rebuiltSuggestions.map((suggestion) => {
    const persisted = persistedStatuses.get(suggestion.id);
    if (persisted?.status !== "accepted" && persisted?.status !== "rejected") {
      return suggestion;
    }
    return { ...suggestion, status: persisted.status };
  });

  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.suggestionBaseDoc = clonePmDoc(currentDoc);
  state.suggestionBaseVersion = baseVersion;
  state.docDraftBaseDoc = clonePmDoc(currentDoc);
  state.docDraftBaseVersion = baseVersion;
  state.docDraftCandidateDoc = draftDoc;
  state.docState = { kind: "pendingReview" };

  const messageId = `restored-pending-review:${state.docId}:${baseVersion}`;
  suggestions.forEach((suggestion, index) => {
    const hunk = hunks[index]!;
    const record: SuggestionRecord = {
      messageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockPath: [...hunk.blockPath],
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    };
    state.suggestions.set(suggestion.id, record);
    if (suggestion.status === "accepted" || suggestion.status === "rejected") {
      state.patchVerdicts.set(suggestion.id, suggestion.status);
    }
  });

  return {
    kind: "restored",
    frames: [docDiffReady(
      baseVersion,
      suggestions,
      currentDoc,
      draftDoc,
      isWholeDocumentSuggestionBatchId(row.batchId),
    )],
    hunks,
  };
}
