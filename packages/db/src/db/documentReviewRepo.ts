import type { DocSuggestion } from "@qingagent/contract-ts";
import type { SavePendingDraftInput } from "./documentDraftRepo.js";
import {
  clearDocumentDraft,
  savePendingDocumentDraft,
} from "./documentDraftRepo.js";
import {
  ignoreRebasedDocumentSuggestionsInBatch,
  LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
  updateDocumentSuggestionStatusInBatch,
  upsertDocumentSuggestion,
} from "./documentSuggestionsRepo.js";
import { commitTransaction, withTransaction } from "./documentsClient.js";
import { DocumentWriteBlockedError } from "./documentWriteGuard.js";
import { ensureMigrated } from "./migrations.js";

export interface RebasedPreviousSuggestions {
  baseVersion: number;
  batchId: string;
  suggestionIds: readonly string[];
}

export interface ReplaceRebasedReviewInput {
  draft: SavePendingDraftInput & { batchId: string };
  suggestions: readonly DocSuggestion[];
  previousSuggestions: readonly RebasedPreviousSuggestions[];
}

export interface SaveInitialReviewBatchInput {
  draft: SavePendingDraftInput & { batchId: string };
  suggestions: readonly DocSuggestion[];
}

export interface SettleRejectedDocumentReviewInput {
  docId: string;
  suggestions: readonly DocSuggestion[];
}

/**
 * 全拒绝审阅的终态建议与 draft 必须原子结算。删除 draft 失败时回滚建议终态，
 * 调用方即可保留原审阅运行态重试，避免重启后从遗留 draft 复活已完成审阅。
 */
export async function settleRejectedDocumentReview(
  input: SettleRejectedDocumentReviewInput,
): Promise<void> {
  await ensureMigrated();
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    for (const suggestion of input.suggestions) {
      if (suggestion.docId !== input.docId) {
        throw new Error(`Rejected review suggestion document mismatch: ${suggestion.id}`);
      }
      const batchId = suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID;
      const rowsAffected = await updateDocumentSuggestionStatusInBatch(
        input.docId,
        suggestion.baseVersion,
        batchId,
        suggestion.id,
        "rejected",
        undefined,
        client,
        now,
      );
      if (rowsAffected === 0) {
        throw new Error(
          `Document suggestion not found: ${input.docId}@${suggestion.baseVersion}:${batchId}:${suggestion.id}`,
        );
      }
    }
    await clearDocumentDraft(input.docId, client);
    return commitTransaction(undefined);
  });
}

/** 首次进入审阅时原子保存草稿与整批建议，禁止暴露半批次。 */
export async function saveInitialReviewBatch(input: SaveInitialReviewBatchInput): Promise<void> {
  await ensureMigrated();
  for (const suggestion of input.suggestions) {
    if (
      suggestion.docId !== input.draft.docId
      || suggestion.baseVersion !== input.draft.baseVersion
      || suggestion.batchId !== input.draft.batchId
    ) {
      throw new Error(`Initial review suggestion batch mismatch: ${suggestion.id}`);
    }
  }
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    await savePendingDocumentDraft(input.draft, client, now);
    for (const suggestion of input.suggestions) {
      await upsertDocumentSuggestion(suggestion, client, now);
    }
    return commitTransaction(undefined);
  });
}

/** 原子替换 rebase 审阅：草稿、新建议与旧批次失效要么全部提交，要么全部回滚。 */
export async function replaceRebasedReview(input: ReplaceRebasedReviewInput): Promise<void> {
  await ensureMigrated();
  for (const suggestion of input.suggestions) {
    if (suggestion.batchId !== input.draft.batchId) {
      throw new Error(`Rebased suggestion batch mismatch: ${suggestion.id}`);
    }
  }
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    const tombstone = await client.execute({
      sql: "SELECT 1 FROM deleted_sessions WHERE session_id IN (?, ?) LIMIT 1",
      args: [input.draft.docId, input.draft.threadId],
    });
    if (tombstone.rows.length > 0) {
      throw new DocumentWriteBlockedError({
        docId: input.draft.docId,
        threadId: input.draft.threadId,
        operation: "documentDraft.savePending",
      });
    }
    await savePendingDocumentDraft(input.draft, client, now);
    for (const previous of input.previousSuggestions) {
      await ignoreRebasedDocumentSuggestionsInBatch(
        input.draft.docId,
        previous.baseVersion,
        previous.batchId,
        previous.suggestionIds,
        client,
        now,
      );
    }
    for (const suggestion of input.suggestions) {
      await upsertDocumentSuggestion(suggestion, client, now);
    }
    return commitTransaction(undefined);
  });
}
