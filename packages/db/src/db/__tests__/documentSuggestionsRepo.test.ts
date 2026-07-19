import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocSuggestion, PatchConflict } from "@qingagent/contract-ts";
import {
  listDocumentSuggestionStatuses,
  updateDocumentSuggestionStatus,
  upsertDocumentSuggestion,
} from "../documentSuggestionsRepo.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

function suggestion(id: string, docId: string, baseVersion: number): DocSuggestion {
  return {
    id,
    docId,
    baseVersion,
    baseSchemaVersion: 1,
    status: "reviewing",
    anchor: { blockId: "block-a", pmFrom: 1, pmTo: 2, quote: "旧", textHash: "hash" },
    patch: { kind: "prosemirror_steps", steps: [] },
    preview: { deleteText: "旧", insertText: "新" },
    summary: "替换文本",
  };
}

describe("document suggestion status query", () => {
  let db: TempDocumentsDb;

  beforeEach(() => { db = prepareTempDocumentsDb("qa-document-suggestion-status-"); });
  afterEach(() => db.cleanup());

  it("按 docId、baseVersion 和 suggestionIds 返回状态与冲突原因", async () => {
    await upsertDocumentSuggestion(suggestion("s-accepted", "doc-a", 3));
    await upsertDocumentSuggestion(suggestion("s-conflict", "doc-a", 3));
    await upsertDocumentSuggestion(suggestion("s-other-version", "doc-a", 4));
    await upsertDocumentSuggestion(suggestion("s-other-doc", "doc-b", 3));
    await updateDocumentSuggestionStatus("s-accepted", "accepted");
    const conflict: PatchConflict = {
      kind: "version_conflict",
      message: "目标位置已变化",
      suggestionId: "s-conflict",
    };
    await updateDocumentSuggestionStatus("s-conflict", "conflict", conflict);

    const rows = await listDocumentSuggestionStatuses("doc-a", 3, ["s-accepted", "s-conflict", "s-other-version"]);

    expect(rows).toEqual(expect.arrayContaining([
      { id: "s-accepted", status: "accepted", conflict: undefined },
      { id: "s-conflict", status: "conflict", conflict },
    ]));
    expect(rows).toHaveLength(2);
    await expect(listDocumentSuggestionStatuses("doc-a", 3, [])).resolves.toEqual([]);
  });
});
