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
    const fullDraftBody = await fullDraft.json() as { status: string; docVersion: number; seq: number };
    expect(fullDraftBody).toMatchObject({ status: "committed", docVersion: 1 });
    expect(fullDraftBody.seq).toBeGreaterThan(0);

    const conflict = await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "VERSION_CONFLICT", expected: 0, actual: 1, seq: expect.any(Number) });

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
    const reviewBody = await review.json() as { status: string; count: number; patchIds: string[]; seq: number };
    expect(reviewBody.status).toBe("review");
    expect(reviewBody.count).toBeGreaterThan(0);
    expect(reviewBody.patchIds.length).toBe(reviewBody.count);
    expect(reviewBody.seq).toBeGreaterThan(fullDraftBody.seq);

    const afterProposal = sessionManager.frameLog.readFrom(sessionId, reviewBody.seq).frames;
    expect(afterProposal.some((entry) => entry.frame.kind === "docCommitted")).toBe(false);

    const pending = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "第二段。" }],
    });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ code: "REVIEW_PENDING", seq: expect.any(Number) });
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

  it("0 hunk validation 失败不残留空 agent 气泡", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });

    const noop = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "strReplace", old: "第一段。", new: "第一段。" }],
    });

    expect(noop.status).toBe(400);
    expect(await noop.json()).toMatchObject({ code: "VALIDATION" });
    const session = await getOrRestoreSession(sessionId);
    expect(session?.chatHistory.filter((message) => message.role.kind === "agent" && message.parts.length === 0)).toHaveLength(0);
  });

  it("把调用方身份编入外部提案的 agent 消息 id", async () => {
    const claudeSessionId = await createSession();
    await propose(claudeSessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    await propose(claudeSessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "Claude 提案。" }],
    }, { "X-QA-Client": "claudecode" });
    const claudeSession = await getOrRestoreSession(claudeSessionId);
    const claudeMessage = claudeSession?.chatHistory.find((message) => message.role.kind === "agent");
    expect(claudeMessage?.id).toMatch(/^external-claudecode-[0-9a-f-]{36}$/);

    const agentSessionId = await createSession();
    await propose(agentSessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。" }],
    });
    await propose(agentSessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "appendSection", markdown: "默认提案。" }],
    });
    const agentSession = await getOrRestoreSession(agentSessionId);
    const agentMessage = agentSession?.chatHistory.find((message) => message.role.kind === "agent");
    expect(agentMessage?.id).toMatch(/^external-agent-[0-9a-f-]{36}$/);
  });

  it("insertAfterLine 把块间空行归到上一块", async () => {
    const sessionId = await createSession();
    await propose(sessionId, {
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "第一段。\n\n第二段。\n\n第三段。" }],
    });

    const inserted = await propose(sessionId, {
      expectedDocVersion: 1,
      ops: [{ kind: "insertAfterLine", line: 2, markdown: "插入段。" }],
    });

    expect(inserted.status).toBe(200);
    const session = await getOrRestoreSession(sessionId);
    expect(session).toBeTruthy();
    expect(session!.docDraftCandidateDoc).toBeTruthy();
    const markdown = session!.docDraftCandidateDoc!.content.map((block) => JSON.stringify(block)).join("\n");
    expect(markdown.indexOf("插入段。")).toBeGreaterThan(markdown.indexOf("第一段。"));
    expect(markdown.indexOf("插入段。")).toBeLessThan(markdown.indexOf("第二段。"));
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

async function propose(sessionId: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return app.request(`/api/v1/external/sessions/${sessionId}/proposals`, {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
