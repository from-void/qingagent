import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../bridge/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-propose-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external proposals", () => {
  it("覆盖 P1 状态矩阵主路径和 409 家族", async () => {
    const sessionId = await createSession();

    const emptyReplace = await propose(sessionId, { expectedDocVersion: 0, ops: [{ kind: "strReplace", old: "旧", new: "新" }] });
    expect(emptyReplace.status).toBe(400);
    expect(await emptyReplace.json()).toMatchObject({ code: "VALIDATION" });

    const fullDraft = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "# 标题\n\n第一段旧文。" }],
    });
    expect(fullDraft.status).toBe(200);
    expect(await fullDraft.json()).toMatchObject({ status: "committed", docVersion: 1 });

    const conflict = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "VERSION_CONFLICT", expected: 0, actual: 1 });

    const fullDraftAgain = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "fullDraft", markdown: "# 覆写" }],
    });
    expect(fullDraftAgain.status).toBe(400);
    expect(await fullDraftAgain.json()).toMatchObject({ code: "VALIDATION" });

    const tooMany = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: Array.from({ length: 51 }, () => ({ kind: "appendSection", markdown: "x" })),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "VALIDATION" });

    const review = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    });
    expect(review.status).toBe(200);
    const reviewBody = await review.json() as { status: string; count: number; patchIds: string[] };
    expect(reviewBody.status).toBe("review");
    expect(reviewBody.count).toBeGreaterThan(0);
    expect(reviewBody.patchIds.length).toBe(reviewBody.count);

    const pending = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "第二段。" }],
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "REVIEW_PENDING" });
  });

  it("streamId 非空时返回 AGENT_BUSY", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.streamId = "busy-stream";
    const busy = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "第二段。" }],
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "AGENT_BUSY" });
  });
});

async function createSession(): Promise<string> {
  const res = await app.request("/api/v1/external/sessions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title: "测试文档" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

async function propose(sessionId: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1/external/sessions/${sessionId}/proposals`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
