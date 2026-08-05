import {
  getPmContentHash,
  getStablePmJson,
  repairLegacyStableJsonUndefined,
  safeParsePmDoc,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { Row } from "@libsql/client";
import type { Migration } from "./types.js";

interface RecoveredPm {
  doc: PmDoc;
  json: string;
  hash: string;
}

function recoverPm(raw: unknown): RecoveredPm | null {
  if (typeof raw !== "string") return null;
  const repaired = repairLegacyStableJsonUndefined(raw);
  if (repaired === null) return null;
  const parsed = safeParsePmDoc(repaired);
  if (!parsed.success) return null;
  const doc = parsed.data as PmDoc;
  return {
    doc,
    json: getStablePmJson(doc),
    hash: getPmContentHash(doc),
  };
}

async function repairLiveRows(
  client: Parameters<Migration["up"]>[0],
): Promise<void> {
  const result = await client.execute(`SELECT id,version,doc_pm
    FROM documents
    WHERE doc_pm IS NOT NULL
      AND trim(doc_pm) <> ''
      AND NOT json_valid(doc_pm)`);
  for (const row of result.rows) {
    const recovered = recoverPm(row.doc_pm);
    if (!recovered) continue;
    await client.execute({
      sql: `UPDATE documents SET
          doc_pm=?,doc_schema_version=?,content_hash=?,doc_format='pm'
        WHERE id=? AND version=? AND doc_pm IS ?`,
      args: [
        recovered.json,
        recovered.doc.attrs.schemaVersion,
        recovered.hash,
        String(row.id),
        Number(row.version),
        String(row.doc_pm),
      ],
    });
  }
}

async function eligibleQuarantineRows(
  client: Parameters<Migration["up"]>[0],
): Promise<Row[]> {
  const mastraThreads = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mastra_threads' LIMIT 1",
  );
  if (mastraThreads.rows.length === 0) return [];
  const result = await client.execute(`SELECT q.*
    FROM documents_quarantine_invalid_pm q
    INNER JOIN mastra_threads t ON t.id=q.thread_id
    WHERE q.reason='invalid_pm'
      AND NOT EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id=q.id OR d.thread_id=q.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM deleted_sessions deleted
        WHERE deleted.session_id IN (q.id,q.thread_id)
      )
    ORDER BY q.id,q.doc_version DESC,q.version DESC,q.quarantine_id DESC`);
  return result.rows;
}

async function restoreQuarantineRows(
  client: Parameters<Migration["up"]>[0],
): Promise<void> {
  const restoredDocumentIds = new Set<string>();
  for (const row of await eligibleQuarantineRows(client)) {
    const id = String(row.id);
    if (restoredDocumentIds.has(id)) continue;
    const recovered = recoverPm(row.doc_pm);
    if (!recovered) continue;
    // 迁移只执行一次；原隔离行保留作审计证据。OR IGNORE 防御同一批隔离数据里
    // 异常的 id/thread 唯一键冲突，绝不覆盖已经存在的用户文档。
    await client.execute({
      sql: `INSERT OR IGNORE INTO documents (
          id,thread_id,resource_id,title,doc_state,doc_version,
          last_synced_version,doc_pm,doc_schema_version,content_hash,
          doc_format,version,created_at,updated_at,role
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        String(row.thread_id),
        String(row.resource_id),
        String(row.title),
        String(row.doc_state),
        Number(row.doc_version),
        Number(row.last_synced_version),
        recovered.json,
        recovered.doc.attrs.schemaVersion,
        recovered.hash,
        "pm",
        Number(row.version),
        String(row.created_at),
        String(row.updated_at),
        String(row.role),
      ],
    });
    restoredDocumentIds.add(id);
  }
}

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await repairLiveRows(client);
  await restoreQuarantineRows(client);
}

export const migration0037RepairStableStringifyUndefined: Migration = {
  id: 37,
  name: "repair_stable_stringify_undefined",
  up,
};
