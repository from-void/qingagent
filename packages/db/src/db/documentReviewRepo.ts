import type { DocSuggestion } from "@qingagent/contract-ts";
import type { SavePendingDraftInput } from "./documentDraftRepo.js";
import { savePendingDocumentDraft } from "./documentDraftRepo.js";
import {
  ignoreRebasedDocumentSuggestionsInBatch,
  upsertDocumentSuggestion,
} from "./documentSuggestionsRepo.js";
import { commitTransaction, withTransaction } from "./documentsClient.js";
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
