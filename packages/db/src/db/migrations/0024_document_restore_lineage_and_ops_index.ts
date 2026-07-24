import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function up(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS document_version_restore_origins (
      version_id          TEXT    PRIMARY KEY,
      restored_doc_id     TEXT    NOT NULL,
      source_doc_id       TEXT    NOT NULL,
      source_thread_id    TEXT    NOT NULL,
      recovery_migration  INTEGER NOT NULL DEFAULT 23
        CHECK (recovery_migration = 23)
    )
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_document_version_restore_origins_restored
      ON document_version_restore_origins (restored_doc_id, source_doc_id)
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_document_ops_doc_to_version
      ON document_ops (doc_id, to_version)
  `);

  const hasQuarantinedDocuments = await tableExists(
    client,
    "documents_quarantine_0002",
  );
  const hasQuarantinedVersions = await tableExists(
    client,
    "document_versions_quarantine_0002",
  );
  if (!hasQuarantinedDocuments || !hasQuarantinedVersions) return;

  // 0023 旧实现可能把隔离版本改挂到同 thread 的另一篇 main 文档。隔离表仍保留
  // 原 version_id，因此可无猜测地回填“落点文档 ← 隔离源文档”的永久血缘证据。
  await client.execute(`
    INSERT OR IGNORE INTO document_version_restore_origins (
      version_id, restored_doc_id, source_doc_id, source_thread_id, recovery_migration
    )
    SELECT
      restored.version_id,
      restored.doc_id,
      quarantined.doc_id,
      source.thread_id,
      23
    FROM document_versions restored
    INNER JOIN document_versions_quarantine_0002 quarantined
      ON quarantined.version_id = restored.version_id
    INNER JOIN documents_quarantine_0002 source
      ON source.id = quarantined.doc_id
  `);
}

export const migration0024DocumentRestoreLineageAndOpsIndex: Migration = {
  id: 24,
  name: "document_restore_lineage_and_ops_index",
  up,
};
