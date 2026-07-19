import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { migration0020DocumentSuggestionIdentityScope } from "../migrations/0020_document_suggestion_identity_scope.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0020-"); });
afterEach(() => db.cleanup());

describe("0020 document suggestion identity scope", () => {
  it("迁移后保留不同文档中相同 id 的存量行并建立复合主键", async () => {
    const client = getDocumentsClient();
    await client.execute(`CREATE TABLE document_suggestions (
      id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reviewing','accepted','rejected','committed','conflict','ignored')),
      anchor_json TEXT NOT NULL,
      steps_json TEXT,
      preview_json TEXT,
      summary TEXT NOT NULL DEFAULT '',
      conflict_json TEXT,
      kind TEXT NOT NULL DEFAULT 'revision' CHECK(kind IN ('revision','annotation')),
      note TEXT,
      origin TEXT,
      group_id TEXT,
      group_meta_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      severity TEXT CHECK(severity IS NULL OR severity IN ('error','warn','info'))
    )`);
    await client.execute(`INSERT INTO document_suggestions (
      id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
      summary, created_at, updated_at
    ) VALUES
      ('shared-id', 'doc-a', 7, 'accepted', '{}', '[]', '{}', '甲', '2026-01-01', '2026-01-02'),
      ('shared-id', 'doc-b', 7, 'rejected', '{}', '[]', '{}', '乙', '2026-01-03', '2026-01-04')`);

    await migration0020DocumentSuggestionIdentityScope.up(client);

    const rows = await client.execute(
      "SELECT id, doc_id, base_version, status, summary FROM document_suggestions ORDER BY doc_id",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: "shared-id", doc_id: "doc-a", base_version: 7, status: "accepted", summary: "甲" }),
      expect.objectContaining({ id: "shared-id", doc_id: "doc-b", base_version: 7, status: "rejected", summary: "乙" }),
    ]);

    const columns = await client.execute("PRAGMA table_info(document_suggestions)");
    const primaryKey = columns.rows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => String(row.name));
    expect(primaryKey).toEqual(["doc_id", "base_version", "id"]);
  });
});
