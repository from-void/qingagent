import type {
  ExternalBridgeFrame,
  ExternalAssetUploadResponse,
  ExternalChatLogResponse,
  ExternalChatSendResponse,
  ExternalDocReplaceRequest,
  ExternalDocReplaceResponse,
  ExternalDocReadResponse,
  ExternalErrorResponse,
  ExternalEventsMeta,
  ExternalFilesListResponse,
  ExternalFileTextResponse,
  ExternalHealthResponse,
  ExternalProposalResponse,
  ExternalProposalErrorResponse,
  ExternalPmDocReadResponse,
  ExternalReviewListResponse,
  ExternalReviewRenderModelResponse,
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
import { purgeStoredFile } from "../lib/uploadStorage";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-external-contract-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "1.2.3", libraryId: "00000000-0000-4000-8000-000000000001", filePath: path.join(dir, "instance.json") });
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
    exactKeys(body, [
      "ok", "schemaVersion", "port", "version", "pid", "attachProtocolVersion",
      "instanceId", "libraryId", "startedAt",
    ]);
    expect(body).toEqual({
      ok: true,
      schemaVersion: 2,
      port: 52341,
      version: "1.2.3",
      pid: process.pid,
      attachProtocolVersion: 1,
      instanceId: expect.any(String),
      libraryId: "00000000-0000-4000-8000-000000000001",
      startedAt: expect.any(String),
    });
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
    exactKeys(body, ["sessionId", "docVersion", "state", "agentBusy", "charCount", "markdown", "markdownWithLineNumbers", "title"]);
    expect(body).toEqual({
      sessionId, docVersion: 0, state: "empty", agentBusy: false,
      charCount: 0, markdown: "", markdownWithLineNumbers: "   1 | ", title: null,
    });
  });

  it("GET /sessions/:id/doc?format=qingml 精确返回 qingml/title", async () => {
    const { sessionId } = await createSession();
    await postJson<ExternalProposalResponse>(`/sessions/${sessionId}/proposals`, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: "<title>Golden QingML</title><h1>正文标题</h1><p>正文。</p>" }],
    });

    const body = await getJson<ExternalDocReadResponse>(`/sessions/${sessionId}/doc?format=qingml`);
    exactKeys(body, ["sessionId", "docVersion", "state", "agentBusy", "charCount", "markdown", "qingml", "title"]);
    expect(body).toEqual({
      sessionId,
      docVersion: 1,
      state: "editing",
      agentBusy: false,
      charCount: 7,
      markdown: expect.stringContaining("正文标题"),
      qingml: "<h1>正文标题</h1><p>正文。</p>",
      title: "Golden QingML",
    });
  });

  it("GET /sessions/:id/doc?format=pm 精确返回可写基线", async () => {
    const { sessionId } = await createSession();
    const body = await getJson<ExternalPmDocReadResponse>(
      `/sessions/${sessionId}/doc?format=pm`,
    );
    exactKeys(body, [
      "sessionId",
      "docVersion",
      "contentHash",
      "state",
      "agentBusy",
      "charCount",
      "title",
      "ts",
      "pmDoc",
    ]);
    expect(body).toEqual({
      sessionId,
      docVersion: 0,
      contentHash: expect.stringMatching(/^pmv1-/),
      state: "empty",
      agentBusy: false,
      charCount: 0,
      title: null,
      ts: expect.any(String),
      pmDoc: { type: "doc", attrs: { schemaVersion: 1 }, content: [] },
    });
  });

  it("PUT /sessions/:id/doc 精确返回直接保存回执", async () => {
    const { sessionId } = await createSession();
    const baseline = await getJson<ExternalPmDocReadResponse>(
      `/sessions/${sessionId}/doc?format=pm`,
    );
    const request: ExternalDocReplaceRequest = {
      expectedDocumentSnapshot: 0,
      baseContentHash: baseline.contentHash,
      clientMutationId: "golden-direct-save",
      doc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "golden-direct-paragraph" },
          content: [{ type: "text", text: "Golden 直接保存" }],
        }],
      },
    };
    const body = await putJson<ExternalDocReplaceResponse>(
      `/sessions/${sessionId}/doc`,
      request,
    );
    if (!body.ok) throw new Error("expected direct save success");
    exactKeys(body, ["ok", "clientMutationId", "docVersion", "contentHash", "ts", "charCount"]);
    expect(body).toEqual({
      ok: true,
      clientMutationId: request.clientMutationId,
      docVersion: 1,
      contentHash: expect.stringMatching(/^pmv1-/),
      ts: expect.any(String),
      charCount: 10,
    });
  });

  it("GET 空文档 format=qingml 返回空 QingML", async () => {
    const { sessionId } = await createSession();
    const body = await getJson<ExternalDocReadResponse>(`/sessions/${sessionId}/doc?format=qingml`);
    exactKeys(body, ["sessionId", "docVersion", "state", "agentBusy", "charCount", "markdown", "qingml", "title"]);
    expect(body).toEqual({
      sessionId,
      docVersion: 0,
      state: "empty",
      agentBusy: false,
      charCount: 0,
      markdown: "",
      qingml: "",
      title: null,
    });
  });

  it("qingmlDraft 无标签纯文本 fail-open 为单段", async () => {
    const { sessionId } = await createSession();
    await postJson<ExternalProposalResponse>(`/sessions/${sessionId}/proposals`, {
      expectedDocVersion: 0,
      ops: [{ kind: "qingmlDraft", qingml: "无标签纯文本" }],
    });
    const body = await getJson<ExternalDocReadResponse>(`/sessions/${sessionId}/doc?format=qingml`);
    expect(body.qingml).toBe("<p>无标签纯文本</p>");
  });

  it("GET /doc 未知 format 返回读语义 400", async () => {
    const { sessionId } = await createSession();
    const response = await app.request(`/api/v1/external/sessions/${sessionId}/doc?format=html`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as ExternalErrorResponse;
    exactKeys(body, ["error", "code", "nextStep"]);
    expect(body).toEqual({
      error: "format 仅支持 qingml 或 pm",
      code: "VALIDATION",
      nextStep: "读取文档时请移除 format，或改用 format=qingml / format=pm 后重试",
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

  it("POST + GET /sessions/:id/assets 精确锁定资产引用与二进制响应", async () => {
    const { sessionId } = await createSession();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const body = await postJson<ExternalAssetUploadResponse>(`/sessions/${sessionId}/assets`, {
      filename: "golden.png",
      mimeType: "image/png",
      base64: png.toString("base64"),
    });
    try {
      exactKeys(body, ["fileId", "filename", "mimeType", "size", "src"]);
      expect(body).toEqual({
        fileId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        filename: "golden.png",
        mimeType: "image/png",
        size: 8,
        src: `/api/v1/files/${body.fileId}/golden.png`,
      });

      const response = await app.request(
        `/api/v1/external/sessions/${sessionId}/assets/${body.fileId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-length")).toBe("8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    } finally {
      await purgeStoredFile(body.fileId);
    }
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
    exactKeys(body, ["status", "docVersion", "charCount", "seq"]);
    expect(body).toEqual({ status: "committed", docVersion: 1, charCount: 6, seq: expect.any(Number) });
  });

  it("POST /sessions/:id/proposals 的 VALIDATION 诊断体锁定公开字段", async () => {
    const { sessionId } = await createSession();
    const response = await app.request(`/api/v1/external/sessions/${sessionId}/proposals`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        expectedDocVersion: 0,
        ops: [{ kind: "qingmlDraft", qingml: "<pre>secret<p>block</p></pre>" }],
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as ExternalProposalErrorResponse;
    exactKeys(body as unknown as Record<string, unknown>, ["error", "code", "nextStep", "seq", "diagnostic"]);
    expect(body.code).toBe("VALIDATION");
    if (!("diagnostic" in body) || !body.diagnostic) throw new Error("expected validation diagnostic");
    exactKeys(body.diagnostic, ["failureKind", "warningKinds", "tagSkeleton", "errorLocations"]);
    expect(body.diagnostic).toMatchObject({
      failureKind: "qingml_bad_block",
      warningKinds: ["raw-text-child-tag"],
      tagSkeleton: "<pre><p></p></pre>",
      errorLocations: expect.any(Array),
    });
    for (const location of body.diagnostic.errorLocations) {
      expect(Object.keys(location).every((key) => ["kind", "startOffset", "endOffset", "path"].includes(key))).toBe(true);
    }
    expect(JSON.stringify(body)).not.toContain("secret");
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

  it("GET /sessions/:id/review?format=render-model 复用 DocDiffReady 字段", async () => {
    const { sessionId } = await createSession();
    const body = await getJson<ExternalReviewRenderModelResponse>(
      `/sessions/${sessionId}/review?format=render-model`,
    );
    exactKeys(body, [
      "sessionId",
      "docVersion",
      "state",
      "agentBusy",
      "baseVersion",
      "suggestions",
      "annotations",
    ]);
    expect(body).toEqual({
      sessionId,
      docVersion: 0,
      state: "empty",
      agentBusy: false,
      baseVersion: 0,
      suggestions: [],
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

async function putJson<T>(pathName: string, body: unknown): Promise<T> {
  const response = await app.request(`/api/v1/external${pathName}`, {
    method: "PUT", headers: authHeaders(), body: JSON.stringify(body),
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
