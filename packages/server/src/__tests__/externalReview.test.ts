import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToPm } from "@qingagent/pm-schema";
import { app } from "../app";
import { getOrRestoreSession, sessionManager } from "../gateway/bridgeHandler";
import { SessionActorQueueFullError } from "../gateway/sessionActor";
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
    libraryId: "00000000-0000-4000-8000-000000000001",
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
  it("render-model 返回 DocDiffReady 完整渲染字段并拒绝未知 format", async () => {
    const { sessionId, patchIds } = await createPendingReview();
    const response = await request(
      `/sessions/${sessionId}/review?format=render-model`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown> & {
      suggestions: Array<Record<string, any>>;
    };
    expect(body).toMatchObject({
      sessionId,
      docVersion: 1,
      state: "pendingReview",
      agentBusy: false,
      baseVersion: 1,
      previewDoc: { type: "doc", attrs: { schemaVersion: 1 } },
      editedDoc: { type: "doc", attrs: { schemaVersion: 1 } },
      suggestions: expect.arrayContaining([
        expect.objectContaining({
          id: patchIds[0],
          anchor: expect.objectContaining({ textHash: expect.any(String) }),
          patch: { kind: "prosemirror_steps", steps: expect.any(Array) },
          preview: {
            deleteText: expect.stringContaining("旧"),
            insertText: expect.stringContaining("新"),
          },
          diffHunk: expect.objectContaining({
            beforeText: expect.stringContaining("旧"),
            afterText: expect.stringContaining("新"),
          }),
        }),
      ]),
    });
    expect(body.suggestions[0]?.anchor).toHaveProperty("textHash");

    const invalid = await request(`/sessions/${sessionId}/review?format=detail`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION" });
  });

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

  it("review 三路由在租约期仅放行匹配 turnId，无 turnId 被拦且异主返回 LOCK_LOST", async () => {
    const { sessionId, patchIds } = await createPendingReview();
    const patchId = patchIds[0]!;
    expect((await signal(sessionId, "begin", "turn-review")).status).toBe(200);
    const session = await getOrRestoreSession(sessionId);
    session!.annotationGroups = [{
      id: "annotation-holder",
      summary: "持约批注",
      note: "仅用于验证 holder 路由",
      origin: "source-check",
      suggestion: "忽略",
      severity: "info",
      status: "reviewing",
      anchors: [],
    }];
    const routes = [
      {
        path: `/sessions/${sessionId}/review/verdicts`,
        body: { expectedDocVersion: 1, patchId, verdict: "accepted" },
      },
      {
        path: `/sessions/${sessionId}/review/commit`,
        body: { expectedDocVersion: 1, action: "commit" },
      },
      {
        path: `/sessions/${sessionId}/review/annotations/ignore`,
        body: {
          expectedDocVersion: 1,
          annotationIds: ["annotation-holder"],
        },
      },
    ];
    for (const route of routes) {
      const noTurn = await request(route.path, {
        method: "POST",
        body: JSON.stringify(route.body),
      });
      expect(noTurn.status).toBe(409);
      expect(await noTurn.json()).toMatchObject({ code: "AGENT_BUSY" });

      const wrongTurn = await request(route.path, {
        method: "POST",
        body: JSON.stringify({ ...route.body, turnId: "turn-other" }),
      });
      expect(wrongTurn.status).toBe(409);
      expect(await wrongTurn.json()).toMatchObject({ code: "LOCK_LOST" });
    }

    const marked = await request(`/sessions/${sessionId}/review/verdicts`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        patchId,
        verdict: "accepted",
        turnId: "turn-review",
      }),
    });
    expect(marked.status).toBe(200);

    const ignored = await request(
      `/sessions/${sessionId}/review/annotations/ignore`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedDocVersion: 1,
          annotationIds: ["annotation-holder"],
          turnId: "turn-review",
        }),
      },
    );
    expect(ignored.status).toBe(200);

    const committed = await request(`/sessions/${sessionId}/review/commit`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        action: "commit",
        turnId: "turn-review",
      }),
    });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({
      status: "reviewed",
      docVersion: 2,
    });
  });

  it.each(["commit", "accept_all", "reject_all"] as const)(
    "%s 只做审阅结算，返回后会话空闲且可立即写入",
    async (action) => {
      const { sessionId, patchIds } = await createPendingReview();
      if (action === "commit") {
        const marked = await request(`/sessions/${sessionId}/review/verdicts`, {
          method: "POST",
          body: JSON.stringify({
            expectedDocVersion: 1,
            patchId: patchIds[0],
            verdict: "rejected",
          }),
        });
        expect(marked.status).toBe(200);
      }
      const submitQueued = vi.spyOn(sessionManager, "submitQueued");

      const committed = await request(`/sessions/${sessionId}/review/commit`, {
        method: "POST",
        body: JSON.stringify({ expectedDocVersion: 1, action }),
      });

      expect(committed.status).toBe(200);
      const committedBody = await committed.json() as {
        docVersion: number;
        acceptedCount: number;
        rejectedCount: number;
        outcomeQueued: boolean;
      };
      expect(committedBody).toMatchObject({
        status: "reviewed",
        remainingCount: 0,
        outcomeQueued: false,
      });
      expect(
        submitQueued.mock.calls.some(
          ([, input]) => input.command.kind === "submitReviewOutcome",
        ),
      ).toBe(false);
      expect(sessionManager.isSessionBusy(sessionId)).toBe(false);

      const read = await request(`/sessions/${sessionId}/doc?format=pm`);
      expect(read.status).toBe(200);
      const snapshot = await read.json() as {
        agentBusy: boolean;
        docVersion: number;
        contentHash: string;
      };
      expect(snapshot.agentBusy).toBe(false);

      if (action === "reject_all") {
        const updated = await request(`/sessions/${sessionId}/doc`, {
          method: "PUT",
          body: JSON.stringify({
            expectedDocumentSnapshot: snapshot.docVersion,
            baseContentHash: snapshot.contentHash,
            clientMutationId: "external-post-review-write",
            doc: markdownToPm("# 标题\n\n裁决后立即直写。"),
          }),
        });
        expect(updated.status).toBe(200);
        expect(await updated.json()).toMatchObject({ ok: true });
      } else {
        const proposed = await request(`/sessions/${sessionId}/proposals`, {
          method: "POST",
          body: JSON.stringify({
            expectedDocVersion: snapshot.docVersion,
            ops: [{ kind: "appendSection", markdown: "裁决后立即提案。" }],
          }),
        });
        expect(proposed.status).toBe(200);
        expect(await proposed.json()).toMatchObject({ status: "review" });
      }
    },
  );

  it("actor 忙时 doc 与 review 读取都返回 agentBusy=true", async () => {
    const { sessionId } = await createPendingReview();
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = sessionManager.runExclusive(sessionId, async function* () {
      markStarted();
      await gate;
    });
    await started;

    try {
      const docResponse = await request(`/sessions/${sessionId}/doc?format=pm`);
      const reviewResponse = await request(`/sessions/${sessionId}/review`);
      expect(docResponse.status).toBe(200);
      expect(reviewResponse.status).toBe(200);
      expect(await docResponse.json()).toMatchObject({ agentBusy: true });
      expect(await reviewResponse.json()).toMatchObject({ agentBusy: true });
    } finally {
      release();
      await active;
    }

    const idle = await request(`/sessions/${sessionId}/doc?format=pm`);
    expect(await idle.json()).toMatchObject({ agentBusy: false });
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

  it("审阅命令排队期间文档版本变化时不写入 verdict", async () => {
    const { sessionId, patchIds } = await createPendingReview();
    const patchId = patchIds[0]!;
    const session = await getOrRestoreSession(sessionId);
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const queuedWrite = sessionManager.runExclusive(sessionId, async function* () {
      markWriteStarted();
      await writeGate;
      session!.docVersion += 1;
    });
    await writeStarted;

    const runExclusive = vi.spyOn(sessionManager, "runExclusive");
    const verdictResponse = request(`/sessions/${sessionId}/review/verdicts`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        patchId,
        verdict: "accepted",
      }),
    });
    await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1));
    releaseWrite();
    await queuedWrite;

    const response = await verdictResponse;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      expected: 1,
      actual: 2,
    });
    expect(session!.suggestions.get(patchId)?.suggestion.status).toBe("reviewing");
    expect(session!.patchVerdicts.has(patchId)).toBe(false);
  });

  it("review verdict 在排队后租约出现时于临界区复查并拒绝", async () => {
    const { sessionId, patchIds } = await createPendingReview();
    const patchId = patchIds[0]!;
    const session = await getOrRestoreSession(sessionId);
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const queuedWrite = sessionManager.runExclusive(sessionId, async function* () {
      markWriteStarted();
      await writeGate;
    });
    await writeStarted;

    const runExclusive = vi.spyOn(sessionManager, "runExclusive");
    const verdictResponse = request(`/sessions/${sessionId}/review/verdicts`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        patchId,
        verdict: "accepted",
      }),
    });
    await vi.waitFor(() => expect(runExclusive).toHaveBeenCalledTimes(1));
    session!.externalBusyLease = {
      principalId: "external:test-instance",
      turnId: "turn-arrived-while-queued",
      expiresAt: Date.now() + 60_000,
      startedFromEmpty: false,
      directCommitCount: 0,
    };
    releaseWrite();
    await queuedWrite;

    const response = await verdictResponse;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "AGENT_BUSY" });
    expect(session!.suggestions.get(patchId)?.suggestion.status).toBe("reviewing");
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
    vi.spyOn(sessionManager, "runExclusive")
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

function signal(
  sessionId: string,
  action: "begin" | "end" | "heartbeat",
  turnId: string,
): Promise<Response> {
  return request(`/sessions/${sessionId}/turn-signal`, {
    method: "POST",
    body: JSON.stringify({ action, turnId }),
  });
}
