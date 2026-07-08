import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { sessionManager } from "../bridge/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

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
  it("POST chat 立即 accepted,并以 origin=external 入队 sendMessage", async () => {
    const sessionId = await createSession();
    const submit = vi.spyOn(sessionManager, "submit").mockResolvedValueOnce([]);
    const res = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "请继续写" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
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

  it("会话不存在时返回 NOT_FOUND 且不提交 sendMessage", async () => {
    const submit = vi.spyOn(sessionManager, "submit");
    const res = await app.request("/api/v1/external/sessions/missing-chat/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "请继续写" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(submit).not.toHaveBeenCalled();
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
