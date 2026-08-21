import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalErrorResponse,
  ExternalProposalResponse,
  ExternalSessionCreateResponse,
} from "../../../contract-ts/src/ExternalApi";
import { app } from "../app";
import { getSession, sessionManager } from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const databaseEnv = vi.hoisted(() => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:/tmp/qingagent-external-export-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  return { original };
});

let tempDir = "";
let token = "";

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-external-export-"));
  await startExternalInstance({
    port: 52341,
    version: "0.1.5",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: path.join(tempDir, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await rm(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (databaseEnv.original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseEnv.original;
});

describe("GET /api/v1/external/sessions/:id/export", () => {
  it("冷恢复会话后返回带下载头的二进制导出", async () => {
    const { sessionId } = await createSession();
    const proposal = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 0,
        ops: [{ kind: "fullDraft", markdown: "# 外部导出\n\n正文内容。" }],
      }),
    });
    expect(proposal.status).toBe(200);
    await expect(proposal.json() as Promise<ExternalProposalResponse>).resolves.toMatchObject({
      status: "committed",
    });
    await sessionManager.disposeSession(sessionId);

    const response = await request(`/sessions/${sessionId}/export?format=markdown`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("正文内容");
  });

  it("非法格式与空文档分别返回 externalError 风格 400/409", async () => {
    const { sessionId } = await createSession();
    const invalid = await request(`/sessions/${sessionId}/export?format=md`);
    expect(invalid.status).toBe(400);
    await expect(invalid.json() as Promise<ExternalErrorResponse>).resolves.toMatchObject({
      code: "VALIDATION",
      nextStep: expect.any(String),
    });

    const empty = await request(`/sessions/${sessionId}/export?format=txt`);
    expect(empty.status).toBe(409);
    await expect(empty.json() as Promise<ExternalErrorResponse>).resolves.toEqual({
      error: "当前会话没有可导出的文档",
      code: "CONFLICT",
      nextStep: "先写入文档内容，再重新导出",
    });
  });

  it("写入后清空的空稿导出被阻断(与客户端「还没有可导出的内容」同款)", async () => {
    const { sessionId } = await createSession();
    const write = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 0,
        ops: [{ kind: "fullDraft", markdown: "# 待清空\n\n正文。" }],
      }),
    });
    expect(write.status).toBe(200);
    // 模拟用户清空正文后的稿:doc 仍存在(canonical),但可见字数为 0
    const session = getSession(sessionId);
    expect(session).toBeTruthy();
    session!.doc = { type: "doc", content: [{ type: "paragraph" }] } as never;

    const response = await request(`/sessions/${sessionId}/export?format=txt`);
    expect(response.status).toBe(409);
    await expect(response.json() as Promise<ExternalErrorResponse>).resolves.toEqual({
      error: "还没有可导出的内容",
      code: "CONFLICT",
      nextStep: "先写入文档内容，再重新导出",
    });
  });
});

async function createSession(): Promise<ExternalSessionCreateResponse> {
  const response = await request("/sessions", { method: "POST", body: "{}" });
  expect(response.status).toBe(200);
  return response.json() as Promise<ExternalSessionCreateResponse>;
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/v1/external${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}
