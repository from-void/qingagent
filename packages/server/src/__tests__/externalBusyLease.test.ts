import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_ATTACH_CAPABILITIES } from "@qingagent/contract-ts";
import { getPmContentHash, normalizePmDoc } from "@qingagent/pm-schema";
import { app } from "../app";
import {
  EXTERNAL_BUSY_LEASE_TTL_MS,
  getOrRestoreSession,
  sessionManager,
  signalExternalBusyLease,
} from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";
import { createAttachSession } from "../lib/attachSessions";
import { SessionActorExternalLeaseHeldError } from "../gateway/sessionActor";
import { authenticatedCommandRequest } from "./commandTestRequest";

const dirs: string[] = [];
let instanceFilePath = "";
let token = "";

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qa-external-busy-lease-"));
  dirs.push(dir);
  instanceFilePath = path.join(dir, "instance.json");
  await startTestInstance();
});

afterEach(async () => {
  vi.useRealTimers();
  await stopExternalInstance();
  await sessionManager.disposeAll();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("external busy lease", () => {
  it("docEditing attach capability 可调用 turn-signal", async () => {
    const sessionId = await createSession();
    const attached = createAttachSession({
      identity: {
        schemaVersion: 2,
        port: 52342,
        pid: 1,
        version: "test",
        attachProtocolVersion: 1,
        instanceId: "attached-renderer",
        libraryId: "00000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-19T00:00:00.000Z",
      },
      desktopCapabilities: { ...DESKTOP_ATTACH_CAPABILITIES },
    });

    const begin = await request(`/sessions/${sessionId}/turn-signal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attached.token}` },
      body: JSON.stringify({ action: "begin", turnId: "turn-attach" }),
    });
    expect(begin.status).toBe(200);
    expect(await readBusy(sessionId)).toBe(true);

    const end = await request(`/sessions/${sessionId}/turn-signal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${attached.token}` },
      body: JSON.stringify({ action: "end", turnId: "turn-attach" }),
    });
    expect(end.status).toBe(200);
    expect(await readBusy(sessionId)).toBe(false);
  });

  it("begin/end 只各广播一次，重复信号幂等且旧 turn 的 end 清不掉新租约", async () => {
    const sessionId = await createSession();
    const afterSeq = frameTip(sessionId);

    expect((await signal(sessionId, "begin", "turn-old")).status).toBe(200);
    expect((await signal(sessionId, "begin", "turn-old")).status).toBe(200);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true]);

    const held = await signal(sessionId, "begin", "turn-new");
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: "LEASE_HELD" });
    expect((await signal(sessionId, "end", "turn-old")).status).toBe(200);
    expect((await signal(sessionId, "begin", "turn-new")).status).toBe(200);
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease?.turnId)
      .toBe("turn-new");
    expect(await readBusy(sessionId)).toBe(true);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true, false, true]);

    expect((await signal(sessionId, "end", "turn-new")).status).toBe(200);
    expect((await signal(sessionId, "end", "turn-new")).status).toBe(200);
    expect(await readBusy(sessionId)).toBe(false);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true, false, true, false]);
  });

  it("heartbeat 从当前时刻续期，缺失 end 时跨过 TTL 必然广播解锁", async () => {
    const sessionId = await createSession();
    const afterSeq = frameTip(sessionId);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));

    expect((await signal(sessionId, "begin", "turn-expiry")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(EXTERNAL_BUSY_LEASE_TTL_MS / 2);
    expect((await signal(sessionId, "heartbeat", "turn-expiry")).status).toBe(200);

    await vi.advanceTimersByTimeAsync(EXTERNAL_BUSY_LEASE_TTL_MS / 2);
    expect(await readBusy(sessionId)).toBe(true);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true]);

    await vi.advanceTimersByTimeAsync(EXTERNAL_BUSY_LEASE_TTL_MS / 2);
    expect(await readBusy(sessionId)).toBe(false);
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease).toBeNull();
    expect(busyFrames(sessionId, afterSeq)).toEqual([true, false]);
  });

  it("异主 heartbeat 返回 LEASE_HELD，而不是含糊的 active:false", async () => {
    const sessionId = await createSession();
    expect((await signal(sessionId, "begin", "turn-heartbeat-owner")).status).toBe(200);

    await stopExternalInstance();
    await startTestInstance();
    const heartbeat = await signal(sessionId, "heartbeat", "turn-heartbeat-owner");

    expect(heartbeat.status).toBe(409);
    expect(await heartbeat.json()).toMatchObject({ code: "LEASE_HELD" });
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease?.turnId)
      .toBe("turn-heartbeat-owner");
  });

  it("租约期内原生 sendMessage 与持约人的 external/chat 都在服务端同步拒绝", async () => {
    const sessionId = await createSession();
    expect((await signal(sessionId, "begin", "turn-reverse-gate")).status).toBe(200);

    const native = await authenticatedCommandRequest("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "sendMessage",
        data: {
          sessionId,
          text: "租约期间不应起轮",
          skills: [],
          chips: [],
          fileIds: [],
        },
      }),
    });
    expect(native.status).toBe(409);
    expect(await native.json()).toMatchObject({
      reason: "external_lease_held",
      error: "Agent 正在编辑，稍后再试",
    });

    const holderChat = await request(`/sessions/${sessionId}/chat`, {
      method: "POST",
      body: JSON.stringify({ text: "持约人也不豁免 external/chat" }),
    });
    expect(holderChat.status).toBe(409);
    expect(await holderChat.json()).toMatchObject({ code: "LEASE_HELD" });
  });

  it("submitReviewOutcome 已入队后的租约竞态返回 409，Actor 失败帧由执行二查负责", async () => {
    const sessionId = await createSession();
    const completion = Promise.reject(new SessionActorExternalLeaseHeldError());
    void completion.catch(() => undefined);
    vi.spyOn(sessionManager, "submitQueued").mockResolvedValueOnce({ completion });

    const response = await authenticatedCommandRequest("/api/v1/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "submitReviewOutcome",
        data: {
          sessionId,
          outcome: { acceptedCount: 0, rejectedCount: 0, hunks: [] },
        },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: "external_lease_held",
      error: "Agent 正在编辑，稍后再试",
    });
  });

  it("租约挡住直接写和非持约人提案，但按 principalId + turnId 放行持约人 proposals", async () => {
    const sessionId = await createSession();
    const baselineResponse = await request(`/sessions/${sessionId}/doc?format=pm`);
    const baseline = await baselineResponse.json() as {
      docVersion: number;
      contentHash: string;
    };
    expect((await signal(sessionId, "begin", "turn-holder")).status).toBe(200);
    expect(await readBusy(sessionId)).toBe(true);

    const directWrite = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: baseline.docVersion,
        baseContentHash: baseline.contentHash,
        clientMutationId: "lease-direct-write",
        doc: pmDoc("直接写应被锁住"),
      }),
    });
    expect(directWrite.status).toBe(409);
    expect(await directWrite.json()).toMatchObject({ code: "REVIEW_PENDING" });

    const wrongTurnProposal = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 0,
        turnId: "turn-other",
        ops: [{ kind: "qingmlDraft", qingml: "<p>错误回合不能写</p>" }],
      }),
    });
    expect(wrongTurnProposal.status).toBe(409);
    expect(await wrongTurnProposal.json()).toMatchObject({ code: "LOCK_LOST" });

    const holderProposal = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 0,
        turnId: "turn-holder",
        ops: [{ kind: "qingmlDraft", qingml: "<p>持约人写入成功</p>" }],
      }),
    });
    expect(holderProposal.status).toBe(200);
    expect(await holderProposal.json()).toMatchObject({
      status: "committed",
      docVersion: 1,
    });

    await stopExternalInstance();
    await startTestInstance();
    const nonHolderProposal = await request(`/sessions/${sessionId}/proposals`, {
      method: "POST",
      body: JSON.stringify({
        expectedDocVersion: 1,
        turnId: "turn-holder",
        ops: [{ kind: "appendSection", markdown: "非持约人不能写" }],
      }),
    });
    expect(nonHolderProposal.status).toBe(409);
    expect(await nonHolderProposal.json()).toMatchObject({ code: "LOCK_LOST" });
  });

  it("begin 入队时发现 H1 起轮任务立即 BUSY_NATIVE，任务结束后也不延迟授租", async () => {
    const sessionId = await createSession();
    let blockerStarted!: () => void;
    let releaseBlocker!: () => void;
    const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = sessionManager.runExclusive(sessionId, async function* () {
      blockerStarted();
      await gate;
    });
    await started;
    const confirmDispatch = sessionManager.runExclusive(
      sessionId,
      async function* () {},
      { agentTurnDispatch: true },
    );

    const begin = await signal(sessionId, "begin", "turn-queued-native");
    expect(begin.status).toBe(409);
    expect(await begin.json()).toMatchObject({ code: "BUSY_NATIVE" });

    releaseBlocker();
    await Promise.all([blocker, confirmDispatch]);
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease).toBeNull();
  });

  it("已通过 admission 但排队至 deadline 过期的 begin 自废，不产生幽灵租约", async () => {
    const sessionId = await createSession();
    let blockerStarted!: () => void;
    let releaseBlocker!: () => void;
    const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blocker = sessionManager.runExclusive(sessionId, async function* () {
      blockerStarted();
      await gate;
    });
    await started;

    const queuedBegin = signalExternalBusyLease({
      sessionId,
      principalId: "external:deadline-test",
      turnId: "turn-expired-in-queue",
      action: "begin",
      deadline: Date.now() - 1,
    });
    releaseBlocker();
    await blocker;

    await expect(queuedBegin).resolves.toMatchObject({ cancelled: true, active: false });
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease).toBeNull();
  });

  it("overlay 挂起态执行 begin 二查返回 BUSY_NATIVE", async () => {
    const sessionId = await createSession();
    const session = await getOrRestoreSession(sessionId);
    session!.pendingConfirms.set("confirm-overlay", {
      confirmId: "confirm-overlay",
      runId: "run-overlay",
      toolCallId: "confirm-overlay",
      toolName: "executeCommand",
      commandDigest: "digest-overlay",
      spec: {
        id: "confirm-overlay",
        kind: "command",
        title: "确认执行",
        say: "确认执行",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: "2026-08-19T00:00:00.000Z",
      expiresAt: "2026-08-19T00:01:00.000Z",
      status: "pending",
    });

    const begin = await signal(sessionId, "begin", "turn-overlay");
    expect(begin.status).toBe(409);
    expect(await begin.json()).toMatchObject({ code: "BUSY_NATIVE" });
    expect(session!.externalBusyLease).toBeNull();
  });

  it("heartbeat 观察到原生 overlay 时返回 BUSY_NATIVE 且不偷偷续期", async () => {
    const sessionId = await createSession();
    expect((await signal(sessionId, "begin", "turn-heartbeat-busy")).status).toBe(200);
    const session = await getOrRestoreSession(sessionId);
    const originalExpiry = session!.externalBusyLease!.expiresAt;
    session!.pendingConfirms.set("confirm-heartbeat-busy", {
      confirmId: "confirm-heartbeat-busy",
      runId: "run-heartbeat-busy",
      toolCallId: "confirm-heartbeat-busy",
      toolName: "executeCommand",
      commandDigest: "digest-heartbeat-busy",
      spec: {
        id: "confirm-heartbeat-busy",
        kind: "command",
        title: "确认执行",
        say: "确认执行",
        primaryLabel: "执行",
        secondaryLabel: "取消",
      },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });

    const heartbeat = await signal(sessionId, "heartbeat", "turn-heartbeat-busy");

    expect(heartbeat.status).toBe(409);
    expect(await heartbeat.json()).toMatchObject({ code: "BUSY_NATIVE" });
    expect(session!.externalBusyLease!.expiresAt).toBe(originalExpiry);
  });

  it("空白租约段 fullDraft+setTitle、局部结构 op、幂等重放与 qingmlDraft 全部直落且最多三次", async () => {
    const sessionId = await createSession();
    expect((await signal(sessionId, "begin", "turn-direct")).status).toBe(200);

    const first = await propose(sessionId, {
      expectedDocVersion: 0,
      clientMutationId: "direct-1",
      turnId: "turn-direct",
      ops: [
        { kind: "fullDraft", markdown: "# 初稿\n\n第一段。" },
        { kind: "setTitle", title: "钉住的标题" },
      ],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "committed", docVersion: 1 });
    const session = await getOrRestoreSession(sessionId);
    expect(session?.title).toBe("钉住的标题");
    expect(session?.titlePinned).toBe(true);
    expect(session?.externalBusyLease).toMatchObject({
      startedFromEmpty: true,
      directCommitCount: 1,
    });

    const titleOnly = await propose(sessionId, {
      expectedDocVersion: 1,
      clientMutationId: "direct-title-only",
      turnId: "turn-direct",
      ops: [{ kind: "setTitle", title: "仅改标题不耗直落次数" }],
    });
    expect(titleOnly.status).toBe(200);
    expect(await titleOnly.json()).toMatchObject({ status: "committed", docVersion: 1 });
    expect(session?.title).toBe("仅改标题不耗直落次数");
    expect(session?.externalBusyLease?.directCommitCount).toBe(1);

    const anchorId = session?.doc?.content[0]?.attrs?.blockId;
    expect(anchorId).toEqual(expect.any(String));
    session!.annotationGroups = [{
      id: "direct-annotation",
      summary: "直落迁移批注",
      note: "结构插入后仍应保留原文锚点",
      origin: "consistency",
      status: "reviewing",
      anchors: [{
        blockId: String(anchorId),
        pmFrom: 1,
        pmTo: 3,
        quote: "初稿",
        textHash: "direct-annotation-hash",
      }],
    }];
    session!.docDraftBaseDoc = pmDoc("过期基底");
    session!.docDraftBaseVersion = 1;
    session!.docDraftCandidateDoc = pmDoc("过期候选");
    const beforeStructuralSeq = frameTip(sessionId);
    const structuralBody = {
      expectedDocVersion: 1,
      clientMutationId: "direct-2",
      turnId: "turn-direct",
      opId: "direct-structural-op",
      ops: [{
        kind: "insertAfterBlock" as const,
        blockId: String(anchorId),
        markdown: "第二段。",
      }],
    };
    const second = await propose(sessionId, structuralBody);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "committed", docVersion: 2 });
    expect(session?.docDraftBaseDoc).toBeNull();
    expect(session?.docDraftCandidateDoc).toBeNull();
    expect(session?.externalStructuralOpDigests.has("direct-structural-op")).toBe(false);
    expect(session?.externalBusyLease?.directCommitCount).toBe(2);
    expect(session?.annotationGroups).toEqual([
      expect.objectContaining({
        id: "direct-annotation",
        anchors: [expect.objectContaining({ quote: "初稿" })],
      }),
    ]);
    expect(
      sessionManager.frameLog.readFrom(sessionId, beforeStructuralSeq).frames
        .some((entry) => entry.frame.kind === "annotationGroupsReady"),
    ).toBe(true);

    const replay = await propose(sessionId, structuralBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "committed", docVersion: 2 });
    expect(session?.externalBusyLease?.directCommitCount).toBe(2);

    const third = await propose(sessionId, {
      expectedDocVersion: 2,
      clientMutationId: "direct-3",
      turnId: "turn-direct",
      ops: [{ kind: "qingmlDraft", qingml: "<p>QingML 直落终稿</p>" }],
    });
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ status: "committed", docVersion: 3 });
    expect(session?.externalBusyLease?.directCommitCount).toBe(3);

    for (let index = 0; index < 3; index += 1) {
      expect((await signal(sessionId, "heartbeat", "turn-direct")).status).toBe(200);
    }
    expect((await signal(sessionId, "begin", "turn-direct")).status).toBe(200);
    expect(session?.externalBusyLease).toMatchObject({
      startedFromEmpty: true,
      directCommitCount: 3,
    });

    const fourth = await propose(sessionId, {
      expectedDocVersion: 3,
      clientMutationId: "direct-4",
      turnId: "turn-direct",
      ops: [{ kind: "appendSection", markdown: "第四次不应写入。" }],
    });
    expect(fourth.status).toBe(400);
    expect(await fourth.json()).toMatchObject({
      code: "VALIDATION",
      error: expect.stringContaining("最多直落 3 次"),
    });
    expect(session?.docVersion).toBe(3);
    expect(session?.externalBusyLease?.directCommitCount).toBe(3);

    const persisted = await request(`/sessions/${sessionId}/doc?format=pm`);
    const persistedBody = await persisted.json() as {
      docVersion: number;
      contentHash: string;
    };
    expect(persistedBody.docVersion).toBe(session?.docVersion);
    expect(persistedBody.contentHash).toBe(getPmContentHash(session!.doc!));
  });

  it("仅含空段落的 canonical 文档授租时仍标记 startedFromEmpty 并直落首写", async () => {
    const sessionId = await createSession();
    const baselineResponse = await request(`/sessions/${sessionId}/doc?format=pm`);
    const baseline = await baselineResponse.json() as {
      docVersion: number;
      contentHash: string;
    };
    const blank = await request(`/sessions/${sessionId}/doc`, {
      method: "PUT",
      body: JSON.stringify({
        expectedDocumentSnapshot: baseline.docVersion,
        baseContentHash: baseline.contentHash,
        clientMutationId: "blank-paragraph",
        doc: pmDoc(""),
      }),
    });
    expect(blank.status).toBe(200);
    expect((await signal(sessionId, "begin", "turn-blank")).status).toBe(200);
    const session = await getOrRestoreSession(sessionId);
    expect(session?.externalBusyLease?.startedFromEmpty).toBe(true);

    const first = await propose(sessionId, {
      expectedDocVersion: session!.docVersion,
      clientMutationId: "blank-first-content",
      turnId: "turn-blank",
      ops: [{ kind: "fullDraft", markdown: "空段落后的首篇正文。" }],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "committed" });
    expect(session?.externalBusyLease?.directCommitCount).toBe(1);
  });
});

async function startTestInstance(): Promise<void> {
  await startExternalInstance({
    port: 52341,
    version: "test",
    libraryId: "00000000-0000-4000-8000-000000000001",
    filePath: instanceFilePath,
  });
  token = getExternalToken() ?? "";
}

async function createSession(): Promise<string> {
  const response = await request("/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
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

function propose(sessionId: string, body: unknown): Promise<Response> {
  return request(`/sessions/${sessionId}/proposals`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function readBusy(sessionId: string): Promise<boolean> {
  const response = await request(`/sessions/${sessionId}/doc?format=pm`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { agentBusy: boolean }).agentBusy;
}

function frameTip(sessionId: string): number {
  return sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER).nextSeq - 1;
}

function busyFrames(sessionId: string, afterSeq: number): boolean[] {
  return sessionManager.frameLog.readFrom(sessionId, afterSeq).frames.flatMap((entry) =>
    entry.frame.kind === "docStateChanged" ? [entry.frame.data.agentBusy] : []
  );
}

function pmDoc(text: string) {
  const doc = normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "paragraph",
      attrs: { blockId: "external-lease-paragraph" },
      content: [{ type: "text", text }],
    }],
  });
  expect(getPmContentHash(doc)).toBeTruthy();
  return doc;
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
