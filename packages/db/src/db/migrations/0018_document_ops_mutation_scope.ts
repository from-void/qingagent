import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE document_ops_new (
      op_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      op_kind TEXT NOT NULL,
      client_mutation_id TEXT,
      steps TEXT,
      from_version INTEGER NOT NULL,
      to_version INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(doc_id, client_mutation_id)
    )`,
    `INSERT INTO document_ops_new (
      op_id, doc_id, op_kind, client_mutation_id, steps,
      from_version, to_version, actor_type, created_at
    ) SELECT
      op_id, doc_id, op_kind, client_mutation_id, steps,
      from_version, to_version, actor_type, created_at
    FROM document_ops`,
    "DROP TABLE document_ops",
    "ALTER TABLE document_ops_new RENAME TO document_ops",
    "CREATE INDEX idx_document_ops_doc ON document_ops(doc_id, created_at DESC)",
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0018DocumentOpsMutationScope: Migration = {
  id: 18,
  name: "document_ops_mutation_scope",
  up,
};
