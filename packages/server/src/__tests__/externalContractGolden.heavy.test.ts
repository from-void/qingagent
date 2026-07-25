import type {
  ExternalBridgeFrame,
  ExternalChatLogResponse,
  ExternalChatSendResponse,
  ExternalDocReadResponse,
  ExternalErrorResponse,
  ExternalEventsMeta,
  ExternalFilesListResponse,
  ExternalFileTextResponse,
  ExternalHealthResponse,
  ExternalProposalResponse,
  ExternalReviewListResponse,
  ExternalSessionCreateResponse,
  ExternalSessionsListResponse,
} from "../../../qa-cli/src/generated/externalApi";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-external-contract-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "1.2.3", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external API v1 golden contract", () => {
  it("401 error 符合公开错误契约", async () => {
    const response = await app.request("/api/v1/external/health");
    expect(response.status).toBe(401);
    const body = await response.json() as ExternalErrorResponse;
    exactKeys(body, ["error", "code", "nextStep"]);
    expect(body).toEqual({
      error: "unauthorized",
      code: "AUTH_FAILED",
      nextStep: expect.any(String),
    });
  });

  it("GET /health", async () => {
    const body = await getJson<ExternalHealthResponse>("/health");
    exactKeys(body, ["ok", "version", "pid", "startedAt"]);
    expect(body).toEqual({ ok: true, version: "1.2.3", pid: process.pid, startedAt: expect.any(String) });
  });

  it("POST /sessions", async () => {
    const body = await createSession();
    exactKeys(body, ["sessionId", "seq"]);
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.seq === null || typeof body.seq === "number").toBe(true);
  });

  it("GET /sessions", async () => {
    const created = await createSession();
    const body = await getJson<ExternalSessionsListResponse>("/sessions");
    exactKeys(body, ["sessions", "total", "hasMore"]);
    const session = body.sessions.find((item) => item.id === created.sessionId);
    expect(session).toBeDefined();
    exactKeys(session!, ["id", "title", "state", "updatedAt"]);
    expect(session).toEqual({ id: created.sessionId, title: expect.any(String), state: "empty", updatedAt: expect.any(String) });
  });

  it("GET /sessions/:id/doc", async () => {
    const { sessionId } = await createSession();
    const body = await getJson<ExternalDocReadResponse>(`/sessions/${sessionId}/doc?lines=1`);
    exactKeys(body, ["sessionId", "docVersion", "state", "agentBusy", "markdown", "markdownWithLineNumbers"]);
    expect(body).toEqual({
      sessionId, docVersion: 0, state: "empty", agentBusy: false,
      markdown: "", markdownWithLineNumbers: "   1 | ",
    });
  });

  it("GET /sessions/:id/chat", async () => {
    const { sessionId } = await createSession();
    const session = await getOrRestoreSession(sessionId);
    session!.chatHistory.push({
      id: "golden-message", role: { kind: "user" }, ts: "2026-07-13T00:00:00.000Z", chips: null,
      parts: [{ kind: "text", data: { body: "你好" } }],
    });
    const body = await getJson<ExternalChatLogResponse>(`/sessions/${sessionId}/chat`);
    exactKeys(body, ["sessionId", "messages"]);
    expect(body.messages).toHaveLength(1);
    exactKeys(body.messages[0]!, ["id", "role", "ts", "text"]);
    exactKeys(body.messages[0]!.role, ["kind"]);
    expect(body.messages[0]).toEqual({ id: "golden-message", role: { kind: "user" }, ts: expect.any(String), text: "你好" });
  });

  it("POST /sessions/:id/chat", async () => {
    const { sessionId } = await createSession();
    const submit = vi.spyOn(sessionManager, "submit").mockResolvedValue([]);
    const body = await postJson<ExternalChatSendResponse>(`/sessions/${sessionId}/chat`, { text: "继续" });
    submit.mockRestore();
    exactKeys(body, ["queued", "note"]);
    expect(body).toEqual({ queued: true, note: expect.any(String) });
  });

  it("GET /sessions/:id/files", async () => {
    const { sessionId } = await createSession();
    const session = await getOrRestoreSession(sessionId);
    session!.materials.set("golden-file", {
      id: "golden-file", filename: "golden.txt", mimeType: "text/plain", text: "abc", summary: "摘要", fileId: null,
      metadata: { pages: null, wordCount: 1, title: null, sourceUrl: null, parseState: "ready", parseError: null },
      createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const body = await getJson<ExternalFilesListResponse>(`/sessions/${sessionId}/files`);
    exactKeys(body, ["sessionId", "materials", "folderSources"]);
    expect(body.materials).toHaveLength(1);
    exactKeys(body.materials[0]!, ["id", "filename", "mime", "summary", "wordCount", "byteLen", "parseState", "sourceUrl", "createdAt"]);
    expect(body.materials[0]).toEqual({
      id: "golden-file", filename: "golden.txt", mime: "text/plain", summary: "摘要", wordCount: 1,
      byteLen: 3, parseState: "ready", sourceUrl: null, createdAt: expect.any(String),
    });
    expect(body.folderSources).toEqual([]);
  });

  it("GET /sessions/:id/files/:materialId/text", async () => {
    const { sessionId } = await createSession();
    const session = await getOrRestoreSession(sessionId);
    session!.materials.set("golden-text", {
      id: "golden-text", filename: "text.txt", mimeType: "text/plain", text: "abcdef", summary: null, fileId: null,
      metadata: { pages: null, wordCount: 1, title: null, sourceUrl: null, parseState: "ready", parseError: null },
      createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z",
    });
    const body = await getJson<ExternalFileTextResponse>(`/sessions/${sessionId}/files/golden-text/text?maxBytes=3`);
    exactKeys(body, ["id", "filename", "mime", "text", "byteLen", "truncated"]);
    expect(body).toEqual({ id: "golden-text", filename: "text.txt", mime: "text/plain", text: "abc", byteLen: 6, truncated: true });
  });

  it("POST /sessions/:id/proposals", async () => {
    const { sessionId } = await createSession();
    const body = await postJson<ExternalProposalResponse>(`/sessions/${sessionId}/proposals`, {
      expectedDocVersion: 0, ops: [{ kind: "fullDraft", markdown: "# Golden" }],
    });
    expect(body.status).toBe("committed");
    if (body.status !== "committed") throw new Error("expected committed proposal");
    exactKeys(body, ["status", "docVersion", "seq"]);
    expect(body).toEqual({ status: "committed", docVersion: 1, seq: expect.any(Number) });
  });

  it("GET /sessions/:id/review", async () => {
    const { sessionId } = await createSession();
    const body = await getJson<ExternalReviewListResponse>(
      `/sessions/${sessionId}/review`,
    );
    exactKeys(body, [
      "sessionId",
      "docVersion",
      "state",
      "agentBusy",
      "patches",
      "annotations",
    ]);
    expect(body).toEqual({
      sessionId,
      docVersion: 0,
      state: "empty",
      agentBusy: false,
      patches: [],
      annotations: [],
    });
  });

  it("GET /sessions/:id/events", async () => {
    const sessionId = "golden-events";
    sessionManager.frameLog.append(sessionId, { kind: "sessionMeta", data: { sessionId, title: "Golden" } });
    const controller = new AbortController();
    const response = await app.request(`/api/v1/external/sessions/${sessionId}/events?after=0`, {
      headers: authHeaders(), signal: controller.signal,
    });
    const events = await readSse(response, controller, 2);
    const meta = JSON.parse(events[0]!.data) as ExternalEventsMeta;
    const frame = JSON.parse(events[1]!.data) as ExternalBridgeFrame;
    exactKeys(meta, ["epoch", "minSeq", "nextSeq", "gap"]);
    exactKeys(frame, ["seq", "kind", "data"]);
    exactKeys(frame.data as Record<string, unknown>, ["sessionId", "title"]);
    expect(meta).toEqual({ epoch: expect.any(Number), minSeq: 1, nextSeq: 2, gap: false });
    expect(frame).toEqual({ seq: 1, kind: "sessionMeta", data: { sessionId, title: "Golden" } });
  });

  it("所有 JSON error 精确锁定 code/error/nextStep", async () => {
    const response = await app.request("/api/v1/external/sessions/missing/doc", { headers: authHeaders() });
    expect(response.status).toBe(404);
    const body = await response.json() as ExternalErrorResponse;
    exactKeys(body, ["error", "code", "nextStep"]);
    expect(body).toEqual({ error: "SESSION_NOT_FOUND", code: "SESSION_NOT_FOUND", nextStep: expect.any(String) });
  });
});

async function createSession(): Promise<ExternalSessionCreateResponse> {
  return postJson<ExternalSessionCreateResponse>("/sessions", {});
}

async function getJson<T>(pathName: string): Promise<T> {
  const response = await app.request(`/api/v1/external${pathName}`, { headers: authHeaders() });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function postJson<T>(pathName: string, body: unknown): Promise<T> {
  const response = await app.request(`/api/v1/external${pathName}`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

function exactKeys<T extends object>(value: T, keys: ReadonlyArray<keyof T>): void {
  expect(Object.keys(value).sort()).toEqual(keys.map(String).sort());
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function readSse(response: Response, controller: AbortController, count: number) {
  expect(response.status).toBe(200);
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("events response has no body");
  const events: Array<{ event: string; data: string }> = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const event = chunk.match(/^event: (.+)$/m)?.[1];
        const data = chunk.match(/^data: (.+)$/m)?.[1];
        if (event && data && event !== "ping") events.push({ event, data });
      }
    }
    return events;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}
