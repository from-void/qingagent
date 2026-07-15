import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function hasRoleColumn(client: Client): Promise<boolean> {
  const result = await client.execute("PRAGMA table_info(documents)");
  return result.rows.some((row) => String(row.name) === "role");
}

async function up(client: Client): Promise<void> {
  if (!(await hasRoleColumn(client))) {
    const statements = [
      `CREATE TABLE documents_new (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', doc_state TEXT NOT NULL,
        doc_version INTEGER NOT NULL DEFAULT 0, last_synced_version INTEGER NOT NULL DEFAULT 0,
        doc_pm TEXT, doc_schema_version INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
        doc_format TEXT NOT NULL DEFAULT 'legacy_sections', version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'main'
      )`,
      `INSERT INTO documents_new (
        id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version,
        doc_pm, doc_schema_version, content_hash, doc_format, version, created_at, updated_at, role
      ) SELECT id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version,
        doc_pm, doc_schema_version, content_hash, doc_format, version, created_at, updated_at, 'main'
        FROM documents`,
      "DROP TABLE documents",
      "ALTER TABLE documents_new RENAME TO documents",
      "CREATE INDEX idx_documents_resource_updated ON documents (resource_id, updated_at DESC)",
      "CREATE INDEX idx_documents_thread ON documents(thread_id)",
      "CREATE UNIQUE INDEX ux_documents_thread_main ON documents(thread_id) WHERE role = 'main'",
    ];
    for (const sql of statements) await client.execute(sql);
  }

  await client.execute(`CREATE TABLE IF NOT EXISTS document_derivatives (
    doc_id TEXT PRIMARY KEY,
    source_doc_id TEXT NOT NULL,
    dtype TEXT NOT NULL,
    template_id TEXT NOT NULL,
    private_prompt TEXT NOT NULL DEFAULT '',
    source_version INTEGER,
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_derivatives_source ON document_derivatives(source_doc_id)",
  );
  // 注意:不建 (source_doc_id, dtype) 唯一索引——数据模型支持一类多实例(翻译按语言多开),
  // 「UI v1 每类限一」是 repo/op 层的产品约束,不焊进 schema。
}

export const migration0006DocumentDerivatives: Migration = {
  id: 6,
  name: "document_derivatives",
  up,
};
