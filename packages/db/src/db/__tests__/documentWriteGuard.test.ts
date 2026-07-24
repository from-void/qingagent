import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { getPmContentHash } from "@qingagent/pm-schema";
import { documentDraftRepo } from "../documentDraftRepo.js";
import { documentRepo } from "../documentRepo.js";
import { replaceRebasedReview } from "../documentReviewRepo.js";
import { getDocumentsClient } from "../documentsClient.js";
import {
  beginSessionDeletion,
  deleteSessionDocumentsAndAdvance,
} from "../sessionDeletionRepo.js";
import {
  ignoreAnnotationGroups,
  ignoreRebasedDocumentSuggestions,
  insertAnnotationGroups,
  listDocumentSuggestionStatuses,
  persistMappedAnnotationGroups,
  replaceAnnotationGroupsByOrigin,
  updateDocumentSuggestionStatus,
  upsertDocumentSuggestion,
} from "../documentSuggestionsRepo.js";
import {
  DocumentRecoveryRequiredError,
  DocumentWriteBlockedError,
  setDocumentWriteGuard,
} from "../documentWriteGuard.js";
import {
  documentInput,
  pmDocFromText,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

function suggestion(docId: string): DocSuggestion {
  return {
    id: `suggestion-${docId}`,
    docId,
    baseVersion: 1,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: { blockId: "block-a", pmFrom: 1, pmTo: 2, quote: "旧", textHash: "hash" },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: { deleteText: "旧", insertText: "新" },
    summary: "替换文本",
  };
}

describe("document write guard", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-document-write-guard-");
    setDocumentWriteGuard((target) => {
      if (target.docId === "blocked-doc" || target.threadId === "blocked-thread") {
        throw new DocumentWriteBlockedError(target);
      }
    });
  });

  afterEach(() => {
    setDocumentWriteGuard(null);
    db.cleanup();
  });

  it("在 SQL 前拒绝 documents 单写与批写，批次不产生部分行", async () => {
    await expect(documentRepo.save(documentInput("blocked-doc")))
      .rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentRepo.saveMany([
      documentInput("allowed-before-blocked"),
      documentInput("blocked-doc"),
    ])).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentRepo.save(documentInput("thread-target", {
      threadId: "blocked-thread",
    }))).rejects.toBeInstanceOf(DocumentWriteBlockedError);

    await expect(documentRepo.load("blocked-doc")).resolves.toBeNull();
    await expect(documentRepo.load("allowed-before-blocked")).resolves.toBeNull();
    await expect(documentRepo.load("thread-target")).resolves.toBeNull();
  });

  it("拒绝 draft pending/candidate 与 suggestion upsert 复建", async () => {
    const draft = pmDocFromText("迟到草稿");
    const baseHash = getPmContentHash(pmDocFromText("基线"));

    await expect(documentDraftRepo.savePending({
      docId: "blocked-doc",
      threadId: "blocked-thread",
      baseVersion: 1,
      baseHash,
      draftPmDoc: draft,
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentDraftRepo.saveCandidate({
      docId: "blocked-doc",
      threadId: "blocked-thread",
      baseVersion: 0,
      baseHash,
      draftPmDoc: draft,
      sourceStreamId: "late-stream",
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(upsertDocumentSuggestion(suggestion("blocked-doc")))
      .rejects.toBeInstanceOf(DocumentWriteBlockedError);

    await expect(documentDraftRepo.load("blocked-doc")).resolves.toBeNull();
    await expect(listDocumentSuggestionStatuses("blocked-doc", 1)).resolves.toEqual([]);
  });

  it("RF2: 进程内 guard 为空时 SQL 墓碑仍拒绝 draft/suggestion 及批量审阅替换", async () => {
    const docId = "persisted-tombstone";
    const threadId = "persisted-tombstone-thread";
    const draftInput = {
      docId,
      threadId,
      baseVersion: 1,
      baseHash: getPmContentHash(pmDocFromText("基线")),
      draftPmDoc: pmDocFromText("迟到草稿"),
    };
    const oldGroup = {
      id: "old-group",
      summary: "旧批注",
      note: "旧批注",
      origin: "test",
      status: "reviewing" as const,
      anchors: [{ blockId: "p", pmFrom: 1, pmTo: 2, quote: "旧", textHash: "hash" }],
    };
    await documentRepo.save(documentInput(docId, { threadId }));
    await insertAnnotationGroups(docId, 1, [oldGroup]);
    setDocumentWriteGuard(null);
    await beginSessionDeletion(threadId);

    await expect(documentDraftRepo.savePending(draftInput))
      .rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(documentDraftRepo.saveCandidate({
      ...draftInput,
      sourceStreamId: "late-stream",
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(upsertDocumentSuggestion(suggestion(docId)))
      .rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(insertAnnotationGroups(docId, 2, [{ ...oldGroup, id: "late-group" }]))
      .rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(replaceAnnotationGroupsByOrigin(docId, 2, [{
      ...oldGroup,
      id: "replacement-group",
    }])).rejects.toBeInstanceOf(DocumentWriteBlockedError);
    await expect(replaceRebasedReview({
      draft: { ...draftInput, batchId: "late-batch" },
      suggestions: [{ ...suggestion(docId), batchId: "late-batch" }],
      previousSuggestions: [],
    })).rejects.toBeInstanceOf(DocumentWriteBlockedError);

    await expect(documentDraftRepo.load(docId)).resolves.toBeNull();
    await expect(listDocumentSuggestionStatuses(docId, 1)).resolves.toEqual([
      { id: "old-group:1", status: "reviewing", conflict: undefined },
    ]);
    const annotationRows = await getDocumentsClient().execute({
      sql: "SELECT group_id, status FROM document_suggestions WHERE doc_id = ? ORDER BY group_id",
      args: [docId],
    });
    expect(annotationRows.rows).toMatchObject([
      { group_id: "old-group", status: "reviewing" },
    ]);
  });

  it("0025 恢复阻断覆盖 draft 标记/删除与 suggestion 忽略/重映射/状态/清理", async () => {
    const docId = "recovery-blocked-review";
    const threadId = "recovery-blocked-review-thread";
    const baseHash = getPmContentHash(pmDocFromText("基线"));
    const annotationGroup = {
      id: "blocked-annotation",
      summary: "批注",
      note: "批注",
      origin: "test",
      status: "reviewing" as const,
      anchors: [{
        blockId: "p",
        pmFrom: 1,
        pmTo: 2,
        quote: "旧",
        textHash: "hash",
      }],
    };
    await documentRepo.save(documentInput(docId, { threadId }));
    await documentDraftRepo.savePending({
      docId,
      threadId,
      baseVersion: 1,
      baseHash,
      draftPmDoc: pmDocFromText("待审草稿"),
    });
    await insertAnnotationGroups(docId, 1, [annotationGroup]);
    await upsertDocumentSuggestion(suggestion(docId));
    await getDocumentsClient().execute({
      sql: `INSERT INTO document_write_blocks (
        doc_id, reason, source_doc_id, source_thread_id, version_id
      ) VALUES (?, 'quarantine_0002_foreign_snapshot', ?, ?, ?)`,
      args: [docId, "source-doc", threadId, "source-version"],
    });
    setDocumentWriteGuard(null);

    const blockedWrites = [
      () => documentDraftRepo.markConflict({
        docId,
        conflict: { kind: "must-not-persist" },
      }),
      () => documentDraftRepo.clear(docId),
      () => ignoreAnnotationGroups(docId),
      () => persistMappedAnnotationGroups(
        docId,
        [annotationGroup],
        new Map([[annotationGroup.id, [0]]]),
      ),
      () => updateDocumentSuggestionStatus(
        docId,
        1,
        `suggestion-${docId}`,
        "accepted",
      ),
      () => ignoreRebasedDocumentSuggestions(
        docId,
        1,
        [`suggestion-${docId}`],
      ),
    ];
    for (const write of blockedWrites) {
      await expect(write()).rejects.toBeInstanceOf(DocumentRecoveryRequiredError);
    }

    await expect(documentDraftRepo.load(docId)).resolves.toMatchObject({
      status: "pending_review",
      conflict: null,
    });
    const rows = await getDocumentsClient().execute({
      sql: `SELECT id, status, anchor_json
        FROM document_suggestions
        WHERE doc_id = ?
        ORDER BY id`,
      args: [docId],
    });
    expect(rows.rows).toMatchObject([
      {
        id: "blocked-annotation:1",
        status: "reviewing",
        anchor_json: JSON.stringify(annotationGroup.anchors[0]),
      },
      {
        id: `suggestion-${docId}`,
        status: "reviewing",
      },
    ]);
  });

  it("F6: guard 通过后延迟 SQL，并发删除完成后迟到 UPSERT 不会复活文档", async () => {
    const sessionId = "atomic-write-fence";
    await documentRepo.save(documentInput(sessionId, { threadId: sessionId }));
    const client = getDocumentsClient();
    const originalExecute = client.execute.bind(client);
    let releaseSql!: () => void;
    let sqlEntered!: () => void;
    const sqlGate = new Promise<void>((resolve) => {
      releaseSql = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      sqlEntered = resolve;
    });
    let shouldDelay = true;
    vi.spyOn(client, "execute").mockImplementation(async (statement) => {
      const sql = String(
        (statement as unknown as { sql?: unknown }).sql ?? statement,
      );
      if (shouldDelay && sql.includes("INSERT INTO documents")) {
        shouldDelay = false;
        sqlEntered();
        await sqlGate;
      }
      return originalExecute(statement);
    });

    const lateWrite = documentRepo.save(documentInput(sessionId, {
      threadId: sessionId,
      docVersion: 2,
      updatedAt: "2026-07-20T00:00:01.000Z",
    }));
    await entered;
    await beginSessionDeletion(sessionId);
    await deleteSessionDocumentsAndAdvance(sessionId);
    releaseSql();
    await lateWrite;

    const result = await originalExecute({
      sql: "SELECT COUNT(*) AS n FROM documents WHERE id = ? OR thread_id = ?",
      args: [sessionId, sessionId],
    });
    expect(Number(result.rows[0]?.n ?? 0)).toBe(0);
  });

  it("F6: 持久化墓碑同时保护 save 与 saveMany", async () => {
    await beginSessionDeletion("fenced-single");
    await beginSessionDeletion("fenced-batch");

    await documentRepo.save(documentInput("fenced-single", {
      threadId: "fenced-single",
    }));
    await documentRepo.saveMany([
      documentInput("fenced-batch", { threadId: "fenced-batch" }),
    ]);

    await expect(documentRepo.load("fenced-single")).resolves.toBeNull();
    await expect(documentRepo.load("fenced-batch")).resolves.toBeNull();
  });
});
