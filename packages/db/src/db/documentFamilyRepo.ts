import type { Client } from "@libsql/client";
import { commitTransaction, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** 在调用方事务内按子表到主表顺序删除指定文档的全部持久化数据。 */
export async function deleteDocumentFamilyByDocIds(
  client: Client,
  docIds: string[],
  options: { draftThreadId?: string } = {},
): Promise<void> {
  const ids = Array.from(new Set(docIds));
  if (ids.length === 0) return;
  const inSql = placeholders(ids.length);
  await client.execute({
    sql: `DELETE FROM document_derivatives WHERE doc_id IN (${inSql}) OR source_doc_id IN (${inSql})`,
    args: [...ids, ...ids],
  });
  await client.execute(options.draftThreadId ? {
    sql: `DELETE FROM document_drafts WHERE doc_id IN (${inSql}) OR thread_id = ?`,
    args: [...ids, options.draftThreadId],
  } : {
    sql: `DELETE FROM document_drafts WHERE doc_id IN (${inSql})`,
    args: ids,
  });
  await client.execute({
    sql: `DELETE FROM review_doc_supplements WHERE doc_id IN (${inSql})`,
    args: ids,
  });
  await client.execute({
    sql: `DELETE FROM document_suggestions WHERE doc_id IN (${inSql})`,
    args: ids,
  });
  await client.execute({
    sql: `DELETE FROM document_ops WHERE doc_id IN (${inSql})`,
    args: ids,
  });
  await client.execute({
    sql: `DELETE FROM document_versions WHERE doc_id IN (${inSql})`,
    args: ids,
  });
  await client.execute({
    sql: `DELETE FROM documents WHERE id IN (${inSql})`,
    args: ids,
  });
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

    await deleteDocumentFamilyByDocIds(txnClient, Array.from(docIds), {
      draftThreadId: sessionId,
    });
    return commitTransaction(undefined);
  });
}
