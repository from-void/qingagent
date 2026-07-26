import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { getSession, sessionManager } from "../gateway/bridgeHandler";
import { SessionActorQueueFullError } from "../gateway/sessionActor";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";
import { MAX_COMMAND_STRING_LENGTH } from "@qingagent/contract-ts/schemas";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-chat-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external chat", () => {
  it("POST chat 立即 queued,并以 origin=external 入队 sendMessage", async () => {
    const sessionId = await createSession();
    const submit = vi.spyOn(sessionManager, "submitQueued").mockResolvedValueOnce({
      completion: Promise.resolve([]),
    });
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "请继续写" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, note: "已入队,执行结果以 events 为准" });
    expect(submit).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        origin: "external",
        command: expect.objectContaining({
          kind: "sendMessage",
          data: expect.objectContaining({
            sessionId,
            text: "请继续写",
            mentions: [],
            skills: [],
            chips: [],
            fileIds: [],
          }),
        }),
      }),
    );
  });

  it("会话不存在时返回 SESSION_NOT_FOUND 且不提交 sendMessage", async () => {
    const submit = vi.spyOn(sessionManager, "submit");
    const res = await app.request("/api/v1/external/sessions/missing-chat/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "请继续写" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["abc", "Infinity", "0", "-1"])(
    "GET chat 拒绝非法 limit=%s",
    async (limit) => {
      const sessionId = await createSession();
      const res = await app.request(
        `/api/v1/external/sessions/${sessionId}/chat?limit=${encodeURIComponent(limit)}`,
        { headers: authHeaders() },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "VALIDATION",
        error: "limit 必须是正整数",
      });
    },
  );

  it("GET chat 的合法 limit 保留最后 N 条消息", async () => {
    const sessionId = await createSession();
    const session = getSession(sessionId);
    if (!session) throw new Error("missing session");
    session.chatHistory = ["一", "二", "三"].map((text, index) => ({
      id: `message-${index}`,
      role: { kind: "user" as const },
      ts: `2026-07-27T00:00:0${index}.000Z`,
      parts: [{ kind: "text" as const, data: { body: text } }],
      chips: null,
    }));

    const res = await app.request(
      `/api/v1/external/sessions/${sessionId}/chat?limit=2`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      messages: [
        { id: "message-1", text: "二" },
        { id: "message-2", text: "三" },
      ],
    });
  });

  it("复用 commandSchema 拒绝超过 64KB 的 text", async () => {
    const sessionId = await createSession();
    const submitQueued = vi.spyOn(sessionManager, "submitQueued");
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "x".repeat(MAX_COMMAND_STRING_LENGTH + 1) }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    expect(submitQueued).not.toHaveBeenCalled();
  });

  it("Actor 队列满时同步返回 429，不伪装成 queued", async () => {
    const sessionId = await createSession();
    vi.spyOn(sessionManager, "submitQueued").mockRejectedValueOnce(
      new SessionActorQueueFullError(64),
    );

    const res = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "请排队" }),
    });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("external 写端点接入限流，超过每秒容量后返回 429", async () => {
    const sessionId = await createSession();
    vi.spyOn(sessionManager, "submitQueued").mockResolvedValue({
      completion: Promise.resolve([]),
    });

    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { ...authHeaders(), "X-Forwarded-For": "203.0.113.20" },
        body: JSON.stringify({ text: `消息 ${index}` }),
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(statuses[20]).toBe(429);
  });

  it("回环来源批量写不触发公网限流", async () => {
    const sessionId = await createSession();
    vi.spyOn(sessionManager, "submitQueued").mockResolvedValue({
      completion: Promise.resolve([]),
    });

    for (let index = 0; index < 30; index += 1) {
      const response = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text: `本机消息 ${index}` }),
      });
      expect(response.status).toBe(200);
    }
  });
});

async function createSession(): Promise<string> {
  const res = await app.request("/api/v1/external/sessions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
