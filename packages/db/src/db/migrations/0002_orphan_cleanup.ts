import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

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
