import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { getExternalToken, startExternalInstance, stopExternalInstance } from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-chatlog-test-"));
  dirs.push(dir);
  await startExternalInstance({ port: 52341, version: "test", filePath: path.join(dir, "instance.json") });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external chat log", () => {
  it("返回 chatHistory 的外部精简形并支持 limit", async () => {
    const sessionId = await createSession();
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    session!.chatHistory.push(
      {
        id: "m-user",
        role: { kind: "user" },
        ts: "2026-07-09T01:00:00.000Z",
        chips: null,
        parts: [
          { kind: "text", data: { body: "请补一段" } },
          { kind: "thinking", data: { id: "think-1", steps: ["internal"] } },
          { kind: "image", data: { label: "图", src: "local://image", srcKind: "url", sourceUrl: null, width: null, height: null } },
        ],
      },
      {
        id: "m-agent",
        role: { kind: "agent" },
        ts: "2026-07-09T01:00:01.000Z",
        chips: null,
        parts: [
          { kind: "code", data: { lang: "markdown", body: "## 新段落" } },
          {
            kind: "toolCall",
            data: {
              id: "tc-1",
              name: "editDraft",
              render: { kind: "chatInline" },
              status: { kind: "running", data: { progressPct: null, etaSec: null } },
              body: { kind: "generic", data: { argsJson: "{}" } },
              result: null,
            },
          },
          { kind: "patchSummary", data: { count: 2, hunkIds: ["h1", "h2"] } },
          { kind: "reviewOutcome", data: { acceptedCount: 1, rejectedCount: 1, hunks: [] } },
          { kind: "citation", data: { sourceRef: { domain: { kind: "webpage" }, id: "w1" }, anchor: "a1" } },
          { kind: "askUserAnswerCard", data: { toolCallId: "ask-1", title: "确认", items: [] } },
        ],
      },
    );

    const res = await app.request(`/api/v1/external/sessions/${sessionId}/chat`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; messages: Array<Record<string, unknown>> };
    expect(body.sessionId).toBe(sessionId);
    expect(body.messages).toEqual([
      {
        id: "m-user",
        role: { kind: "user" },
        ts: "2026-07-09T01:00:00.000Z",
        text: "请补一段\n[图片]",
      },
      {
        id: "m-agent",
        role: { kind: "agent" },
        ts: "2026-07-09T01:00:01.000Z",
        text: "## 新段落\n[工具调用:editDraft]\n[修改建议 2 处]\n[审阅结果]\n[引用]\n[用户答复]",
      },
    ]);
    expect(body.messages[0]).not.toHaveProperty("parts");
    expect(body.messages[0]).not.toHaveProperty("chips");

    const limited = await app.request(`/api/v1/external/sessions/${sessionId}/chat?limit=1`, { headers: authHeaders() });
    expect(limited.status).toBe(200);
    const limitedBody = await limited.json() as { messages: Array<{ id: string }> };
    expect(limitedBody.messages.map((message) => message.id)).toEqual(["m-agent"]);
  });

  it("会话不存在时返回 SESSION_NOT_FOUND", async () => {
    const res = await app.request("/api/v1/external/sessions/missing-chatlog/chat", { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "SESSION_NOT_FOUND" });
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
