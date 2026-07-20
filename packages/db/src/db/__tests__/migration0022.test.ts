import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0022DocumentSuggestionBatches } from "../migrations/0022_document_suggestion_batches.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0021-"); });
afterEach(() => db.cleanup());

describe("0022 document suggestion batches", () => {
  it("为老建议与 pending draft 回填 legacy 批次并把 batch_id 纳入复合主键", async () => {
    await runMigrations(MIGRATIONS.slice(0, 20));
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO document_suggestions (
      id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
      summary, created_at, updated_at
    ) VALUES (
      'shared-id', 'doc-a', 7, 'accepted', '{}', '[]', '{}',
      '旧建议', '2026-01-01', '2026-01-02'
    )`);
    await client.execute(`INSERT INTO document_drafts (
      doc_id, thread_id, base_version, base_hash, draft_pm, status,
      created_at, updated_at
    ) VALUES (
      'doc-a', 'thread-a', 7, 'hash', '{"type":"doc","attrs":{"schemaVersion":1},"content":[]}',
      'pending_review', '2026-01-01', '2026-01-02'
    )`);

    await migration0022DocumentSuggestionBatches.up(client);

    const legacySuggestion = await client.execute(
      "SELECT batch_id FROM document_suggestions WHERE doc_id = 'doc-a'",
    );
    const legacyDraft = await client.execute(
      "SELECT batch_id FROM document_drafts WHERE doc_id = 'doc-a'",
    );
    expect(String(legacySuggestion.rows[0]?.batch_id)).toBe("legacy");
    expect(String(legacyDraft.rows[0]?.batch_id)).toBe("legacy");

    const columns = await client.execute("PRAGMA table_info(document_suggestions)");
    const primaryKey = columns.rows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => String(row.name));
    expect(primaryKey).toEqual(["doc_id", "base_version", "batch_id", "id"]);

    await expect(client.execute(`INSERT INTO document_suggestions (
      id, doc_id, base_version, batch_id, status, anchor_json, steps_json,
      preview_json, summary, created_at, updated_at
    ) VALUES (
      'shared-id', 'doc-a', 7, 'next-batch', 'reviewing', '{}', '[]', '{}',
      '新建议', '2026-01-03', '2026-01-03'
    )`)).resolves.toBeDefined();
  });
});
