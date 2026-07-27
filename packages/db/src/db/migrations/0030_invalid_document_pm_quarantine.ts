import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `CREATE TABLE documents_quarantine_invalid_pm (
      quarantine_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      id                  TEXT    NOT NULL,
      thread_id           TEXT    NOT NULL,
      resource_id         TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      doc_state           TEXT    NOT NULL,
      doc_version         INTEGER NOT NULL,
      last_synced_version INTEGER NOT NULL,
      doc_pm              TEXT,
      doc_schema_version  INTEGER NOT NULL,
      content_hash        TEXT,
      doc_format          TEXT    NOT NULL,
      version             INTEGER NOT NULL,
      created_at          TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL,
      role                TEXT    NOT NULL,
      reason              TEXT    NOT NULL CHECK(reason IN ('missing_pm', 'invalid_pm')),
      quarantined_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await client.execute(
    `CREATE INDEX idx_documents_quarantine_invalid_pm_source
      ON documents_quarantine_invalid_pm(id, quarantined_at DESC)`,
  );
}

export const migration0030InvalidDocumentPmQuarantine: Migration = {
  id: 30,
  name: "invalid_document_pm_quarantine",
  up,
};
