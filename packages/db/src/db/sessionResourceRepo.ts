import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionResourceKind = "upload" | "generated" | "discovered";

export interface SessionResourceRecord {
  sessionId: string;
  resourceId: string;
  kind: SessionResourceKind;
  refCount: number;
  createdAt: string;
  updatedAt: string;
}

function assertResourceInput(sessionId: string, resourceId: string): void {
  if (!sessionId) throw new Error("sessionId must not be empty");
  if (!UUID_RE.test(resourceId)) throw new Error("resourceId must be a UUID");
}

function mapRecord(row: Record<string, unknown>): SessionResourceRecord {
  return {
    sessionId: String(row.session_id),
    resourceId: String(row.resource_id),
    kind: String(row.kind) as SessionResourceKind,
    refCount: Number(row.ref_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 新产生一次会话级文件引用；删除墓碑落下后拒绝再接纳新资源。 */
export async function registerSessionResource(input: {
  sessionId: string;
  resourceId: string;
  kind: Exclude<SessionResourceKind, "discovered">;
}): Promise<void> {
  assertResourceInput(input.sessionId, input.resourceId);
  await ensureMigrated();
  await withTransaction(async (client) => {
    const tombstone = await client.execute({
      sql: "SELECT 1 FROM deleted_sessions WHERE session_id = ? LIMIT 1",
      args: [input.sessionId],
    });
    if (tombstone.rows.length > 0) {
      throw new Error(`Cannot attach resource to deleted session: ${input.sessionId}`);
    }
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO session_resources (
          session_id, resource_id, kind, ref_count, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(session_id, resource_id) DO UPDATE SET
          kind = CASE
            WHEN session_resources.kind = 'discovered' THEN excluded.kind
            ELSE session_resources.kind
          END,
          ref_count = session_resources.ref_count + 1,
          updated_at = excluded.updated_at`,
      args: [input.sessionId, input.resourceId, input.kind, now, now],
    });
    return commitTransaction(undefined);
  });
}

export async function listSessionResources(sessionId: string): Promise<SessionResourceRecord[]> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute({
    sql: `SELECT session_id, resource_id, kind, ref_count, created_at, updated_at
      FROM session_resources WHERE session_id = ? ORDER BY resource_id`,
    args: [sessionId],
  });
  return result.rows.map((row) => mapRecord(row));
}

export async function listActiveSessionResourceOwners(
  resourceId: string,
  excludingSessionId?: string,
): Promise<string[]> {
  if (!UUID_RE.test(resourceId)) return [];
  await ensureMigrated();
  const result = await getDocumentsClient().execute({
    sql: `SELECT resource.session_id
      FROM session_resources resource
      LEFT JOIN deleted_sessions deleted
        ON deleted.session_id = resource.session_id
      WHERE resource.resource_id = ?
        AND deleted.session_id IS NULL
        ${excludingSessionId ? "AND resource.session_id != ?" : ""}
      ORDER BY resource.session_id`,
    args: excludingSessionId ? [resourceId, excludingSessionId] : [resourceId],
  });
  return result.rows.map((row) => String(row.session_id));
}

export async function hasActiveSessionResource(resourceId: string): Promise<boolean> {
  return (await listActiveSessionResourceOwners(resourceId)).length > 0;
}

export async function removeSessionResource(
  sessionId: string,
  resourceId: string,
): Promise<SessionResourceRecord | null> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const found = await client.execute({
      sql: `SELECT session_id, resource_id, kind, ref_count, created_at, updated_at
        FROM session_resources WHERE session_id = ? AND resource_id = ?`,
      args: [sessionId, resourceId],
    });
    const row = found.rows[0];
    await client.execute({
      sql: "DELETE FROM session_resources WHERE session_id = ? AND resource_id = ?",
      args: [sessionId, resourceId],
    });
    return commitTransaction(row ? mapRecord(row) : null);
  });
}
