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
  if (hasNoThreadIntersection || orphanRatio > MAX_SAFE_ORPHAN_RATIO) {
    console.warn(
      "[db:migration:0002] mastra_threads 可能不完整，跳过 documents 孤儿清理。" +
        ` documents=${documentCount}, orphans=${orphanCount}, matched=${matchedCount}, ` +
        `orphanRatio=${orphanRatio.toFixed(3)}, threshold=${MAX_SAFE_ORPHAN_RATIO.toFixed(3)}`,
    );
    return;
  }

  const orphanDocIds = `SELECT id FROM documents
    WHERE thread_id NOT IN (SELECT id FROM mastra_threads)`;

  await client.execute(`DELETE FROM document_drafts WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_suggestions WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_ops WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(`DELETE FROM document_versions WHERE doc_id IN (${orphanDocIds})`);
  await client.execute(
    "DELETE FROM documents WHERE thread_id NOT IN (SELECT id FROM mastra_threads)",
  );
}

export const migration0002OrphanCleanup: Migration = {
  id: 2,
  name: "orphan_cleanup",
  up,
};
