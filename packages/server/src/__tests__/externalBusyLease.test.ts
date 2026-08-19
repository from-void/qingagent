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
} from "../gateway/bridgeHandler";
import {
  getExternalToken,
  startExternalInstance,
  stopExternalInstance,
} from "../lib/externalInstance";
import { createAttachSession } from "../lib/attachSessions";

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

    expect((await signal(sessionId, "begin", "turn-new")).status).toBe(200);
    expect((await signal(sessionId, "end", "turn-old")).status).toBe(200);
    expect((await getOrRestoreSession(sessionId))?.externalBusyLease?.turnId)
      .toBe("turn-new");
    expect(await readBusy(sessionId)).toBe(true);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true]);

    expect((await signal(sessionId, "end", "turn-new")).status).toBe(200);
    expect((await signal(sessionId, "end", "turn-new")).status).toBe(200);
    expect(await readBusy(sessionId)).toBe(false);
    expect(busyFrames(sessionId, afterSeq)).toEqual([true, false]);
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
    expect(await wrongTurnProposal.json()).toMatchObject({ code: "AGENT_BUSY" });

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
    expect(await nonHolderProposal.json()).toMatchObject({ code: "AGENT_BUSY" });
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
