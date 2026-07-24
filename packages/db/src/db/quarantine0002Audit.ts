import { getDocumentsClient } from "./documentsClient.js";

export interface Quarantine0002OverwriteCandidate {
  currentDocId: string;
  currentThreadId: string;
  sourceDocId: string;
  sourceThreadId: string;
  versionId: string;
  docVersion: number;
  confidence: "exact_snapshot" | "matching_hash" | "persisted_block";
  currentUpdatedAt: string;
}

/**
 * 只读识别 0023 旧实现可能造成的当前正文覆盖。
 *
 * 首次识别报告同时满足以下证据的行：
 * 1. 版本可由 0024 血缘账本追溯到另一 source docId；
 * 2. 当前 documents 指针正落在该隔离版本；
 * 3. 当前 doc_pm 与隔离快照完全一致，或 content_hash 一致。
 * 0025 持久化阻断后，即使 PM 兼容规整改变了表示，也继续报告到人工解除为止。
 */
export async function identifyQuarantine0002OverwriteCandidates(): Promise<
  Quarantine0002OverwriteCandidate[]
> {
  const client = getDocumentsClient();
  const lineageTable = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_version_restore_origins'
    LIMIT 1
  `);
  if (lineageTable.rows.length === 0) {
    throw new Error(
      "缺少 0024 恢复血缘表；请先通过应用启动流程完成迁移，再运行只读识别。",
    );
  }

  const activeResult = await client.execute(`
    SELECT
      d.id AS current_doc_id,
      d.thread_id AS current_thread_id,
      origin.source_doc_id,
      origin.source_thread_id,
      version.version_id,
      version.doc_version,
      d.updated_at AS current_updated_at,
      CASE
        WHEN d.doc_pm = version.snapshot_pm THEN 'exact_snapshot'
        ELSE 'matching_hash'
      END AS confidence
    FROM document_version_restore_origins origin
    INNER JOIN documents d
      ON d.id = origin.restored_doc_id
    INNER JOIN document_versions version
      ON version.version_id = origin.version_id
      AND version.doc_id = d.id
    WHERE origin.source_doc_id <> d.id
      AND d.doc_version = version.doc_version
      AND (
        d.doc_pm = version.snapshot_pm
        OR (
          d.content_hash IS NOT NULL
          AND d.content_hash = version.content_hash
        )
      )
    ORDER BY d.thread_id, d.id, version.doc_version DESC
  `);

  const rows = [...activeResult.rows];
  const quarantine0025Table = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_versions_quarantine_0025'
    LIMIT 1
  `);
  const writeBlocksTable = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_write_blocks'
    LIMIT 1
  `);
  if (
    quarantine0025Table.rows.length > 0
    && writeBlocksTable.rows.length > 0
  ) {
    const isolatedResult = await client.execute(`
      SELECT
        d.id AS current_doc_id,
        d.thread_id AS current_thread_id,
        block.source_doc_id,
        block.source_thread_id,
        version.version_id,
        version.doc_version,
        d.updated_at AS current_updated_at,
        CASE
          WHEN d.doc_pm = version.snapshot_pm THEN 'exact_snapshot'
          WHEN d.content_hash IS NOT NULL
            AND d.content_hash = version.content_hash THEN 'matching_hash'
          ELSE 'persisted_block'
        END AS confidence
      FROM document_write_blocks block
      INNER JOIN documents d ON d.id = block.doc_id
      INNER JOIN document_versions_quarantine_0025 version
        ON version.version_id = block.version_id
      WHERE block.reason = 'quarantine_0002_foreign_snapshot'
      ORDER BY d.thread_id, d.id, version.doc_version DESC
    `);
    rows.push(...isolatedResult.rows);
  }

  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    unique.set(
      `${String(row.current_doc_id)}:${String(row.version_id)}`,
      row,
    );
  }
  return [...unique.values()].map((row) => ({
    currentDocId: String(row.current_doc_id),
    currentThreadId: String(row.current_thread_id),
    sourceDocId: String(row.source_doc_id),
    sourceThreadId: String(row.source_thread_id),
    versionId: String(row.version_id),
    docVersion: Number(row.doc_version),
    confidence: String(row.confidence) as Quarantine0002OverwriteCandidate["confidence"],
    currentUpdatedAt: String(row.current_updated_at),
  }));
}
