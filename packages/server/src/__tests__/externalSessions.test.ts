import {
  createSession,
  documentRepo,
  persistSessionMetadata,
  QINGAGENT_RESOURCE_ID,
} from "@qingagent/core";
import { deleteDocumentFamilyByDocIds, getDocumentsClient } from "@qingagent/db";
import { __resetDocumentsClientForTest } from "@qingagent/db/client";
import { __resetMigrationsForTest } from "@qingagent/db/migrations";
import { markdownToPm, normalizePmDoc } from "@qingagent/pm-schema";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { getSession, sessionManager } from "../gateway/bridgeHandler";
import { sessions } from "../gateway/sessionRegistry";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
const syntheticSessionIds: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
let token = "";

async function markThreadExistsInDocumentsDb(threadId: string): Promise<void> {
  const client = getDocumentsClient();
  await client.execute("CREATE TABLE IF NOT EXISTS mastra_threads (id TEXT PRIMARY KEY)");
  await client.execute({
    sql: "INSERT OR IGNORE INTO mastra_threads (id) VALUES (?)",
    args: [threadId],
  });
}

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-sessions-test-"));
  dirs.push(dir);
  process.env.DATABASE_URL = `file:${path.join(dir, "documents.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopExternalInstance();
  await sessionManager.disposeAll();
  const ids = syntheticSessionIds.splice(0);
  for (const sessionId of ids) sessions.delete(sessionId);
  await deleteDocumentFamilyByDocIds(getDocumentsClient(), ids);
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external sessions", () => {
  it("create 后 list 立即可见", async () => {
    const created = await app.request("/api/v1/external/sessions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ title: "不应假回显" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { sessionId: string; title?: string };
    expect(createdBody.sessionId).toBeTruthy();
    expect(createdBody).not.toHaveProperty("title");

    const listed = await app.request("/api/v1/external/sessions", { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { sessions: Array<{ id: string }> };
    expect(listedBody.sessions.map((session) => session.id)).toContain(createdBody.sessionId);
  });

  it("list 过滤没有 thread 的 documents 孤儿行", async () => {
    syntheticSessionIds.push("orphan-doc-row");
    await documentRepo.save({
      id: "orphan-doc-row",
      threadId: "orphan-thread",
      resourceId: QINGAGENT_RESOURCE_ID,
      title: "孤儿行",
      docState: "editing",
      docVersion: 1,
      lastSyncedVersion: 1,
      pmDoc: normalizePmDoc(markdownToPm("正文")),
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });

    const listed = await app.request("/api/v1/external/sessions", { headers: authHeaders() });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((session) => session.id)).not.toContain("orphan-doc-row");
  });

  it("threads 表不存在时 list 仍返回 200 并列出内存会话", async () => {
    const memoryOnlyId = `memory-before-threads-${Date.now()}`;
    const memoryOnlySession = createSession(memoryOnlyId, new Date().toISOString());
    memoryOnlySession.title = "初始化前内存会话";
    sessions.set(memoryOnlyId, memoryOnlySession);
    syntheticSessionIds.push(memoryOnlyId);
    vi.spyOn(sessionManager, "listSessionIds").mockReturnValue([memoryOnlyId]);

    const threadTable = await getDocumentsClient().execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mastra_threads'",
    );
    expect(threadTable.rows).toHaveLength(0);

    const listed = await app.request("/api/v1/external/sessions", {
      headers: authHeaders(),
    });
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      sessions: Array<{ id: string; title: string }>;
      total: number;
    };
    expect(body.sessions).toEqual([
      expect.objectContaining({
        id: memoryOnlyId,
        title: "初始化前内存会话",
      }),
    ]);
    expect(body.total).toBe(1);
  });

  it("孤儿行不占 total 与 offset，内存会话跨页不重复", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const orphanId = `000-orphan-page-${suffix}`;
    const memoryOnlyId = `memory-page-${suffix}`;
    syntheticSessionIds.push(orphanId, memoryOnlyId);

    await documentRepo.save({
      id: orphanId,
      threadId: `missing-thread-${suffix}`,
      resourceId: QINGAGENT_RESOURCE_ID,
      title: "分页孤儿行",
      docState: "editing",
      docVersion: 1,
      lastSyncedVersion: 1,
      pmDoc: normalizePmDoc(markdownToPm("正文")),
      createdAt: "9999-12-31T23:59:59.999Z",
      updatedAt: "9999-12-31T23:59:59.999Z",
    });
    const memoryOnlySession = createSession(memoryOnlyId, new Date().toISOString());
    memoryOnlySession.title = "分页内存会话";
    sessions.set(memoryOnlyId, memoryOnlySession);
    vi.spyOn(sessionManager, "listSessionIds").mockReturnValue([memoryOnlyId]);

    // 先走真实查询确认孤儿行已被过滤，再冻结持久会话快照。全量测试中其他
    // 用例的 thread 可能在下方三次请求之间落盘，不能让它改变本用例的 offset。
    const persistedSnapshot = await documentRepo.listWithExistingThreads({
      resourceId: QINGAGENT_RESOURCE_ID,
      perPage: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });
    expect(persistedSnapshot.rows.map((row) => row.id)).not.toContain(orphanId);
    expect(persistedSnapshot.rows).toHaveLength(persistedSnapshot.total);
    vi.spyOn(documentRepo, "listWithExistingThreads").mockImplementation(async (opts) => {
      const perPage = opts.perPage ?? 50;
      const offset = opts.offset ?? (opts.page ?? 0) * perPage;
      return {
        rows: persistedSnapshot.rows.slice(offset, offset + perPage),
        total: persistedSnapshot.total,
      };
    });

    const all = await app.request("/api/v1/external/sessions?limit=500", {
      headers: authHeaders(),
    });
    expect(all.status).toBe(200);
    const allBody = await all.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    const memoryOffset = allBody.sessions.findIndex((session) => session.id === memoryOnlyId);
    expect(memoryOffset).toBeGreaterThanOrEqual(0);
    expect(allBody.total).toBe(allBody.sessions.length);
    expect(allBody.hasMore).toBe(false);

    const memoryPage = await app.request(
      `/api/v1/external/sessions?limit=1&offset=${memoryOffset}`,
      { headers: authHeaders() },
    );
    const memoryPageBody = await memoryPage.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(memoryPageBody.sessions.map((session) => session.id)).toEqual([memoryOnlyId]);
    expect(memoryPageBody.total).toBe(allBody.total);
    expect(memoryPageBody.hasMore).toBe(false);

    const afterMemory = await app.request(
      `/api/v1/external/sessions?limit=1&offset=${memoryOffset + 1}`,
      { headers: authHeaders() },
    );
    const afterMemoryBody = await afterMemory.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(afterMemoryBody.sessions.map((session) => session.id)).not.toContain(memoryOnlyId);
    expect(afterMemoryBody.total).toBe(allBody.total);
    expect(afterMemoryBody.hasMore).toBe(false);
  });

  it("list 补充仅存在于内存的会话并对已落盘会话去重", async () => {
    const memoryOnlyId = `memory-only-${Date.now()}`;
    const memoryOnlySession = createSession(memoryOnlyId, new Date().toISOString());
    memoryOnlySession.title = "仅内存会话";
    sessions.set(memoryOnlyId, memoryOnlySession);
    syntheticSessionIds.push(memoryOnlyId);

    const created = await app.request("/api/v1/external/sessions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(200);
    const { sessionId: persistedId } = await created.json() as { sessionId: string };
    syntheticSessionIds.push(persistedId);
    const persistedSession = getSession(persistedId);
    expect(persistedSession).toBeDefined();
    if (!persistedSession) return;
    await persistedSession.threadCreatePromise;
    persistedSession.title = "已落盘会话";
    await persistSessionMetadata(persistedSession, "test:list-persisted");
    // 测试的 documents 临时库与模块加载时已绑定的 Mastra 库不同；
    // 显式镜像存在性，确保本用例仍覆盖“落盘页 + 内存页”的去重。
    await markThreadExistsInDocumentsDb(persistedId);

    const listSessionIds = vi.spyOn(sessionManager, "listSessionIds")
      .mockReturnValue([persistedId, memoryOnlyId]);

    const listed = await app.request("/api/v1/external/sessions?limit=500", {
      headers: authHeaders(),
    });

    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      sessions: Array<{ id: string; title: string }>;
      total: number;
    };
    expect(listSessionIds).toHaveBeenCalledWith(50);
    expect(body.sessions.filter((session) => session.id === persistedId)).toHaveLength(1);
    expect(body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: memoryOnlyId, title: "仅内存会话" }),
    ]));
    expect(body.sessions.findIndex((session) => session.id === persistedId))
      .toBeLessThan(body.sessions.findIndex((session) => session.id === memoryOnlyId));
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("纯改标题后 list 从权威 thread 派生并返回新标题", async () => {
    const created = await app.request("/api/v1/external/sessions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const { sessionId } = await created.json() as { sessionId: string };
    const session = getSession(sessionId);
    expect(session).toBeDefined();
    if (!session) return;

    session.title = "重命名后的标题";
    await persistSessionMetadata(session, "test:rename");

    const stored = await documentRepo.load(session.docId);
    expect(stored).toBeDefined();
    if (!stored?.pmDoc) return;
    await documentRepo.save({
      ...stored,
      title: "故障窗口中的旧标题",
      pmDoc: stored.pmDoc,
    });
    // 这里只镜像 thread 的存在性，标题仍必须从真实 Mastra thread 冷恢复。
    await markThreadExistsInDocumentsDb(sessionId);
    await sessionManager.disposeAll();

    const listed = await app.request("/api/v1/external/sessions", { headers: authHeaders() });
    const body = await listed.json() as { sessions: Array<{ id: string; title: string }> };
    expect(body.sessions.find((item) => item.id === sessionId)?.title).toBe("重命名后的标题");
  });

  it("文档超过默认上限时可分页读取后续会话并返回正确 hasMore", async () => {
    vi.spyOn(sessionManager, "listSessionIds").mockReturnValue([]);
    // 本用例只验证 server 分页，局部复用原始 documents 查询，避免向共享
    // Mastra thread 表写入 102 条极晚时间夹具而污染并行的首页排序用例。
    vi.spyOn(documentRepo, "listWithExistingThreads")
      .mockImplementation((opts) => documentRepo.list(opts));
    // 固定为最晚时间，避免并行测试新建会话改变本用例的分页边界。
    const updatedAt = "9999-12-31T23:59:59.999Z";
    const prefix = `pagination-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ids = Array.from({ length: 102 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`).sort();

    for (const id of ids) {
      const session = createSession(id, updatedAt);
      session.title = `分页会话 ${id}`;
      sessions.set(id, session);
      syntheticSessionIds.push(id);
    }
    await documentRepo.saveMany(ids.map((id) => ({
      id,
      threadId: id,
      resourceId: QINGAGENT_RESOURCE_ID,
      title: `分页会话 ${id}`,
      docState: "empty",
      docVersion: 0,
      lastSyncedVersion: 0,
      pmDoc: normalizePmDoc(markdownToPm("")),
      createdAt: updatedAt,
      updatedAt,
    })));

    const first = await app.request("/api/v1/external/sessions", { headers: authHeaders() });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(firstBody.sessions.map((session) => session.id)).toEqual(ids.slice(0, 100));
    expect(firstBody.total).toBeGreaterThanOrEqual(ids.length);
    expect(firstBody.hasMore).toBe(true);

    const second = await app.request("/api/v1/external/sessions?limit=2&offset=100", {
      headers: authHeaders(),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(secondBody.sessions.map((session) => session.id)).toEqual(ids.slice(100, 102));
    expect(secondBody.total).toBeGreaterThanOrEqual(ids.length);
    expect(secondBody.hasMore).toBe(102 < secondBody.total);
  });

  it("快照游标在页间更新时间变化时不重复或遗漏会话", async () => {
    vi.spyOn(sessionManager, "listSessionIds").mockReturnValue([]);
    const prefix = `cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
    const updatedAt = [
      "2030-01-03T00:00:00.000Z",
      "2030-01-02T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    ];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]!;
      const session = createSession(id, updatedAt[index]!);
      session.title = `游标会话 ${index + 1}`;
      sessions.set(id, session);
      syntheticSessionIds.push(id);
      await markThreadExistsInDocumentsDb(id);
    }
    await documentRepo.saveMany(ids.map((id, index) => ({
      id,
      threadId: id,
      resourceId: QINGAGENT_RESOURCE_ID,
      title: `游标会话 ${index + 1}`,
      docState: "editing",
      docVersion: 1,
      lastSyncedVersion: 1,
      pmDoc: normalizePmDoc(markdownToPm(`正文 ${index + 1}`)),
      createdAt: updatedAt[index]!,
      updatedAt: updatedAt[index]!,
    })));

    const first = await app.request(
      "/api/v1/external/sessions?limit=1&cursor=start",
      { headers: authHeaders() },
    );
    const firstBody = await first.json() as {
      sessions: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string | null;
    };
    expect(firstBody.sessions.map((session) => session.id)).toEqual([ids[0]]);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const last = await documentRepo.load(ids[2]!);
    expect(last).toBeDefined();
    await documentRepo.save({
      ...last!,
      pmDoc: last!.pmDoc!,
      updatedAt: "2030-01-04T00:00:00.000Z",
    });

    const collected = [ids[0]!];
    let cursor = firstBody.nextCursor!;
    while (cursor) {
      const page = await app.request(
        `/api/v1/external/sessions?limit=1&cursor=${encodeURIComponent(cursor)}`,
        { headers: authHeaders() },
      );
      expect(page.status).toBe(200);
      const body = await page.json() as {
        sessions: Array<{ id: string }>;
        hasMore: boolean;
        nextCursor?: string | null;
      };
      collected.push(...body.sessions.map((session) => session.id));
      cursor = body.nextCursor ?? "";
      if (!body.hasMore) break;
    }

    expect(collected).toEqual(ids);
    expect(new Set(collected).size).toBe(ids.length);
  });
});

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
