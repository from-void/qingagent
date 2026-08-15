import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash, normalizePmDoc } from "@qingagent/pm-schema";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-external-doc-test-"));
  dirs.push(dir);
  await startExternalInstance({
    port: 52341,
    version: "test",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(dir, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("external PM 文档读写", () => {
  it("format=pm 返回与 updateDoc 同口径的基线，并由内部写链幂等保存", async () => {
    const sessionId = await createSession();
    const initial = await request(`/sessions/${sessionId}/doc?format=pm`);
    expect(initial.status).toBe(200);
    const baseline = await initial.json() as {
      docVersion: number;
      contentHash: string;
      charCount: number;
      pmDoc: ReturnType<typeof doc>;
      ts: string;
    };
    expect(baseline).toMatchObject({
      docVersion: 0,
      contentHash: getPmContentHash(doc("")),
      charCount: 0,
      pmDoc: { type: "doc", attrs: { schemaVersion: 1 }, content: [] },
      ts: expect.any(String),
    });

    const mutation = {
      expectedDocumentSnapshot: baseline.docVersion,
      baseContentHash: baseline.contentHash,
      clientMutationId: "external-direct-save-1",
      doc: doc("用户直接保存"),
    };
    const first = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify(mutation),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      ok: true,
      clientMutationId: mutation.clientMutationId,
      docVersion: 1,
      contentHash: getPmContentHash(mutation.doc),
      charCount: 6,
      ts: expect.any(String),
    });

    const replay = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify(mutation),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const readBack = await request(`/sessions/${sessionId}/doc?format=pm`);
    expect(await readBack.json()).toMatchObject({
      sessionId,
      docVersion: 1,
      contentHash: getPmContentHash(mutation.doc),
      charCount: 6,
      state: "editing",
      agentBusy: false,
      pmDoc: mutation.doc,
    });
  });

  it("拒绝脏 payload，并在旧基线冲突时返回实际版本与实际哈希", async () => {
    const sessionId = await createSession();
    const initial = await request(`/sessions/${sessionId}/doc?format=pm`);
    const baseline = await initial.json() as { contentHash: string };
    const committedDoc = doc("现行正文");
    const committed = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: 0,
        baseContentHash: baseline.contentHash,
        clientMutationId: "external-conflict-first",
        doc: committedDoc,
      }),
    });
    expect(committed.status).toBe(200);

    const conflict = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: 0,
        baseContentHash: baseline.contentHash,
        clientMutationId: "external-conflict-stale",
        doc: doc("过期覆盖"),
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      ok: false,
      clientMutationId: "external-conflict-stale",
      code: "VERSION_CONFLICT",
      conflict: { expected: 0, actual: 1 },
      actualContentHash: getPmContentHash(committedDoc),
    });

    const invalid = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: 1,
        baseContentHash: "",
        clientMutationId: "external-invalid",
        doc: committedDoc,
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION" });
  });

  it("agent busy 与 pendingReview 都以 409 拒绝直接保存", async () => {
    const sessionId = await createSession();
    const baselineResponse = await request(`/sessions/${sessionId}/doc?format=pm`);
    const baseline = await baselineResponse.json() as { contentHash: string };
    const body = {
      expectedDocumentSnapshot: 0,
      baseContentHash: baseline.contentHash,
      clientMutationId: "external-busy",
      doc: doc("正文"),
    };
    const session = await getOrRestoreSession(sessionId);
    session!.runId = "busy-run";
    session!.streamId = "busy-stream";
    const busy = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "AGENT_BUSY" });
    session!.runId = null;
    session!.streamId = null;

    const initial = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({ ...body, clientMutationId: "external-pending-initial" }),
    });
    expect(initial.status).toBe(200);
    const proposal = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        ops: [{ kind: "strReplace", old: "正文", new: "候选正文" }],
      }),
    });
    expect(proposal.status).toBe(200);

    const pending = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: 1,
        baseContentHash: getPmContentHash(body.doc),
        clientMutationId: "external-pending",
        doc: doc("审阅态覆盖"),
      }),
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "REVIEW_PENDING" });
  });

  it("未知文档 format 返回校验错误", async () => {
    const sessionId = await createSession();
    const response = await request(`/sessions/${sessionId}/doc?format=html`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION" });
  });
});

function doc(text: string) {
  return normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: text
      ? [{
          type: "paragraph",
          attrs: { blockId: "external-doc-paragraph" },
          content: [{ type: "text", text }],
        }]
      : [],
  });
}

async function createSession(): Promise<string> {
  const response = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function request(pathName: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/v1/external${pathName}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}
