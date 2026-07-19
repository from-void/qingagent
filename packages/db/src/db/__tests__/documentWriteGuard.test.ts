import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocSuggestion } from "@qingagent/contract-ts";
import { getPmContentHash } from "@qingagent/pm-schema";
import { documentDraftRepo } from "../documentDraftRepo.js";
import { documentRepo } from "../documentRepo.js";
import {
  listDocumentSuggestionStatuses,
  upsertDocumentSuggestion,
} from "../documentSuggestionsRepo.js";
import {
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
});
