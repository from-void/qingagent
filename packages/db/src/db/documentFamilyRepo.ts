import { commitTransaction, withTransaction } from "./documentsClient.js";
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
  await withTransaction(async (txnClient) => {
    // 与提交事务共用同一串行事务边界，不能在事务外读取到过期 doc id 集合。
    const rows = await txnClient.execute({
      sql: "SELECT id FROM documents WHERE thread_id = ? OR id = ?",
      args: [sessionId, sessionId],
    });
    const docIds = new Set<string>([sessionId]);
    for (const row of rows.rows) {
      if (row.id != null) docIds.add(String(row.id));
    }

    const ids = Array.from(docIds);
    const inSql = placeholders(ids.length);
    await txnClient.execute({
      sql: `DELETE FROM document_derivatives WHERE doc_id IN (${inSql}) OR source_doc_id IN (${inSql})`,
      args: [...ids, ...ids],
    });
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
