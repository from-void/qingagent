import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE document_suggestions_new (
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
      severity TEXT CHECK(severity IS NULL OR severity IN ('error','warn','info')),
      PRIMARY KEY (doc_id, base_version, id)
    )`,
    `INSERT INTO document_suggestions_new (
      id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
      summary, conflict_json, kind, note, origin, group_id, group_meta_json,
      created_at, updated_at, severity
    ) SELECT
      id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
      summary, conflict_json, kind, note, origin, group_id, group_meta_json,
      created_at, updated_at, severity
    FROM document_suggestions`,
    "DROP TABLE document_suggestions",
    "ALTER TABLE document_suggestions_new RENAME TO document_suggestions",
    "CREATE INDEX idx_document_suggestions_doc ON document_suggestions(doc_id, updated_at DESC)",
    "CREATE INDEX idx_document_suggestions_annotation_group ON document_suggestions(doc_id, kind, group_id, status)",
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0020DocumentSuggestionIdentityScope: Migration = {
  id: 20,
  name: "document_suggestion_identity_scope",
  up,
};
