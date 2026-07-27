import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import {
  SessionActorCommandError,
  SessionActorQueueFullError,
} from "../gateway/sessionActor";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";

const dirs: string[] = [];
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-review-test-"));
  dirs.push(dir);
  await startExternalInstance({
    port: 52341,
    version: "test",
    filePath: path.join(dir, "instance.json"),
  });
  token = getExternalToken() ?? "";
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("external review", () => {
  it("读取 diff、逐条表态并提交，事件流包含 docCommitted", async () => {
    const { sessionId, patchIds } = await createPendingReview();
    const patchId = patchIds[0]!;

    const list = await getReview(sessionId);
    expect(list).toMatchObject({
      sessionId,
      docVersion: 1,
      state: "pendingReview",
      agentBusy: false,
      patches: expect.arrayContaining([
        expect.objectContaining({
          id: patchId,
          status: "reviewing",
          beforeText: expect.stringContaining("旧"),
          afterText: expect.stringContaining("新"),
          conflict: null,
        }),
      ]),
    });

    const detailResponse = await request(
      `/sessions/${sessionId}/review/patches/${patchId}`,
    );
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      sessionId,
      patch: {
        id: patchId,
        anchor: { blockId: expect.any(String), quote: expect.any(String) },
        diff: {
          op: expect.any(String),
          blockPath: expect.any(Array),
          beforeText: expect.stringContaining("旧"),
          afterText: expect.stringContaining("新"),
        },
      },
    });

    const marked = await request(`/sessions/${sessionId}/review/verdicts`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        patchId,
        verdict: "accepted",
      }),
    });
    expect(marked.status).toBe(200);
    const markedBody = await marked.json() as { seq: number };
    expect(markedBody).toMatchObject({
      status: "marked",
      docVersion: 1,
      patchIds: [patchId],
      verdict: "accepted",
      seq: expect.any(Number),
    });

    const committed = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "commit" }),
    });
    expect(committed.status).toBe(200);
    const committedBody = await committed.json() as {
      docVersion: number;
      acceptedCount: number;
      rejectedCount: number;
      remainingCount: number;
      outcomeQueued: boolean;
      seq: number;
    };
    expect(committedBody).toMatchObject({
      status: "reviewed",
      docVersion: 2,
      acceptedCount: expect.any(Number),
      rejectedCount: 0,
      remainingCount: 0,
      outcomeQueued: false,
      seq: expect.any(Number),
    });
    expect(committedBody.acceptedCount).toBeGreaterThan(0);
    const committedFrames = sessionManager.frameLog.readFrom(
      sessionId,
      markedBody.seq,
    ).frames;
    expect(
      committedFrames.some((entry) => entry.frame.kind === "docCommitted"),
    ).toBe(true);
  });

  it("全量拒绝复用 reviewOutcome 命令并退出 pendingReview", async () => {
    const { sessionId } = await createPendingReview();
    const originalSubmitQueued = sessionManager.submitQueued.bind(sessionManager);
    const submitQueued = vi.spyOn(sessionManager, "submitQueued").mockImplementation(
      async (targetSessionId, input) => {
        if (input.command.kind === "submitReviewOutcome") {
          return { completion: Promise.resolve([]) };
        }
        return originalSubmitQueued(targetSessionId, input);
      },
    );

    const rejected = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });

    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      status: "reviewed",
      docVersion: 1,
      acceptedCount: 0,
      rejectedCount: expect.any(Number),
      remainingCount: 0,
      outcomeQueued: true,
      outcome: {
        acceptedCount: 0,
        rejectedCount: expect.any(Number),
        hunks: expect.arrayContaining([
          expect.objectContaining({ verdict: "rejected" }),
        ]),
      },
    });
    expect(
      submitQueued.mock.calls.some(
        ([, input]) => input.command.kind === "submitReviewOutcome",
      ),
    ).toBe(true);
    const session = await getOrRestoreSession(sessionId);
    expect(session?.docState.kind).toBe("editing");
  });

  it("拒绝反馈队列准入失败时返回 429，不再提前声明 outcomeQueued", async () => {
    const { sessionId } = await createPendingReview();
    const originalSubmitQueued = sessionManager.submitQueued.bind(sessionManager);
    vi.spyOn(sessionManager, "submitQueued").mockImplementation(
      async (targetSessionId, input) => {
        if (input.command.kind === "submitReviewOutcome") {
          throw new SessionActorQueueFullError(64);
        }
        return originalSubmitQueued(targetSessionId, input);
      },
    );

    const rejected = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect(await rejected.json()).toMatchObject({
      code: "RATE_LIMITED",
      error: "会话命令队列已满",
    });
  });

  it("拒绝反馈 Actor 执行失败时调用方收到失败响应", async () => {
    const { sessionId } = await createPendingReview();
    const originalSubmitQueued = sessionManager.submitQueued.bind(sessionManager);
    vi.spyOn(sessionManager, "submitQueued").mockImplementation(
      async (targetSessionId, input) => {
        if (input.command.kind === "submitReviewOutcome") {
          return {
            completion: Promise.reject(new SessionActorCommandError(
              "Session actor command failed",
              new Error("model handler rejected"),
              [],
            )),
          };
        }
        return originalSubmitQueued(targetSessionId, input);
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const rejected = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "reject_all" }),
    });

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      code: "AGENT_BUSY",
      error: "审查结果反馈未完成，请稍后重试",
    });
  });

  it("版本冲突、agent busy、无待审查和缺失 patch 都返回内建错误码", async () => {
    const { sessionId, patchIds } = await createPendingReview();

    const conflict = await request(`/sessions/${sessionId}/review/verdicts`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 0,
        patchId: patchIds[0],
        verdict: "accepted",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      expected: 0,
      actual: 1,
    });

    const session = await getOrRestoreSession(sessionId);
    session!.streamId = "busy-review";
    const busy = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "AGENT_BUSY" });
    session!.streamId = null;

    const missing = await request(
      `/sessions/${sessionId}/review/patches/not-found`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });

    await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 1, action: "accept_all" }),
    });
    const noReview = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedDocVersion: 2, action: "reject_all" }),
    });
    expect(noReview.status).toBe(409);
    expect(await noReview.json()).toMatchObject({
      code: "VALIDATION",
      error: "当前没有待审查修改",
      nextStep: expect.stringContaining("qa review list"),
    });
  });

  it("读取并忽略批注，事件 allowlist 保留 annotationGroupsReady", async () => {
    const sessionId = await createDocument();
    const session = await getOrRestoreSession(sessionId);
    session!.annotationGroups = [{
      id: "annotation-1",
      summary: "事实口径冲突",
      note: "正文与材料数字不一致",
      origin: "source-check",
      suggestion: "按材料中的 120 亿元修改",
      severity: "error",
      status: "reviewing",
      anchors: [{
        blockId: "block-1",
        pmFrom: 1,
        pmTo: 4,
        quote: "旧文",
        textHash: "hash",
      }],
    }];

    const list = await getReview(sessionId);
    expect(list.annotations).toEqual([
      expect.objectContaining({
        id: "annotation-1",
        severity: "error",
        status: "reviewing",
        suggestion: "按材料中的 120 亿元修改",
      }),
    ]);
    const detail = await request(
      `/sessions/${sessionId}/review/annotations/annotation-1`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      annotation: {
        id: "annotation-1",
        anchors: [expect.objectContaining({ quote: "旧文" })],
      },
    });

    const ignored = await request(
      `/sessions/${sessionId}/review/annotations/ignore`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedDocVersion: 1,
          annotationIds: ["annotation-1"],
        }),
      },
    );
    expect(ignored.status).toBe(200);
    const ignoredBody = await ignored.json() as { seq: number };
    expect(ignoredBody).toMatchObject({
      status: "ignored",
      annotationIds: ["annotation-1"],
      remainingAnnotationCount: 0,
      seq: expect.any(Number),
    });
    expect(
      sessionManager.frameLog.readFrom(sessionId, ignoredBody.seq - 1).frames
        .some((entry) => entry.frame.kind === "annotationGroupsReady"),
    ).toBe(true);
  });

  it.each([
    {
      name: "verdicts",
      path: (sessionId: string) => `/sessions/${sessionId}/review/verdicts`,
      body: (patchId: string) => ({
        expectedDocVersion: 1,
        patchId,
        verdict: "accepted",
      }),
    },
    {
      name: "commit",
      path: (sessionId: string) => `/sessions/${sessionId}/review/commit`,
      body: () => ({ expectedDocVersion: 1, action: "commit" }),
    },
    {
      name: "annotations/ignore",
      path: (sessionId: string) => `/sessions/${sessionId}/review/annotations/ignore`,
      body: () => ({
        expectedDocVersion: 1,
        annotationIds: ["annotation-queue-full"],
      }),
    },
  ])("$name 队列满时返回 429 和 Retry-After", async ({ path, body }) => {
    const { sessionId, patchIds } = await createPendingReview();
    const session = await getOrRestoreSession(sessionId);
    session!.annotationGroups = [{
      id: "annotation-queue-full",
      summary: "队列满测试批注",
      note: "用于进入 ignoreAnnotationGroups 提交路径",
      origin: "source-check",
      suggestion: "稍后重试",
      severity: "warn",
      status: "reviewing",
      anchors: [],
    }];
    vi.spyOn(sessionManager, "submit")
      .mockRejectedValue(new SessionActorQueueFullError(64));

    const response = await request(path(sessionId), {
      method: "POST",
      body: JSON.stringify(body(patchIds[0]!)),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
      error: "会话命令队列已满",
    });
  });
});

async function createDocument(): Promise<string> {
  const create = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const { sessionId } = await create.json() as { sessionId: string };
  const initial = await request(`/sessions/${sessionId}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      expectedDocVersion: 0,
      ops: [{ kind: "fullDraft", markdown: "# 标题\n\n第一段旧文。" }],
    }),
  });
  expect(initial.status).toBe(200);
  return sessionId;
}

async function createPendingReview(): Promise<{
  sessionId: string;
  patchIds: string[];
}> {
  const sessionId = await createDocument();
  const proposal = await request(`/sessions/${sessionId}/proposals`, {
    method: "POST",
    body: JSON.stringify({
      expectedDocVersion: 1,
      ops: [{ kind: "strReplace", old: "旧文", new: "新文" }],
    }),
  });
  expect(proposal.status).toBe(200);
  const body = await proposal.json() as { patchIds: string[] };
  expect(body.patchIds.length).toBeGreaterThan(0);
  return { sessionId, patchIds: body.patchIds };
}

async function getReview(sessionId: string): Promise<{
  sessionId: string;
  docVersion: number;
  state: string;
  agentBusy: boolean;
  patches: Array<Record<string, unknown>>;
  annotations: Array<Record<string, unknown>>;
}> {
  const response = await request(`/sessions/${sessionId}/review`);
  expect(response.status).toBe(200);
  return response.json();
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
