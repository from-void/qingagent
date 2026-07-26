import { createSession, documentRepo, persistSessionMetadata, QINGAGENT_RESOURCE_ID } from "@qingagent/core";
import { deleteDocumentFamilyByDocIds, getDocumentsClient } from "@qingagent/db";
import { __resetDocumentsClientForTest } from "@qingagent/db/client";
import { __resetMigrationsForTest } from "@qingagent/db/migrations";
import { markdownToPm, normalizePmDoc } from "@qingagent/pm-schema";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { getSession, sessionManager } from "../gateway/bridgeHandler";
import { sessions } from "../gateway/sessionRegistry";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
const syntheticSessionIds: string[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
let token = "";

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
    await sessionManager.disposeAll();

    const listed = await app.request("/api/v1/external/sessions", { headers: authHeaders() });
    const body = await listed.json() as { sessions: Array<{ id: string; title: string }> };
    expect(body.sessions.find((item) => item.id === sessionId)?.title).toBe("重命名后的标题");
  });

  it("文档超过默认上限时可分页读取后续会话并返回正确 hasMore", async () => {
    const beforeSummary = await documentRepo.list({
      resourceId: QINGAGENT_RESOURCE_ID,
      perPage: 1,
    });
    const before = await documentRepo.list({
      resourceId: QINGAGENT_RESOURCE_ID,
      perPage: Math.max(1, beforeSummary.total),
    });
    const earliestTime = Date.parse(before.rows.at(-1)?.updatedAt ?? "");
    const updatedAt = new Date(Number.isFinite(earliestTime) ? earliestTime - 1_000 : 0).toISOString();
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
    expect(firstBody.total).toBe(before.total + ids.length);
    expect(firstBody.hasMore).toBe(true);

    const targetOffset = Math.max(100, before.total);
    const targetIndex = targetOffset - before.total;
    const second = await app.request(`/api/v1/external/sessions?limit=2&offset=${targetOffset}`, {
      headers: authHeaders(),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as {
      sessions: Array<{ id: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(secondBody.sessions.map((session) => session.id)).toEqual(ids.slice(targetIndex, targetIndex + 2));
    expect(secondBody.total).toBe(before.total + ids.length);
    expect(secondBody.hasMore).toBe(targetOffset + 2 < before.total + ids.length);
  });
});

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
