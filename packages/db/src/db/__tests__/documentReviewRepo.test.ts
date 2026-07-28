import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { getPmContentHash } from "@qingagent/pm-schema";
import { documentDraftRepo } from "../documentDraftRepo.js";
import {
  replaceRebasedReview,
  saveInitialReviewBatch,
  settleRejectedDocumentReview,
} from "../documentReviewRepo.js";
import {
  listDocumentSuggestionStatuses,
  listDocumentSuggestionStatusesInBatch,
  updateDocumentSuggestionStatus,
  upsertDocumentSuggestion,
} from "../documentSuggestionsRepo.js";
import { getDocumentsClient } from "../documentsClient.js";
import { ensureMigrated } from "../migrations.js";
import {
  pmDocFromText,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

function suggestion(id: string, docId: string, baseVersion: number): DocSuggestion {
  return {
    id,
    docId,
    baseVersion,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: { blockId: id, pmFrom: 1, pmTo: 2, quote: "旧", textHash: "hash" },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: { deleteText: "旧", insertText: "新" },
    summary: "替换文本",
  };
}

describe("replaceRebasedReview", () => {
  let db: TempDocumentsDb;

  beforeEach(() => { db = prepareTempDocumentsDb("qa-rebased-review-"); });
  afterEach(() => db.cleanup());

  it("F8: 第 N 条新建议写入失败时草稿、新建议与旧状态整体回滚", async () => {
    const docId = "doc-atomic-rebase";
    const oldDraft = pmDocFromText("旧待审草稿");
    const newDraft = pmDocFromText("新待审草稿");
    await documentDraftRepo.savePending({
      docId,
      threadId: "thread-atomic-rebase",
      baseVersion: 1,
      baseHash: getPmContentHash(pmDocFromText("旧正文")),
      draftPmDoc: oldDraft,
    });
    await upsertDocumentSuggestion(suggestion("old-accepted", docId, 1));
    await upsertDocumentSuggestion(suggestion("old-reviewing", docId, 1));
    await updateDocumentSuggestionStatus(docId, 1, "old-accepted", "accepted");

    await getDocumentsClient().execute(`CREATE TRIGGER fail_second_rebased_suggestion
      BEFORE INSERT ON document_suggestions
      WHEN NEW.doc_id = '${docId}' AND NEW.base_version = 2 AND NEW.id = 'new-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected second suggestion failure');
      END`);

    await expect(replaceRebasedReview({
      draft: {
        docId,
        threadId: "thread-atomic-rebase",
        baseVersion: 2,
        baseHash: getPmContentHash(pmDocFromText("新正文")),
        draftPmDoc: newDraft,
        batchId: "new-batch",
      },
      suggestions: [
        { ...suggestion("new-1", docId, 2), batchId: "new-batch" },
        { ...suggestion("new-2", docId, 2), batchId: "new-batch" },
        { ...suggestion("new-3", docId, 2), batchId: "new-batch" },
      ],
      previousSuggestions: [{
        baseVersion: 1,
        batchId: "legacy",
        suggestionIds: ["old-accepted", "old-reviewing"],
      }],
    })).rejects.toThrow("injected second suggestion failure");

    const draftAfterFailure = await documentDraftRepo.load(docId);
    expect(draftAfterFailure?.baseVersion).toBe(1);
    expect(draftAfterFailure?.draftPmDoc).toEqual(oldDraft);
    await expect(listDocumentSuggestionStatusesInBatch(
      docId,
      2,
      "new-batch",
    )).resolves.toEqual([]);
    await expect(listDocumentSuggestionStatuses(docId, 1)).resolves.toEqual(
      expect.arrayContaining([
        { id: "old-accepted", status: "accepted", conflict: undefined },
        { id: "old-reviewing", status: "reviewing", conflict: undefined },
      ]),
    );
  });
});

describe("saveInitialReviewBatch", () => {
  let db: TempDocumentsDb;

  beforeEach(() => { db = prepareTempDocumentsDb("qa-initial-review-"); });
  afterEach(() => db.cleanup());

  it("RF6: 第 N 条建议写入失败时草稿与整批建议均不残留", async () => {
    const docId = "doc-atomic-initial-review";
    const draft = pmDocFromText("首次待审草稿");
    await ensureMigrated();
    await getDocumentsClient().execute(`CREATE TRIGGER fail_second_initial_suggestion
      BEFORE INSERT ON document_suggestions
      WHEN NEW.doc_id = '${docId}' AND NEW.id = 'initial-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected second initial suggestion failure');
      END`);

    await expect(saveInitialReviewBatch({
      draft: {
        docId,
        threadId: "thread-atomic-initial-review",
        baseVersion: 1,
        baseHash: getPmContentHash(pmDocFromText("正文")),
        draftPmDoc: draft,
        batchId: "initial-batch",
      },
      suggestions: [
        { ...suggestion("initial-1", docId, 1), batchId: "initial-batch" },
        { ...suggestion("initial-2", docId, 1), batchId: "initial-batch" },
        { ...suggestion("initial-3", docId, 1), batchId: "initial-batch" },
      ],
    })).rejects.toThrow("injected second initial suggestion failure");

    await expect(documentDraftRepo.load(docId)).resolves.toBeNull();
    await expect(listDocumentSuggestionStatusesInBatch(
      docId,
      1,
      "initial-batch",
    )).resolves.toEqual([]);
  });
});

describe("settleRejectedDocumentReview", () => {
  let db: TempDocumentsDb;

  beforeEach(() => { db = prepareTempDocumentsDb("qa-rejected-review-"); });
  afterEach(() => db.cleanup());

  it("draft 删除失败时终态建议与删除整体回滚，重试后一起落地", async () => {
    const docId = "doc-atomic-rejected-review";
    const pendingSuggestion = suggestion("rejected-1", docId, 1);
    const baseHash = getPmContentHash(pmDocFromText("旧正文"));
    await documentDraftRepo.savePending({
      docId,
      threadId: "thread-atomic-rejected-review",
      baseVersion: 1,
      baseHash,
      draftPmDoc: pmDocFromText("待拒绝草稿"),
    });
    await upsertDocumentSuggestion(pendingSuggestion);
    await getDocumentsClient().execute(`CREATE TRIGGER fail_rejected_draft_delete
      BEFORE DELETE ON document_drafts
      WHEN OLD.doc_id = '${docId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected rejected draft delete failure');
      END`);

    await expect(settleRejectedDocumentReview({
      docId,
      draft: { batchId: "legacy", baseVersion: 1, baseHash },
      suggestions: [pendingSuggestion],
    })).rejects.toThrow("injected rejected draft delete failure");

    await expect(documentDraftRepo.load(docId)).resolves.toMatchObject({
      docId,
      status: "pending_review",
    });
    await expect(listDocumentSuggestionStatuses(docId, 1)).resolves.toEqual([
      { id: pendingSuggestion.id, status: "reviewing", conflict: undefined },
    ]);

    await getDocumentsClient().execute("DROP TRIGGER fail_rejected_draft_delete");
    await settleRejectedDocumentReview({
      docId,
      draft: { batchId: "legacy", baseVersion: 1, baseHash },
      suggestions: [pendingSuggestion],
    });

    await expect(documentDraftRepo.load(docId)).resolves.toBeNull();
    await expect(listDocumentSuggestionStatuses(docId, 1)).resolves.toEqual([
      { id: pendingSuggestion.id, status: "rejected", conflict: undefined },
    ]);
  });

  it("旧批次结算 CAS 失败时保留新批次草稿", async () => {
    const docId = "doc-stale-rejected-review";
    const oldBaseHash = getPmContentHash(pmDocFromText("旧批次正文"));
    const newBaseHash = getPmContentHash(pmDocFromText("新批次正文"));
    const oldSuggestion = {
      ...suggestion("old-rejected", docId, 1),
      batchId: "batch-a",
    };
    await documentDraftRepo.savePending({
      docId,
      threadId: "thread-stale-rejected-review",
      baseVersion: 1,
      baseHash: oldBaseHash,
      draftPmDoc: pmDocFromText("批次 A 草稿"),
      batchId: "batch-a",
    });
    await upsertDocumentSuggestion(oldSuggestion);
    await documentDraftRepo.savePending({
      docId,
      threadId: "thread-stale-rejected-review",
      baseVersion: 2,
      baseHash: newBaseHash,
      draftPmDoc: pmDocFromText("批次 B 草稿"),
      batchId: "batch-b",
    });

    await expect(settleRejectedDocumentReview({
      docId,
      draft: {
        batchId: "batch-a",
        baseVersion: 1,
        baseHash: oldBaseHash,
      },
      suggestions: [oldSuggestion],
    })).rejects.toMatchObject({
      code: "DOCUMENT_DRAFT_SETTLEMENT_CONFLICT",
    });

    await expect(documentDraftRepo.load(docId)).resolves.toMatchObject({
      batchId: "batch-b",
      baseVersion: 2,
      baseHash: newBaseHash,
      status: "pending_review",
    });
    await expect(listDocumentSuggestionStatusesInBatch(
      docId,
      1,
      "batch-a",
    )).resolves.toEqual([
      { id: oldSuggestion.id, status: "reviewing", conflict: undefined },
    ]);
  });
});
