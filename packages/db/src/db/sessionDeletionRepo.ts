import type { Client } from "@libsql/client";
import { commitTransaction, getDocumentsClient, withTransaction, withWriteRetry } from "./documentsClient.js";
import { deleteDocumentFamilyByDocIds } from "./documentFamilyRepo.js";
import { ensureMigrated } from "./migrations.js";

export type SessionDeletionPhase =
  | "draining"
  | "documents_deleted"
  | "threads_deleted"
  | "database_deleted"
  | "assets_deleted"
  | "completed";

export interface SessionDataReference {
  table: string;
  column: string;
  count: number;
}

const DELETION_LEDGER_TABLE = "deleted_sessions";
const RESOURCE_MANIFEST_TABLE = "session_resources";
const SESSION_COLUMN_RE = /(session|thread|resource)/i;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function sessionReferenceColumns(
  client: Client,
): Promise<Array<{ table: string; columns: string[] }>> {
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const result: Array<{ table: string; columns: string[] }> = [];
  for (const row of tables.rows) {
    const table = String(row.name);
    if (table === DELETION_LEDGER_TABLE) continue;
    const info = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
    const columns = info.rows
      .map((column) => String(column.name))
      .filter((column) => SESSION_COLUMN_RE.test(column));
    // Mastra 的 thread 主键名为普通 id；该表因 resourceId 入选后必须同时检查 id，
    // 否则“空壳线程无 message”会逃过结构穷举。
    if (table === "mastra_threads" && info.rows.some((column) => column.name === "id")) {
      columns.push("id");
    }
    if (columns.length > 0) result.push({ table, columns: [...new Set(columns)] });
  }
  return result;
}

function normalizedReferenceIds(sessionId: string, relatedIds: readonly string[]): string[] {
  return [...new Set([sessionId, ...relatedIds].filter((id) => typeof id === "string" && id))];
}

async function findSessionDataReferencesWithClient(
  client: Client,
  sessionId: string,
  relatedIds: readonly string[],
): Promise<SessionDataReference[]> {
  const ids = normalizedReferenceIds(sessionId, relatedIds);
  const placeholders = ids.map(() => "?").join(", ");
  const hits: SessionDataReference[] = [];
  for (const target of await sessionReferenceColumns(client)) {
    for (const column of target.columns) {
      const result = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM ${quoteIdentifier(target.table)}
          WHERE ${quoteIdentifier(column)} IN (${placeholders})`,
        args: ids,
      });
      const count = Number(result.rows[0]?.n ?? 0);
      if (count > 0) hits.push({ table: target.table, column, count });
    }
  }
  return hits.sort((left, right) =>
    left.table.localeCompare(right.table) || left.column.localeCompare(right.column));
}

export interface SessionDeletionRecord {
  sessionId: string;
  phase: SessionDeletionPhase;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function mapRecord(row: Record<string, unknown>): SessionDeletionRecord {
  return {
    sessionId: String(row.session_id),
    phase: String(row.phase) as SessionDeletionPhase,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

export async function beginSessionDeletion(sessionId: string): Promise<SessionDeletionRecord> {
  await ensureMigrated();
  const client = getDocumentsClient();
  const now = new Date().toISOString();
  await withWriteRetry(async () => {
    await client.execute({
      sql: `INSERT INTO deleted_sessions (
          session_id, phase, created_at, updated_at, completed_at
        ) VALUES (?, 'draining', ?, ?, NULL)
        ON CONFLICT(session_id) DO NOTHING`,
      args: [sessionId, now, now],
    });
  });
  const record = await getSessionDeletion(sessionId);
  if (!record) throw new Error(`Failed to persist deletion tombstone: ${sessionId}`);
  return record;
}

export async function getSessionDeletion(
  sessionId: string,
): Promise<SessionDeletionRecord | null> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute({
    sql: `SELECT session_id, phase, created_at, updated_at, completed_at
      FROM deleted_sessions WHERE session_id = ?`,
    args: [sessionId],
  });
  const row = result.rows[0];
  return row ? mapRecord(row) : null;
}

export async function listSessionDeletions(): Promise<SessionDeletionRecord[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute(
    `SELECT session_id, phase, created_at, updated_at, completed_at
      FROM deleted_sessions
      WHERE phase != 'completed'
      ORDER BY created_at, session_id`,
  );
  return result.rows.map(mapRecord);
}

export async function getTombstonedSessionIds(
  sessionIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  await ensureMigrated();
  const placeholders = ids.map(() => "?").join(", ");
  const result = await getDocumentsClient().execute({
    sql: `SELECT session_id FROM deleted_sessions
      WHERE session_id IN (${placeholders})`,
    args: ids,
  });
  return new Set(result.rows.map((row) => String(row.session_id)));
}

/**
 * 在同一写事务内删除 documents 全家桶并推进阶段，避免进程崩溃留下
 * “数据已删但墓碑仍声称尚未产生副作用”的不可恢复中间态。
 */
export async function deleteSessionDocumentsAndAdvance(
  sessionId: string,
): Promise<SessionDeletionPhase> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const now = new Date().toISOString();
    const existing = await client.execute({
      sql: "SELECT phase FROM deleted_sessions WHERE session_id = ?",
      args: [sessionId],
    });
    let phase = existing.rows[0]?.phase == null
      ? null
      : String(existing.rows[0].phase) as SessionDeletionPhase;
    if (phase == null) {
      await client.execute({
        sql: `INSERT INTO deleted_sessions (
            session_id, phase, created_at, updated_at, completed_at
          ) VALUES (?, 'draining', ?, ?, NULL)`,
        args: [sessionId, now, now],
      });
      phase = "draining";
    }
    if (phase !== "draining") return commitTransaction(phase);

    const rows = await client.execute({
      sql: "SELECT id FROM documents WHERE thread_id = ? OR id = ?",
      args: [sessionId, sessionId],
    });
    const docIds = new Set<string>([sessionId]);
    for (const row of rows.rows) {
      if (row.id != null) docIds.add(String(row.id));
    }
    await deleteDocumentFamilyByDocIds(client, [...docIds], {
      draftThreadId: sessionId,
    });
    await client.execute({
      sql: `UPDATE deleted_sessions
        SET phase = 'documents_deleted', updated_at = ?
        WHERE session_id = ? AND phase = 'draining'`,
      args: [now, sessionId],
    });
    return commitTransaction("documents_deleted" as const);
  });
}

export async function markSessionThreadsDeleted(
  sessionId: string,
): Promise<SessionDeletionPhase> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const now = new Date().toISOString();
    const existing = await client.execute({
      sql: "SELECT phase FROM deleted_sessions WHERE session_id = ?",
      args: [sessionId],
    });
    const phase = existing.rows[0]?.phase == null
      ? null
      : String(existing.rows[0].phase) as SessionDeletionPhase;
    if (phase === null || phase === "draining") {
      throw new Error(`Cannot mark threads deleted before documents commit: ${sessionId}`);
    }
    if (phase !== "documents_deleted") return commitTransaction(phase);
    await client.execute({
      sql: `UPDATE deleted_sessions SET phase = 'threads_deleted', updated_at = ?
        WHERE session_id = ? AND phase = 'documents_deleted'`,
      args: [now, sessionId],
    });
    return commitTransaction("threads_deleted" as const);
  });
}

/**
 * 长期完备清单：运行时枚举所有含 session/thread/resource 列的表，并清除与本会话
 * 或已知影子线程 id 精确相等的行。资源清单延后到物理文件成功释放后再删。
 */
export async function deleteSessionDatabaseRowsAndAdvance(
  sessionId: string,
  relatedIds: readonly string[] = [],
): Promise<SessionDeletionPhase> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: "SELECT phase FROM deleted_sessions WHERE session_id = ?",
      args: [sessionId],
    });
    const phase = existing.rows[0]?.phase == null
      ? null
      : String(existing.rows[0].phase) as SessionDeletionPhase;
    if (phase === null || phase === "draining" || phase === "documents_deleted") {
      throw new Error(`Cannot delete ancillary session data before threads commit: ${sessionId}`);
    }
    if (phase !== "threads_deleted") return commitTransaction(phase);

    const ids = normalizedReferenceIds(sessionId, relatedIds);
    const placeholders = ids.map(() => "?").join(", ");
    for (const target of await sessionReferenceColumns(client)) {
      if (target.table === RESOURCE_MANIFEST_TABLE) continue;
      const predicates = target.columns
        .map((column) => `${quoteIdentifier(column)} IN (${placeholders})`)
        .join(" OR ");
      await client.execute({
        sql: `DELETE FROM ${quoteIdentifier(target.table)} WHERE ${predicates}`,
        args: target.columns.flatMap(() => ids),
      });
    }

    const now = new Date().toISOString();
    await client.execute({
      sql: `UPDATE deleted_sessions SET phase = 'database_deleted', updated_at = ?
        WHERE session_id = ? AND phase = 'threads_deleted'`,
      args: [now, sessionId],
    });
    return commitTransaction("database_deleted" as const);
  });
}

export async function markSessionAssetsDeleted(
  sessionId: string,
): Promise<SessionDeletionPhase> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const existing = await client.execute({
      sql: "SELECT phase FROM deleted_sessions WHERE session_id = ?",
      args: [sessionId],
    });
    const phase = existing.rows[0]?.phase == null
      ? null
      : String(existing.rows[0].phase) as SessionDeletionPhase;
    if (
      phase === null ||
      phase === "draining" ||
      phase === "documents_deleted" ||
      phase === "threads_deleted"
    ) {
      throw new Error(`Cannot mark assets deleted before database cleanup: ${sessionId}`);
    }
    if (phase !== "database_deleted") return commitTransaction(phase);
    await client.execute({
      sql: "DELETE FROM session_resources WHERE session_id = ?",
      args: [sessionId],
    });
    const now = new Date().toISOString();
    await client.execute({
      sql: `UPDATE deleted_sessions SET phase = 'assets_deleted', updated_at = ?
        WHERE session_id = ? AND phase = 'database_deleted'`,
      args: [now, sessionId],
    });
    return commitTransaction("assets_deleted" as const);
  });
}

export async function findSessionDataReferences(
  sessionId: string,
  relatedIds: readonly string[] = [],
): Promise<SessionDataReference[]> {
  await ensureMigrated();
  return findSessionDataReferencesWithClient(
    getDocumentsClient(),
    sessionId,
    relatedIds,
  );
}

export async function completeSessionDeletion(
  sessionId: string,
  relatedIds: readonly string[] = [],
): Promise<void> {
  await ensureMigrated();
  await withTransaction(async (client) => {
    const remaining = await findSessionDataReferencesWithClient(
      client,
      sessionId,
      relatedIds,
    );
    if (remaining.length > 0) {
      throw new Error(
        `Session deletion invariant failed: ${sessionId}: ${JSON.stringify(remaining)}`,
      );
    }
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `UPDATE deleted_sessions
        SET phase = 'completed', updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE session_id = ? AND phase IN ('assets_deleted', 'completed')`,
      args: [now, now, sessionId],
    });
    if (result.rowsAffected === 0) {
      throw new Error(`Cannot complete session deletion before assets commit: ${sessionId}`);
    }
    return commitTransaction(undefined);
  });
}
