import { commitTransaction, getDocumentsClient, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * 删除一个会话对应的 documents 全家桶。
 * 先收敛 doc id，再在同一事务内按子表到主表顺序删除，避免半删残留。
 */
export async function deleteDocumentFamily(sessionId: string): Promise<void> {
  await ensureMigrated();
  const client = getDocumentsClient();
  const rows = await client.execute({
    sql: "SELECT id FROM documents WHERE thread_id = ? OR id = ?",
    args: [sessionId, sessionId],
  });
  const docIds = new Set<string>([sessionId]);
  for (const row of rows.rows) {
    if (row.id != null) docIds.add(String(row.id));
  }

  const ids = Array.from(docIds);
  const inSql = placeholders(ids.length);
  await withTransaction(async (txnClient) => {
    await txnClient.execute({
      sql: `DELETE FROM document_drafts WHERE doc_id IN (${inSql}) OR thread_id = ?`,
      args: [...ids, sessionId],
    });
    await txnClient.execute({
      sql: `DELETE FROM document_suggestions WHERE doc_id IN (${inSql})`,
      args: ids,
    });
    await txnClient.execute({
      sql: `DELETE FROM document_ops WHERE doc_id IN (${inSql})`,
      args: ids,
    });
    await txnClient.execute({
      sql: `DELETE FROM document_versions WHERE doc_id IN (${inSql})`,
      args: ids,
    });
    await txnClient.execute({
      sql: `DELETE FROM documents WHERE id IN (${inSql})`,
      args: ids,
    });
    return commitTransaction(undefined);
  });
}
