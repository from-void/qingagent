import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStablePmJson, legacySectionsToPm } from "@qingagent/pm-schema";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
} from "@qingagent/db/client";
import { __resetMigrationsForTest, ensureMigrated } from "@qingagent/db/migrations";

const callOrder: string[] = [];

const deleteSessionThread = vi.fn(async (sessionId: string) => {
  callOrder.push(`delete:${sessionId}`);
  const { deleteDocumentFamily } = await import("@qingagent/db");
  await deleteDocumentFamily(sessionId);
});

const sessionManager = {
  disposeSession: vi.fn(async (sessionId: string) => {
    callOrder.push(`dispose:${sessionId}`);
  }),
};

type DocumentsClient = ReturnType<typeof getDocumentsClient>;

let tempDir: string;
let oldDatabaseUrl: string | undefined;

beforeEach(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  oldDatabaseUrl = process.env.DATABASE_URL;
  tempDir = mkdtempSync(join(tmpdir(), "qa-server-delete-cascade-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "documents.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  vi.clearAllMocks();
  callOrder.length = 0;
});

afterEach(async () => {
  const { rmSync } = await import("node:fs");
  vi.doUnmock("@qingagent/core");
  vi.doUnmock("../bridge/bridgeHandler");
  vi.resetModules();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldDatabaseUrl;
  rmSync(tempDir, { recursive: true, force: true });
});

async function loadApp() {
  vi.resetModules();
  vi.doMock("@qingagent/core", async () => {
    const versions = await import("@qingagent/db");
    const homeMeta = await import("../../../core/src/home/pmToHomeArticleMeta.js");
    return {
      deleteSessionThread,
      getVersionSnapshot: versions.getVersionSnapshot,
      listSessionThreads: vi.fn(async () => ({ threads: [], total: 0, hasMore: false })),
      listVersions: versions.listVersions,
      pmToHomeArticleMeta: homeMeta.pmToHomeArticleMeta,
    };
  });
  vi.doMock("../bridge/bridgeHandler", () => ({
    sessionManager,
  }));
  const { Hono } = await import("hono");
  const { homeRoutes } = await import("../routes/home");
  const { historyRoutes } = await import("../routes/history");
  const app = new Hono();
  app.route("/api/v1", homeRoutes);
  app.route("/api/v1", historyRoutes);
  return app;
}

async function seedFamily(client: DocumentsClient, sessionId: string): Promise<void> {
  const now = "2026-07-10T00:00:00.000Z";
  const pm = legacySectionsToPm([{ kind: "p", data: { text: "删除路由正文" } }] as never);
  const pmJson = getStablePmJson(pm);
  await client.execute({
    sql: `INSERT INTO documents (
      id, thread_id, resource_id, title, doc_state, doc_version,
      last_synced_version, doc_pm, doc_schema_version, content_hash,
      doc_format, version, created_at, updated_at
    ) VALUES (?, ?, 'qingagent-user', 'route-delete', 'editing', 1, 1, ?, 1, 'hash-route', 'pm', 1, ?, ?)`,
    args: [sessionId, sessionId, pmJson, now, now],
  });
  await client.execute({
    sql: `INSERT INTO document_versions (
      version_id, doc_id, doc_version, content_hash, schema_version,
      actor_type, summary, snapshot_pm, parent_version, created_at
    ) VALUES ('route-ver', ?, 1, 'hash-route', 1, 'user', 'route version', ?, NULL, ?)`,
    args: [sessionId, pmJson, now],
  });
  await client.execute({
    sql: `INSERT INTO document_ops (
      op_id, doc_id, op_kind, steps, from_version, to_version, actor_type, created_at
    ) VALUES ('route-op', ?, 'replace_doc', '[]', 0, 1, 'user', ?)`,
    args: [sessionId, now],
  });
  await client.execute({
    sql: `INSERT INTO document_suggestions (
      id, doc_id, base_version, status, anchor_json, steps_json,
      preview_json, summary, created_at, updated_at
    ) VALUES ('route-sug', ?, 1, 'reviewing', '{}', '[]', '{}', 'route suggestion', ?, ?)`,
    args: [sessionId, now, now],
  });
  await client.execute({
    sql: `INSERT INTO document_drafts (
      doc_id, thread_id, base_version, base_hash, draft_pm, status, created_at, updated_at
    ) VALUES (?, ?, 1, 'hash-route', ?, 'pending_review', ?, ?)`,
    args: [sessionId, sessionId, pmJson, now, now],
  });
}

async function count(client: DocumentsClient, table: string, sessionId: string): Promise<number> {
  const column = table === "documents" ? "id" : "doc_id";
  const res = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
    args: [sessionId],
  });
  return Number(res.rows[0]?.n ?? 0);
}

describe("DELETE /sessions/:id documents 级联", () => {
  it("删除会话后 history 不可见且五张 documents 族表无残留", async () => {
    await ensureMigrated();
    const client = getDocumentsClient();
    const app = await loadApp();
    const sessionId = "route-delete-session";
    await seedFamily(client, sessionId);

    const before = await app.request(`/api/v1/history?sessionId=${sessionId}`);
    expect((await before.json()) as unknown).toMatchObject({ entries: [{ doc_id: sessionId }] });

    const deleted = await app.request(`/api/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Origin: "http://localhost:5173" },
    });

    expect(deleted.status).toBe(200);
    expect(callOrder).toEqual([`dispose:${sessionId}`, `delete:${sessionId}`]);
    expect(sessionManager.disposeSession).toHaveBeenCalledWith(sessionId);
    expect(deleteSessionThread).toHaveBeenCalledWith(sessionId);
    const after = await app.request(`/api/v1/history?sessionId=${sessionId}`);
    expect(await after.json()).toEqual({ entries: [] });
    await expect(Promise.all([
      count(client, "document_drafts", sessionId),
      count(client, "document_suggestions", sessionId),
      count(client, "document_ops", sessionId),
      count(client, "document_versions", sessionId),
      count(client, "documents", sessionId),
    ])).resolves.toEqual([0, 0, 0, 0, 0]);
  });
});
