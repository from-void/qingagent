import { commitTransaction, getDocumentsClient, withTransaction, withWriteRetry } from "./documentsClient.js";
import { deleteDocumentFamilyByDocIds } from "./documentFamilyRepo.js";
import { ensureMigrated } from "./migrations.js";

export type SessionDeletionPhase = "draining" | "documents_deleted" | "completed";

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

export async function completeSessionDeletion(sessionId: string): Promise<void> {
  await ensureMigrated();
  const now = new Date().toISOString();
  await withWriteRetry(async () => {
    const result = await getDocumentsClient().execute({
      sql: `UPDATE deleted_sessions
        SET phase = 'completed', updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE session_id = ? AND phase IN ('documents_deleted', 'completed')`,
      args: [now, now, sessionId],
    });
    if (result.rowsAffected === 0) {
      throw new Error(`Cannot complete session deletion before documents commit: ${sessionId}`);
    }
  });
}
