import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import { sessionIdFromOwnedThreadId } from "@qingagent/contract-ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_URL_RE = /\/api\/v1\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?#]|$)/gi;
const RESOURCE_ID_KEYS = new Set(["fileid", "imageid"]);
const MAX_TRAVERSED_NODES = 100_000;
const MAX_JSON_CHARS = 16 * 1024 * 1024;

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

/** 存量回填/删除快照只保证“至少一条”，绝不把重复扫描误算成新引用。 */
export async function ensureSessionResource(input: {
  sessionId: string;
  resourceId: string;
  kind?: SessionResourceKind;
}): Promise<void> {
  assertResourceInput(input.sessionId, input.resourceId);
  await ensureMigrated();
  const now = new Date().toISOString();
  await withWriteRetry(() =>
    getDocumentsClient().execute({
      sql: `INSERT INTO session_resources (
          session_id, resource_id, kind, ref_count, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(session_id, resource_id) DO UPDATE SET
          kind = CASE
            WHEN session_resources.kind = 'discovered' AND excluded.kind != 'discovered'
              THEN excluded.kind
            ELSE session_resources.kind
          END,
          updated_at = excluded.updated_at`,
      args: [input.sessionId, input.resourceId, input.kind ?? "discovered", now, now],
    }),
  );
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

function decodeJsonCandidate(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    value = Buffer.from(value).toString("utf8");
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_JSON_CHARS ||
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * 只接受结构化 fileId/imageId 或 /api/v1/files/<uuid>，不从普通正文里的 UUID 猜资源。
 */
export function extractSessionResourceIds(value: unknown): string[] {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  let traversed = 0;

  const visit = (raw: unknown, parentKey?: string): void => {
    if (++traversed > MAX_TRAVERSED_NODES) return;
    const decoded = decodeJsonCandidate(raw);
    if (decoded !== raw) {
      visit(decoded, parentKey);
      return;
    }
    if (typeof raw === "string") {
      if (parentKey && RESOURCE_ID_KEYS.has(parentKey.toLowerCase()) && UUID_RE.test(raw)) {
        ids.add(raw.toLowerCase());
      }
      FILE_URL_RE.lastIndex = 0;
      for (const match of raw.matchAll(FILE_URL_RE)) {
        ids.add(match[1]!.toLowerCase());
      }
      return;
    }
    if (!raw || typeof raw !== "object") return;
    if (seen.has(raw)) return;
    seen.add(raw);
    if (Array.isArray(raw)) {
      for (const item of raw) visit(item, parentKey);
      return;
    }
    for (const [key, child] of Object.entries(raw as Record<string, unknown>)) {
      visit(child, key);
    }
  };

  visit(value);
  return [...ids].sort();
}

async function tableExists(table: string): Promise<boolean> {
  const result = await getDocumentsClient().execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function tableHasColumns(table: string, columns: readonly string[]): Promise<boolean> {
  if (!(await tableExists(table))) return false;
  const info = await getDocumentsClient().execute(`PRAGMA table_info("${table}")`);
  const found = new Set(info.rows.map((row) => String(row.name)));
  return columns.every((column) => found.has(column));
}

async function collectPersistedSessionResources(
  includeDeletedSessionId?: string,
): Promise<Map<string, Set<string>>> {
  const collected = new Map<string, Set<string>>();
  const add = (threadId: unknown, payload: unknown) => {
    if (typeof threadId !== "string" || !threadId) return;
    const sessionId = sessionIdFromOwnedThreadId(threadId);
    if (!sessionId) return;
    const ids = extractSessionResourceIds(payload);
    if (ids.length === 0) return;
    const bucket = collected.get(sessionId) ?? new Set<string>();
    for (const id of ids) bucket.add(id);
    collected.set(sessionId, bucket);
  };

  if (await tableHasColumns("mastra_threads", ["id", "metadata"])) {
    const threads = await getDocumentsClient().execute({
      sql: `SELECT thread.id AS thread_id, thread.metadata AS payload
        FROM mastra_threads thread
        LEFT JOIN deleted_sessions deleted ON deleted.session_id = CASE
          WHEN thread.id LIKE 'om-sidecar:%' THEN substr(thread.id, length('om-sidecar:') + 1)
          ELSE thread.id
        END
        WHERE deleted.session_id IS NULL OR deleted.session_id = ?`,
      args: [includeDeletedSessionId ?? ""],
    });
    for (const row of threads.rows) add(row.thread_id, row.payload);
  }

  // 已经按旧逻辑删掉主线程/文档的会话，只剩 om-sidecar 消息可供存量资源回填。
  if (await tableHasColumns("mastra_messages", ["thread_id", "content"])) {
    const messages = await getDocumentsClient().execute({
      sql: `SELECT message.thread_id, message.content AS payload
        FROM mastra_messages message
        LEFT JOIN deleted_sessions deleted ON deleted.session_id = CASE
          WHEN message.thread_id LIKE 'om-sidecar:%'
            THEN substr(message.thread_id, length('om-sidecar:') + 1)
          ELSE message.thread_id
        END
        WHERE deleted.session_id IS NULL OR deleted.session_id = ?`,
      args: [includeDeletedSessionId ?? ""],
    });
    for (const row of messages.rows) add(row.thread_id, row.payload);
  }

  for (const source of [
    { table: "documents", payload: "doc_pm" },
    { table: "document_drafts", payload: "draft_pm" },
    { table: "documents_quarantine_invalid_pm", payload: "doc_pm" },
  ] as const) {
    if (!(await tableExists(source.table))) continue;
    const rows = await getDocumentsClient().execute({
      sql: `SELECT source.thread_id AS session_id, source.${source.payload} AS payload
        FROM ${source.table} source
        LEFT JOIN deleted_sessions deleted ON deleted.session_id = source.thread_id
        WHERE deleted.session_id IS NULL OR source.thread_id = ?`,
      args: [includeDeletedSessionId ?? ""],
    });
    for (const row of rows.rows) add(row.session_id, row.payload);
  }
  return collected;
}

async function persistCollectedResources(collected: Map<string, Set<string>>): Promise<number> {
  let count = 0;
  for (const [sessionId, resourceIds] of collected) {
    for (const resourceId of resourceIds) {
      await ensureSessionResource({ sessionId, resourceId, kind: "discovered" });
      count++;
    }
  }
  return count;
}

/** 回填全部未删除会话，用于升级存量与下载归属判定。 */
export async function backfillActiveSessionResources(): Promise<number> {
  await ensureMigrated();
  return persistCollectedResources(await collectPersistedSessionResources());
}

/** 删除墓碑已落下时，仍从尚未物理删除的 thread/doc 快照补齐本会话清单。 */
export async function backfillDeletingSessionResources(sessionId: string): Promise<number> {
  await ensureMigrated();
  const collected = await collectPersistedSessionResources(sessionId);
  const own = collected.get(sessionId);
  if (!own) return 0;
  return persistCollectedResources(new Map([[sessionId, own]]));
}
