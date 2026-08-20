import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalAnnotationCreateRequest,
  ExternalAnnotationCreateResponse,
  ExternalErrorResponse,
  ExternalProposalResponse,
  ExternalReviewListResponse,
  ExternalSessionCreateResponse,
  ExternalTurnSignalResponse,
} from "../../../contract-ts/src/ExternalApi";
import { app } from "../app";
import { sessionManager } from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const databaseEnv = vi.hoisted(() => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:/tmp/qingagent-external-annotations-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  return { original };
});

let tempDir = "";
let token = "";

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "qa-external-annotations-"));
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

describe("POST /api/v1/external/sessions/:id/review/annotations", () => {
  it("持约写入逐字锚定批注并向 frame log 推送权威变化", async () => {
    const { sessionId, docVersion } = await createDocument();
    const turnId = "review-turn-success";
    await beginLease(sessionId, turnId);

    const response = await postAnnotations(sessionId, {
      turnId,
      expectedDocVersion: docVersion,
      groups: [{
        summary: "外部事实核查",
        note: "需要按插件审查结果核对。",
        origin: "source-check",
        severity: "warn",
        suggestion: "插件改写建议",
        anchors: [{ find: "需要逐字锚定的正文" }],
      }],
    });

    expect(response.status).toBe(200);
    const body = await response.json() as ExternalAnnotationCreateResponse;
    expect(body).toMatchObject({
      status: "created",
      docVersion,
      groupCount: 1,
      anchorCount: 1,
      seq: expect.any(Number),
      annotations: [{
        origin: "external-plugin",
        summary: "外部事实核查",
        note: "需要按插件审查结果核对。",
        suggestion: "插件改写建议",
        severity: "warn",
        status: "reviewing",
        anchors: [{ quote: "需要逐字锚定的正文" }],
      }],
    });

    const logged = sessionManager.frameLog.readFrom(sessionId, 0).frames
      .map((entry) => entry.frame);
    expect(logged).toContainEqual({
      kind: "annotationGroupsReady",
      data: {
        groups: expect.arrayContaining([
          expect.objectContaining({ origin: "external-plugin" }),
        ]),
        replacedOrigins: ["external-plugin"],
      },
    });

    const reviewResponse = await request(`/sessions/${sessionId}/review`);
    const review = await reviewResponse.json() as ExternalReviewListResponse;
    expect(review.annotations).toHaveLength(1);
    expect(review.annotations[0]?.origin).toBe("external-plugin");
  });

  it("版本漂移、丢锁与找不到逐字锚点返回明确错误且不覆盖旧批注", async () => {
    const { sessionId, docVersion } = await createDocument();
    const turnId = "review-turn-errors";
    await beginLease(sessionId, turnId);

    const versionConflict = await postAnnotations(sessionId, annotationRequest(
      turnId,
      docVersion - 1,
      "需要逐字锚定的正文",
    ));
    expect(versionConflict.status).toBe(409);
    await expect(versionConflict.json()).resolves.toMatchObject({
      code: "VERSION_CONFLICT",
      expected: docVersion - 1,
      actual: docVersion,
    });

    const missingAnchor = await postAnnotations(sessionId, annotationRequest(
      turnId,
      docVersion,
      "文档中绝对不存在的逐字锚点",
    ));
    expect(missingAnchor.status).toBe(400);
    await expect(missingAnchor.json() as Promise<ExternalErrorResponse>).resolves.toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("当前文档中未找到精确文本"),
    });

    const lostLock = await postAnnotations(sessionId, annotationRequest(
      "另一个回合",
      docVersion,
      "需要逐字锚定的正文",
    ));
    expect(lostLock.status).toBe(409);
    await expect(lostLock.json() as Promise<ExternalErrorResponse>).resolves.toMatchObject({
      code: "LOCK_LOST",
    });

    const review = await (await request(`/sessions/${sessionId}/review`)).json() as
      ExternalReviewListResponse;
    expect(review.annotations).toEqual([]);
  });
});

function annotationRequest(
  turnId: string,
  expectedDocVersion: number,
  find: string,
): ExternalAnnotationCreateRequest {
  return {
    turnId,
    expectedDocVersion,
    groups: [{
      summary: "插件审查",
      note: "插件发现问题。",
      origin: "custom-review",
      anchors: [{ find }],
    }],
  };
}

async function createDocument(): Promise<{ sessionId: string; docVersion: number }> {
  const createdResponse = await request("/sessions", { method: "POST", body: "{}" });
  expect(createdResponse.status).toBe(200);
  const { sessionId } = await createdResponse.json() as ExternalSessionCreateResponse;
  const proposalResponse = await request(`/sessions/${sessionId}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "# 批注测试\n\n这里是需要逐字锚定的正文。" }],
    }),
  });
  expect(proposalResponse.status).toBe(200);
  const proposal = await proposalResponse.json() as ExternalProposalResponse;
  if (proposal.status !== "committed") throw new Error("expected committed document");
  return { sessionId, docVersion: proposal.docVersion };
}

async function beginLease(sessionId: string, turnId: string): Promise<void> {
  const response = await request(`/sessions/${sessionId}/turn-signal`, {
    method: "POST",
    body: JSON.stringify({ action: "begin", turnId }),
  });
  expect(response.status).toBe(200);
  await expect(response.json() as Promise<ExternalTurnSignalResponse>).resolves.toMatchObject({
    ok: true,
    active: true,
  });
}

function postAnnotations(
  sessionId: string,
  body: ExternalAnnotationCreateRequest,
): Promise<Response> {
  return request(`/sessions/${sessionId}/review/annotations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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
