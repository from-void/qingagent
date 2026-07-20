import type { DocSuggestion } from "@qingagent/contract-ts";
import type { SavePendingDraftInput } from "./documentDraftRepo.js";
import { savePendingDocumentDraft } from "./documentDraftRepo.js";
import {
  ignoreRebasedDocumentSuggestions,
  upsertDocumentSuggestion,
} from "./documentSuggestionsRepo.js";
import { commitTransaction, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export interface RebasedPreviousSuggestions {
  baseVersion: number;
  suggestionIds: readonly string[];
}

export interface ReplaceRebasedReviewInput {
  draft: SavePendingDraftInput;
  suggestions: readonly DocSuggestion[];
  previousSuggestions: readonly RebasedPreviousSuggestions[];
}

/** 原子替换 rebase 审阅：草稿、新建议与旧批次失效要么全部提交，要么全部回滚。 */
export async function replaceRebasedReview(input: ReplaceRebasedReviewInput): Promise<void> {
  await ensureMigrated();
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    await savePendingDocumentDraft(input.draft, client, now);
    for (const previous of input.previousSuggestions) {
      await ignoreRebasedDocumentSuggestions(
        input.draft.docId,
        previous.baseVersion,
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
