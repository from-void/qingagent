import { documentRepo, QINGAGENT_RESOURCE_ID } from "@qingagent/core";
import { markdownToPm, normalizePmDoc } from "@qingagent/pm-schema";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-sessions-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
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
});

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
