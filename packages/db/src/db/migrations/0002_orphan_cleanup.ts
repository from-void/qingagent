import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

const MAX_SAFE_ORPHAN_RATIO = 0.2;

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const res = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return res.rows.length > 0;
}

async function up(client: Client): Promise<void> {
  const hasMastraThreads = await tableExists(client, "mastra_threads");
  if (!hasMastraThreads) return;

  const threadCountResult = await client.execute(
    "SELECT COUNT(*) AS count FROM mastra_threads",
  );
  const threadCount = Number(threadCountResult.rows[0]?.count ?? 0);
  if (threadCount === 0) {
    // 项目尚未开源且装机面可控，允许原地修补已发布迁移；数据防呆优先于迁移不可变惯例。
    // 本次继续沿用该例外，将可能的孤儿全家桶移入可恢复隔离表，禁止不可逆删除。
    console.warn(
      "[db:migration:0002] mastra_threads 为空，跳过 documents 孤儿清理以避免误删全部文档。",
    );
    return;
  }

  const documentStatsResult = await client.execute(`
    SELECT
      COUNT(*) AS document_count,
      SUM(CASE WHEN t.id IS NULL THEN 1 ELSE 0 END) AS orphan_count,
      SUM(CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END) AS matched_count
    FROM documents d
    LEFT JOIN mastra_threads t ON t.id = d.thread_id
  `);
  const documentCount = Number(documentStatsResult.rows[0]?.document_count ?? 0);
  const orphanCount = Number(documentStatsResult.rows[0]?.orphan_count ?? 0);
  const matchedCount = Number(documentStatsResult.rows[0]?.matched_count ?? 0);
  if (documentCount === 0 || orphanCount === 0) return;

  const orphanRatio = orphanCount / documentCount;
  const hasNoThreadIntersection = matchedCount === 0;
  if (hasNoThreadIntersection) {
    console.warn(
      "[db:migration:0002] mastra_threads 可能不完整，跳过 documents 孤儿清理。" +
        ` documents=${documentCount}, orphans=${orphanCount}, matched=${matchedCount}, ` +
        `orphanRatio=${orphanRatio.toFixed(3)}, threshold=${MAX_SAFE_ORPHAN_RATIO.toFixed(3)}`,
    );
    return;
  }

  const orphanDocIds = `SELECT id FROM documents
    WHERE thread_id NOT IN (SELECT id FROM mastra_threads)`;

  const quarantineTables = [
    "documents",
    "document_drafts",
    "document_suggestions",
    "document_ops",
    "document_versions",
  ];
  for (const table of quarantineTables) {
    await client.execute(
      `CREATE TABLE IF NOT EXISTS ${table}_quarantine_0002 AS SELECT * FROM ${table} WHERE 0`,
    );
  }

  await client.execute(
    `INSERT INTO documents_quarantine_0002 SELECT * FROM documents WHERE id IN (${orphanDocIds})`,
  );
  await client.execute(
    `INSERT INTO document_drafts_quarantine_0002 SELECT * FROM document_drafts WHERE doc_id IN (${orphanDocIds})`,
  );
  await client.execute(
    `INSERT INTO document_suggestions_quarantine_0002 SELECT * FROM document_suggestions WHERE doc_id IN (${orphanDocIds})`,
  );
  await client.execute(
    `INSERT INTO document_ops_quarantine_0002 SELECT * FROM document_ops WHERE doc_id IN (${orphanDocIds})`,
  );
  await client.execute(
    `INSERT INTO document_versions_quarantine_0002 SELECT * FROM document_versions WHERE doc_id IN (${orphanDocIds})`,
  );

  await client.execute(`DELETE FROM document_drafts WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_suggestions WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_ops WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_versions WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(
    "DELETE FROM documents WHERE thread_id NOT IN (SELECT id FROM mastra_threads)",
  );

  const riskLevel = orphanRatio > MAX_SAFE_ORPHAN_RATIO ? "高比例，线程表可能不完整" : "低比例";
  console.warn(
    `[db:migration:0002] 已隔离 ${orphanCount} 个 documents 孤儿全家桶（${riskLevel}）。` +
      ` documents=${documentCount}, matched=${matchedCount}, orphanRatio=${orphanRatio.toFixed(3)}, ` +
      `threshold=${MAX_SAFE_ORPHAN_RATIO.toFixed(3)}；如需恢复，请从 *_quarantine_0002 表按原主键回写。`,
  );
}

export const migration0002OrphanCleanup: Migration = {
  id: 2,
  name: "orphan_cleanup",
  up,
};
