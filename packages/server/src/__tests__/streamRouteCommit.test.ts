import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame } from "@qingagent/contract-ts";
import { MAX_COMMAND_ARRAY_LENGTH } from "@qingagent/contract-ts/schemas";
import { app } from "../app";
import {
  forgetSession,
  getSession,
  handleCommand,
  sessionManager,
} from "../gateway/bridgeHandler";
import { InMemoryFrameLog } from "../gateway/frameLog";
import type { LoggedFrame } from "../gateway/frameLog";
import { SessionManager } from "../gateway/sessionManager";
import {
  SessionActorCommandError,
  type HandleCommandFn,
} from "../gateway/sessionActor";
import {
  SessionDeletedError,
  SessionDeletionInProgressError,
} from "../gateway/sessionErrors";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe("POST /api/v1/commit", () => {
  const sessionIds: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const sessionId of sessionIds.splice(0)) {
      await sessionManager.disposeSession(sessionId);
    }
  });

  async function startPersistedSession(sessionId: string) {
    sessionIds.push(sessionId);
    await collectFrames(handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { sessionId, template: null } } },
    }));
    const session = getSession(sessionId);
    if (!session) throw new Error("missing session");
    await session.threadCreatePromise;
    return session;
  }

  it("拒绝不受信 Origin 的 commit 写入口", async () => {
    const res = await app.request("/api/v1/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.test",
      },
      body: JSON.stringify({ sessionId: "csrf-commit", patchIds: ["p-1"] }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "跨站请求被拒绝" });
  });

  it("把 commit 产生的帧写入 FrameLog，并返回带 seq 的帧", async () => {
    const sessionId = "commit-frame-log-test";
    await startPersistedSession(sessionId);

    const res = await request("POST", "/api/v1/commit", {
      sessionId,
      acceptReviewBatchIds: ["already-resolved-review-batch"],
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      {
        seq: 1,
        frame: {
          kind: "docStateChanged",
          data: {
            state: { kind: "empty" },
            activeOverlay: null,
            agentBusy: false,
            reviewCompletion: "noop",
          },
        },
      },
    ]);
    const logged = sessionManager.frameLog.readFrom(sessionId, 0).frames;
    expect(logged.map(({ seq, frame }) => ({ seq, frame }))).toEqual(json);
  });

  it("sendMessage 运行中 POST /commit 经同一 actor 排队在后，不发生状态交错", async () => {
    const order: string[] = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleCommand: HandleCommandFn = async function* (command) {
      if (command.kind === "sendMessage") {
        order.push("send:start");
        started();
        await releasePromise;
        order.push("send:end");
        yield { kind: "sessionMeta", data: { sessionId: "route-serial", title: "send" } };
        return;
      }
      if (command.kind === "commitReviewGroups") {
        order.push("commit");
        yield { kind: "sessionMeta", data: { sessionId: "route-serial", title: "commit" } };
      }
    };
    const abortSession = vi.fn();
    const manager = new SessionManager({
      frameLog: new InMemoryFrameLog(),
      handleCommand,
      abortSession,
      cleanupSession: vi.fn(),
    });
    const submitSpy = vi.spyOn(sessionManager, "submit").mockImplementation((sessionId, input) =>
      manager.submit(sessionId, input));

    const send = manager.submit("route-serial", {
      command: {
        kind: "sendMessage",
        data: {
          sessionId: "route-serial",
          text: "running",
          mentions: [],
          skills: [],
          chips: [],
          fileIds: [],
        },
      },
    });
    await startedPromise;
    const pendingResponse = request("POST", "/api/v1/commit", {
      sessionId: "route-serial",
      acceptReviewBatchIds: ["batch-1"],
    });
    for (let i = 0; i < 20 && submitSpy.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["send:start"]);
    expect(abortSession).not.toHaveBeenCalled();

    release();
    const [response] = await Promise.all([pendingResponse, send]);
    expect(response.status).toBe(200);
    expect(order).toEqual(["send:start", "send:end", "commit"]);
    expect(await response.json()).toEqual([
      {
        seq: 2,
        frame: { kind: "sessionMeta", data: { sessionId: "route-serial", title: "commit" } },
      },
    ]);
    await manager.disposeAll();
  });

  it.each([
    ["review group", { acceptReviewBatchIds: ["cold-batch"] }],
    ["patch ids", { patchIds: ["cold-patch"] }],
  ])("内存逐出后 %s commit 按 REST sessionId 冷恢复", async (_label, payload) => {
    const sessionId = `commit-cold-${_label.replace(/\s+/g, "-")}`;
    const original = await startPersistedSession(sessionId);
    forgetSession(sessionId);
    expect(getSession(sessionId)).toBeUndefined();

    const res = await request("POST", "/api/v1/commit", { sessionId, ...payload });

    expect(res.status).toBe(200);
    expect(getSession(sessionId)).toBeDefined();
    expect(getSession(sessionId)).not.toBe(original);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it.each(["acceptPatch", "rejectPatch"] as const)(
    "%s 分发收到 actor 路由键后也走 getOrRestoreSession",
    async (kind) => {
      const sessionId = `commit-cold-${kind}`;
      await startPersistedSession(sessionId);
      forgetSession(sessionId);

      await collectFrames(handleCommand(
        { kind, data: { id: "already-resolved-patch" } },
        undefined,
        "manual",
        undefined,
        undefined,
        sessionId,
      ));

      expect(getSession(sessionId)).toBeDefined();
    },
  );

  it("重复提交同一批次保持稳定，响应 seq 单调且形状只含 seq/frame", async () => {
    const sessionId = "commit-repeat-test";
    await startPersistedSession(sessionId);

    const first = await request("POST", "/api/v1/commit", {
      sessionId,
      acceptReviewBatchIds: ["already-resolved"],
    });
    const second = await request("POST", "/api/v1/commit", {
      sessionId,
      acceptReviewBatchIds: ["already-resolved"],
    });
    const firstBody = await first.json() as Array<Record<string, unknown>>;
    const secondBody = await second.json() as Array<Record<string, unknown>>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody).toHaveLength(1);
    expect(secondBody).toHaveLength(1);
    expect(Object.keys(firstBody[0]!).sort()).toEqual(["frame", "seq"]);
    expect(Number(secondBody[0]!.seq)).toBeGreaterThan(Number(firstBody[0]!.seq));
  });

  it.each([
    ["空 sessionId", { sessionId: "", patchIds: ["p"] }, "sessionId must be a non-empty string"],
    ["空 patchIds", { sessionId: "s", patchIds: [] }, "patchIds must be a non-empty array"],
    ["group 元素为空", { sessionId: "s", acceptReviewBatchIds: [""] }, "acceptReviewBatchIds[] must be non-empty strings"],
    ["reject 不是数组", { sessionId: "s", acceptReviewBatchIds: [], rejectReviewBatchIds: "x" }, "rejectReviewBatchIds must be an array"],
  ])("非法载荷返回 400：%s", async (_label, body, error) => {
    const res = await request("POST", "/api/v1/commit", body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("REST commit 同步拒绝超过契约上限的 id 数组", async () => {
    const submit = vi.spyOn(sessionManager, "submit");
    const res = await request("POST", "/api/v1/commit", {
      sessionId: "commit-array-limit-test",
      patchIds: Array.from({ length: MAX_COMMAND_ARRAY_LENGTH + 1 }, (_, index) => `patch-${index}`),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: `patchIds must contain at most ${MAX_COMMAND_ARRAY_LENGTH} items`,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "accept/reject",
      {
        acceptReviewBatchIds: ["batch-1", "batch-overlap"],
        rejectReviewBatchIds: ["batch-overlap"],
      },
      "acceptReviewBatchIds and rejectReviewBatchIds must not overlap",
    ],
    [
      "accept/keep-pending",
      {
        acceptReviewBatchIds: ["batch-1", "batch-overlap"],
        keepPendingReviewBatchIds: ["batch-overlap"],
      },
      "acceptReviewBatchIds and keepPendingReviewBatchIds must not overlap",
    ],
    [
      "reject/keep-pending",
      {
        acceptReviewBatchIds: [],
        rejectReviewBatchIds: ["batch-overlap"],
        keepPendingReviewBatchIds: ["batch-overlap"],
      },
      "rejectReviewBatchIds and keepPendingReviewBatchIds must not overlap",
    ],
  ])("%s 批次重叠在进入 actor 前返回稳定 400", async (_label, payload, error) => {
    const submit = vi.spyOn(sessionManager, "submit");
    const res = await request("POST", "/api/v1/commit", {
      sessionId: "commit-overlap-test",
      ...payload,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(submit).not.toHaveBeenCalled();
  });

  it("/commands 同样在 schema 层拒绝 accept/reject 批次重叠", async () => {
    const submit = vi.spyOn(sessionManager, "submit");
    const res = await request("POST", "/api/v1/commands", {
      kind: "commitReviewGroups",
      data: {
        acceptReviewBatchIds: ["batch-overlap"],
        rejectReviewBatchIds: ["batch-overlap"],
      },
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe(
      "commitReviewGroups.data.rejectReviewBatchIds: must not overlap with acceptReviewBatchIds",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("真正执行中的 actor 失败仍返回 200+脱敏帧，不透传原始 message", async () => {
    const failureFrame: LoggedFrame = {
      seq: 7,
      epoch: 1,
      generation: 2,
      frame: {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "error",
            reason: "操作未能完成，请刷新页面后重试",
            retriable: true,
          },
        },
      },
    };
    vi.spyOn(sessionManager, "submit").mockRejectedValueOnce(
      new SessionActorCommandError(
        "Session actor command failed",
        new Error("secret path /tmp/private-review sk-reviewsecret"),
        [failureFrame],
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request("POST", "/api/v1/commit", {
      sessionId: "commit-runtime-failure-test",
      acceptReviewBatchIds: ["batch-1"],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual([{ seq: 7, frame: failureFrame.frame }]);
    expect(JSON.stringify(body)).not.toContain("private-review");
    expect(JSON.stringify(body)).not.toContain("reviewsecret");
  });

  it("内部异常返回脱敏通用错误，不泄漏原始 error.message", async () => {
    vi.spyOn(sessionManager, "submit").mockRejectedValueOnce(
      new Error("secret path /tmp/private-key sk-supersecret"),
    );

    const res = await request("POST", "/api/v1/commit", {
      sessionId: "commit-error-test",
      acceptReviewBatchIds: ["batch"],
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "模型服务暂时不可用，请稍后重试" });
    expect(JSON.stringify(body)).not.toContain("private-key");
    expect(JSON.stringify(body)).not.toContain("supersecret");
  });

  it.each([
    [new SessionDeletedError(), 410, "SESSION_DELETED", "会话已删除，无法继续操作"],
    [new SessionDeletionInProgressError(), 409, "SESSION_DELETION_IN_PROGRESS", "会话正在删除，请稍后再试"],
  ])("commit 将删除领域错误映射为明确状态（case %#）", async (error, status, code, message) => {
    vi.spyOn(sessionManager, "submit").mockRejectedValueOnce(error);
    const res = await request("POST", "/api/v1/commit", {
      sessionId: "deleted-commit-session",
      acceptReviewBatchIds: ["batch"],
    });

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({
      error: { code, message },
    });
  });

  it.each([
    [new SessionDeletedError(), 410, "SESSION_DELETED", "会话已删除，无法继续操作"],
    [new SessionDeletionInProgressError(), 409, "SESSION_DELETION_IN_PROGRESS", "会话正在删除，请稍后再试"],
  ])("commands 将删除领域错误映射为明确状态（case %#）", async (error, status, code, message) => {
    vi.spyOn(sessionManager, "submitQueued").mockRejectedValueOnce(error);
    const res = await request("POST", "/api/v1/commands", {
      kind: "startSession",
      data: { mode: { kind: "existing", data: { id: "deleted-command-session" } } },
    });

    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({
      error: { code, message },
    });
  });

  it("draftTemplate deadline 失败返回 422，并携带失败帧 reason 与 requestId", async () => {
    const failureFrame: LoggedFrame = {
      seq: 8,
      epoch: 1,
      generation: 3,
      frame: {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: {
            streamId: "error",
            reason: "操作未能完成，请刷新页面后重试",
            retriable: true,
          },
        },
      },
    };
    vi.spyOn(sessionManager, "submitQueued").mockResolvedValueOnce({
      completion: Promise.reject(new SessionActorCommandError(
        "Session actor command failed",
        new DOMException("draftTemplate timed out after 85000ms", "TimeoutError"),
        [failureFrame],
      )),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request("POST", "/api/v1/commands", {
      kind: "draftTemplate",
      data: {
        sessionId: "command-runtime-failure-test",
        requestId: "request-template-timeout",
        scene: { kind: "review", type: "role", label: "角色审查" },
        intent: { name: "", prompt: "" },
      },
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "COMMAND_FAILED",
        message: "操作未能完成，请刷新页面后重试",
      },
      requestId: "request-template-timeout",
    });
  });
});
