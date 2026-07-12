import type { BridgeFrame, DiffHunk, DocSuggestion } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  materializeDraftBlockIds,
  pmToLegacySections,
  type PmDoc,
} from "@qingagent/pm-schema";
import { documentDraftRepo, type DocumentDraftRow } from "@qingagent/db";
import { mastra } from "../mastra.js";
import { advanceLastContentEditedAt, commitDocumentOp } from "./commitDocumentOp.js";
import { buildDraftDiff } from "./proposalDiff.js";
import { createSuggestionFromDiffHunk } from "./draftReviewSuggestions.js";
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
): BridgeFrame {
  return {
    kind: "docDiffReady",
    data: { baseVersion, suggestions, previewDoc, ...(editedDoc ? { editedDoc } : {}) },
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
  state.patchValidationResults.clear();
  state.suggestionBaseDoc = null;
  state.suggestionBaseVersion = null;
  state.docDraftBaseDoc = null;
  state.docDraftBaseSections = null;
  state.docDraftBaseVersion = null;
  state.docDraftCandidateDoc = null;
  state.docDraftCandidateSections = null;
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
  state.legacySections = pmToLegacySections(result.doc) as never;
  state.docVersion = result.docVersion;
  state.docState = { kind: "editing" };
  clearReviewDraftRuntime(state);
  await documentDraftRepo.clear(state.docId);
  return { kind: "restored", frames: [], hunks: [] };
}

export async function rehydratePendingDraft(
  state: SessionState,
): Promise<PendingDraftRehydrateResult> {
  const row = await documentDraftRepo.load(state.docId);
  if (!row || row.status === "conflict") {
    return { kind: "skipped" };
  }

  if (row.status === "draft_candidate" && row.baseVersion === 0) {
    return rehydrateFirstDraftCandidate(state, row);
  }

  if (row.status !== "pending_review" && row.status !== "draft_candidate") {
    return { kind: "skipped" };
  }

  const currentDoc = state.doc;
  if (!currentDoc) {
    await documentDraftRepo.markConflict({
      docId: state.docId,
      conflict: { kind: "missing_current_doc", baseVersion: row.baseVersion },
    });
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  const currentHash = getPmContentHash(currentDoc);
  if (row.baseHash !== currentHash) {
    await documentDraftRepo.markConflict({
      docId: state.docId,
      conflict: {
        kind: "base_hash_mismatch",
        baseVersion: row.baseVersion,
        expectedBaseHash: row.baseHash,
        currentHash,
      },
    });
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "conflict", frames: [conflictFrame(state.sessionId)] };
  }

  const draftDoc = materializeDraftBlockIds(row.draftPmDoc, { namespace: "draft.rehydrate" });
  const hunks = buildDraftDiff(currentDoc, draftDoc, { baseVersion: row.baseVersion });
  if (hunks.length === 0) {
    await documentDraftRepo.clear(state.docId);
    state.docState = { kind: "editing" };
    clearReviewDraftRuntime(state);
    return { kind: "empty_diff", frames: [] };
  }

  const baseVersion = row.baseVersion;
  const suggestions = hunks.map((hunk) =>
    createSuggestionFromDiffHunk({
      hunk,
      docId: state.docId,
      baseVersion,
      baseSchemaVersion: currentDoc.attrs.schemaVersion,
    }),
  );

  state.suggestions.clear();
  state.patchVerdicts.clear();
  state.patchValidationResults.clear();
  state.suggestionBaseDoc = clonePmDoc(currentDoc);
  state.suggestionBaseVersion = baseVersion;
  state.docDraftBaseDoc = clonePmDoc(currentDoc);
  state.docDraftBaseVersion = baseVersion;
  state.docDraftBaseSections = pmToLegacySections(currentDoc) as never;
  state.docDraftCandidateDoc = draftDoc;
  state.docDraftCandidateSections = pmToLegacySections(draftDoc) as never;
  state.docState = { kind: "pendingReview" };

  const messageId = `restored-pending-review:${state.docId}:${baseVersion}`;
  suggestions.forEach((suggestion, index) => {
    const hunk = hunks[index]!;
    const record: SuggestionRecord = {
      messageId,
      toolCallId: suggestion.id,
      before: hunk.beforeText ?? "",
      after: hunk.afterText ?? "",
      blockIndex: hunk.blockPath[0] ?? 0,
      suggestion,
      diffHunk: hunk,
    };
    state.suggestions.set(suggestion.id, record);
  });

  return {
    kind: "restored",
    frames: [docDiffReady(baseVersion, suggestions, currentDoc, draftDoc)],
    hunks,
  };
}
