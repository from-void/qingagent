import type { Client, Row } from "@libsql/client";
import type { Migration } from "./types.js";

const QUARANTINE_SUFFIX = "_quarantine_0002";

export interface Quarantine0002RecoveryReport {
  eligibleDocuments: number;
  restoredDocuments: number;
  preservedCurrentDocuments: number;
  preservedQuarantinedFamilies: number;
  skippedDocumentConflicts: number;
  restoredDrafts: number;
  restoredSuggestions: number;
  restoredOps: number;
  restoredVersions: number;
}

function emptyReport(): Quarantine0002RecoveryReport {
  return {
    eligibleDocuments: 0,
    restoredDocuments: 0,
    preservedCurrentDocuments: 0,
    preservedQuarantinedFamilies: 0,
    skippedDocumentConflicts: 0,
    restoredDrafts: 0,
    restoredSuggestions: 0,
    restoredOps: 0,
    restoredVersions: 0,
  };
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function migration0002WasApplied(client: Client): Promise<boolean> {
  if (!(await tableExists(client, "schema_migrations"))) return false;
  const result = await client.execute(
    "SELECT 1 FROM schema_migrations WHERE id = 2 LIMIT 1",
  );
  return result.rows.length > 0;
}

function value(row: Row, column: string): string | number | null {
  const raw = row[column];
  if (raw == null) return null;
  return typeof raw === "bigint" ? Number(raw) : raw as string | number;
}

async function currentMainDocumentId(client: Client, threadId: string): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT id FROM documents
      WHERE thread_id = ? AND role = 'main'
      ORDER BY updated_at DESC, id
      LIMIT 1`,
    args: [threadId],
  });
  return result.rows[0]?.id == null ? null : String(result.rows[0].id);
}

async function restoreDocument(
  client: Client,
  row: Row,
  report: Quarantine0002RecoveryReport,
): Promise<{ targetDocId: string; restoreChildren: boolean } | null> {
  const sourceDocId = String(row.id);
  const threadId = String(row.thread_id);
  const existingId = await currentMainDocumentId(client, threadId);
  if (existingId) {
    report.preservedCurrentDocuments += 1;
    const restoreChildren = existingId === sourceDocId;
    if (!restoreChildren) report.preservedQuarantinedFamilies += 1;
    return { targetDocId: existingId, restoreChildren };
  }

  const result = await client.execute({
    sql: `INSERT INTO documents (
      id, thread_id, resource_id, title, doc_state, doc_version,
      last_synced_version, doc_pm, doc_schema_version, content_hash,
      doc_format, version, created_at, updated_at, role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'main')
    ON CONFLICT DO NOTHING`,
    args: [
      value(row, "id"),
      value(row, "thread_id"),
      value(row, "resource_id"),
      value(row, "title"),
      value(row, "doc_state"),
      value(row, "doc_version"),
      value(row, "last_synced_version"),
      value(row, "doc_pm"),
      value(row, "doc_schema_version"),
      value(row, "content_hash"),
      value(row, "doc_format"),
      value(row, "version"),
      value(row, "created_at"),
      value(row, "updated_at"),
    ],
  });
  report.restoredDocuments += result.rowsAffected;
  const restoredId = await currentMainDocumentId(client, threadId);
  if (!restoredId) report.skippedDocumentConflicts += 1;
  return restoredId
    ? { targetDocId: restoredId, restoreChildren: restoredId === sourceDocId }
    : null;
}

async function restoreDraft(
  client: Client,
  sourceDocId: string,
  targetDocId: string,
  threadId: string,
): Promise<number> {
  if (!(await tableExists(client, `document_drafts${QUARANTINE_SUFFIX}`))) return 0;
  const rows = await client.execute({
    sql: `SELECT * FROM document_drafts${QUARANTINE_SUFFIX} WHERE doc_id = ?`,
    args: [sourceDocId],
  });
  let restored = 0;
  for (const row of rows.rows) {
    const result = await client.execute({
      sql: `INSERT INTO document_drafts (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy')
      ON CONFLICT(doc_id) DO NOTHING`,
      args: [
        targetDocId,
        threadId,
        value(row, "base_version"),
        value(row, "base_hash"),
        value(row, "draft_pm"),
        value(row, "status"),
        value(row, "conflict_json"),
        value(row, "review_batch_id"),
        value(row, "group_mode"),
        value(row, "source_stream_id"),
        value(row, "source_tool_call_id"),
        value(row, "created_at"),
        value(row, "updated_at"),
      ],
    });
    restored += result.rowsAffected;
  }
  return restored;
}

async function restoreSuggestions(
  client: Client,
  sourceDocId: string,
  targetDocId: string,
): Promise<number> {
  if (!(await tableExists(client, `document_suggestions${QUARANTINE_SUFFIX}`))) return 0;
  const rows = await client.execute({
    sql: `SELECT * FROM document_suggestions${QUARANTINE_SUFFIX} WHERE doc_id = ?`,
    args: [sourceDocId],
  });
  let restored = 0;
  for (const row of rows.rows) {
    const result = await client.execute({
      sql: `INSERT INTO document_suggestions (
        id, doc_id, base_version, batch_id, status, anchor_json, steps_json,
        preview_json, summary, conflict_json, kind, note, origin, group_id,
        group_meta_json, created_at, updated_at, severity
      ) VALUES (?, ?, ?, 'legacy', ?, ?, ?, ?, ?, ?, 'revision', NULL, NULL,
        NULL, NULL, ?, ?, NULL)
      ON CONFLICT(doc_id, base_version, batch_id, id) DO NOTHING`,
      args: [
        value(row, "id"),
        targetDocId,
        value(row, "base_version"),
        value(row, "status"),
        value(row, "anchor_json"),
        value(row, "steps_json"),
        value(row, "preview_json"),
        value(row, "summary"),
        value(row, "conflict_json"),
        value(row, "created_at"),
        value(row, "updated_at"),
      ],
    });
    restored += result.rowsAffected;
  }
  return restored;
}

async function restoreOps(
  client: Client,
  sourceDocId: string,
  targetDocId: string,
): Promise<number> {
  if (!(await tableExists(client, `document_ops${QUARANTINE_SUFFIX}`))) return 0;
  const rows = await client.execute({
    sql: `SELECT * FROM document_ops${QUARANTINE_SUFFIX} WHERE doc_id = ?`,
    args: [sourceDocId],
  });
  let restored = 0;
  for (const row of rows.rows) {
    const result = await client.execute({
      sql: `INSERT INTO document_ops (
        op_id, doc_id, op_kind, client_mutation_id, steps,
        from_version, to_version, actor_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
      args: [
        value(row, "op_id"),
        targetDocId,
        value(row, "op_kind"),
        value(row, "client_mutation_id"),
        value(row, "steps"),
        value(row, "from_version"),
        value(row, "to_version"),
        value(row, "actor_type"),
        value(row, "created_at"),
      ],
    });
    restored += result.rowsAffected;
  }
  return restored;
}

async function restoreVersions(
  client: Client,
  sourceDocId: string,
  targetDocId: string,
): Promise<number> {
  if (!(await tableExists(client, `document_versions${QUARANTINE_SUFFIX}`))) return 0;
  const rows = await client.execute({
    sql: `SELECT * FROM document_versions${QUARANTINE_SUFFIX} WHERE doc_id = ?`,
    args: [sourceDocId],
  });
  let restored = 0;
  for (const row of rows.rows) {
    const result = await client.execute({
      sql: `INSERT INTO document_versions (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
      args: [
        value(row, "version_id"),
        targetDocId,
        value(row, "doc_version"),
        value(row, "content_hash"),
        value(row, "schema_version"),
        value(row, "actor_type"),
        value(row, "summary"),
        value(row, "snapshot_pm"),
        value(row, "parent_version"),
        value(row, "created_at"),
      ],
    });
    restored += result.rowsAffected;
  }
  return restored;
}

/**
 * 将 0002 旧形态隔离表显式映射到当前 schema。当前 main 行优先；仅当当前
 * main docId 与隔离源 docId 相同时才恢复子表。不同 docId 即不同历史家族，
 * 隔离 versions / ops / drafts / suggestions 原样留在隔离表等待人工判断。
 */
export async function restoreQuarantinedDocumentFamilies0002(
  client: Client,
): Promise<Quarantine0002RecoveryReport> {
  const report = emptyReport();
  if (!(await migration0002WasApplied(client))) return report;
  if (!(await tableExists(client, "mastra_threads"))) return report;
  if (!(await tableExists(client, `documents${QUARANTINE_SUFFIX}`))) return report;

  const eligible = await client.execute(
    `SELECT q.*
      FROM documents${QUARANTINE_SUFFIX} q
      INNER JOIN mastra_threads t ON t.id = q.thread_id
      WHERE NOT EXISTS (
        SELECT 1 FROM deleted_sessions d
        WHERE d.session_id IN (q.id, q.thread_id)
      )
      ORDER BY q.thread_id, q.id`,
  );
  report.eligibleDocuments = eligible.rows.length;

  for (const row of eligible.rows) {
    const sourceDocId = String(row.id);
    const threadId = String(row.thread_id);
    const target = await restoreDocument(client, row, report);
    if (!target || !target.restoreChildren) continue;
    const { targetDocId } = target;
    report.restoredDrafts += await restoreDraft(client, sourceDocId, targetDocId, threadId);
    report.restoredSuggestions += await restoreSuggestions(client, sourceDocId, targetDocId);
    report.restoredOps += await restoreOps(client, sourceDocId, targetDocId);
    report.restoredVersions += await restoreVersions(client, sourceDocId, targetDocId);
  }

  return report;
}

async function up(client: Client): Promise<void> {
  const report = await restoreQuarantinedDocumentFamilies0002(client);
  if (report.eligibleDocuments > 0) {
    console.warn("[db:migration:0023] 已检查并恢复 0002 隔离文档家族", report);
  }
}

export const migration0023RestoreQuarantine0002: Migration = {
  id: 23,
  name: "restore_quarantine_0002",
  up,
};
