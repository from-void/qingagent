import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import { createSession } from "../../bridge/sessionState.js";
import type { QingagentThreadMetadata } from "../../bridge/threadPersistence.js";
import { documentRepo } from "../documentRepo.js";
import {
  __resetDocumentsClientForTest,
  __resetShadowCircuitForTest,
  getShadowCircuitState,
  recordShadowOutcome,
  shadowCircuitOpen,
  shouldWarn,
  SHADOW_CIRCUIT_COOLDOWN_MS,
  SHADOW_CIRCUIT_FAIL_THRESHOLD,
  withWriteRetry,
} from "../documentsClient.js";
import { __resetMigrationsForTest } from "../migrations.js";

const { memory, threads } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    updateThread: vi.fn(
      async ({
        id,
        title,
        metadata,
      }: {
        id: string;
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        const existing = threads.get(id) ?? {
          id,
          resourceId: "qingagent-user",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        threads.set(id, {
          ...existing,
          id,
          title,
          metadata,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        });
      },
    ),
  };
  return { memory, threads };
});

vi.mock("../../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

vi.mock("../../bridge/agentSpans.js", () => ({
  sessionIdToTraceId: (sessionId: string) => `trace-${sessionId}`,
}));

let tempDir: string;

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-shadow-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "shadow.db")}`;
  threads.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
});

afterEach(() => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  delete process.env.DATABASE_URL;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("persistSessionMetadata shadow write", () => {
  it("writes documents after the primary metadata path succeeds", async () => {
    const { persistSessionMetadata } = await import("../../bridge/threadPersistence.js");
    const state = createSession("session-shadow");
    state.threadId = "session-shadow";
    state.title = "Shadow title";
    state.docState = { kind: "editing" };
    state.docVersion = 3;
    state.lastSyncedDocumentSnapshot = 2;
    state.legacySections = [section("第一段"), section("第二段")];
    state.doc = legacySectionsToPm(state.legacySections as never);

    await persistSessionMetadata(state);

    const meta = threads.get(state.sessionId)?.metadata as QingagentThreadMetadata;
    const doc = await documentRepo.load(state.docId);
    expect(doc?.pmDoc).toEqual(state.doc);
    expect(meta.legacySections).toEqual(doc?.legacySections);
    expect(meta.docState.kind).toBe(doc?.docState);
    expect(meta.docVersion).toBe(doc?.docVersion);
    expect(doc?.lastSyncedVersion).toBe(meta.lastSyncedDocumentSnapshot);
  });

  it("does not let stale metadata shadow writes regress a newer documents row", async () => {
    const { persistSessionMetadata } = await import("../../bridge/threadPersistence.js");
    const state = createSession("session-shadow-stale");
    state.threadId = "session-shadow-stale";
    state.title = "Stale shadow";
    state.docState = { kind: "editing" };
    state.docVersion = 2;
    state.lastSyncedDocumentSnapshot = 2;
    state.legacySections = [section("old body")];
    state.doc = legacySectionsToPm(state.legacySections as never);

    await documentRepo.save({
      id: state.docId,
      threadId: state.threadId,
      resourceId: state.resourceId,
      title: "Latest title",
      docState: "editing",
      docVersion: 4,
      lastSyncedVersion: 4,
      legacySections: [section("latest body")],
      pmDoc: legacySectionsToPm([section("latest body")] as never),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
    });

    await persistSessionMetadata(state);

    const doc = await documentRepo.load(state.docId);
    expect(doc?.docVersion).toBe(4);
    expect(doc?.title).toBe("Latest title");
    expect(doc?.legacySections).toEqual([section("latest body")]);
  });

  // 回归(0702 review Lane A):影子写必须整体使用 serializeMetadata 时刻的快照(meta.doc),
  // 不能晚读活引用 state.doc。否则 updateThread await 期间的并发 updateDoc 提交会把
  // 「新内容 + 旧 docVersion」的错位对写进 documents(等版本+内容变化分支可放行错位内容)。
  it("影子写使用 serialize 时刻的 doc 快照,updateThread 期间的并发 doc 替换不进入本次影子写", async () => {
    const { persistSessionMetadata } = await import("../../bridge/threadPersistence.js");
    const state = createSession("session-shadow-atomic");
    state.threadId = "session-shadow-atomic";
    state.title = "Atomic shadow";
    state.docState = { kind: "editing" };
    state.docVersion = 3;
    state.lastSyncedDocumentSnapshot = 2;
    state.legacySections = [section("快照时刻的正文")];
    const docAtSerializeTime = legacySectionsToPm(state.legacySections as never);
    state.doc = docAtSerializeTime;

    // 模拟主写(updateThread)await 期间活跃轮次提交了新文档:整体替换 state.doc + 版本 +1
    memory.updateThread.mockImplementationOnce(async (args) => {
      state.doc = legacySectionsToPm([section("await 期间提交的新正文")] as never);
      state.docVersion = 4;
      const existing = threads.get(args.id) ?? {
        id: args.id,
        resourceId: "qingagent-user",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      threads.set(args.id, { ...existing, ...args, updatedAt: new Date() });
    });

    await persistSessionMetadata(state);

    const doc = await documentRepo.load(state.docId);
    // 本次影子写落的是 serialize 时刻的一致快照(版本 3 + 旧正文),
    // 而不是「版本 3 + await 期间的新正文」这种错位对;新正文由 dirty 循环下一轮补写。
    expect(doc?.docVersion).toBe(3);
    expect(doc?.pmDoc).toEqual(docAtSerializeTime);
    expect(JSON.stringify(doc?.pmDoc)).not.toContain("await 期间提交的新正文");
  });

  it("does not let shadow write failures affect primary metadata persistence", async () => {
    const saveSpy = vi.spyOn(documentRepo, "save").mockRejectedValueOnce(
      new Error("shadow db unavailable"),
    );
    const { persistSessionMetadata } = await import("../../bridge/threadPersistence.js");
    const state = createSession("session-shadow-fail");
    state.title = "Primary survives";
    state.docState = { kind: "editing" };
    state.legacySections = [section("正文")];
    state.doc = legacySectionsToPm(state.legacySections as never);

    await expect(persistSessionMetadata(state)).resolves.toBeUndefined();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    const meta = threads.get(state.sessionId)?.metadata as QingagentThreadMetadata;
    expect(meta.title).toBe("Primary survives");
    expect(meta.legacySections).toEqual([section("正文")]);
  });

  it("retries SQLITE_BUSY primary metadata writes and eventually persists suspension ids", async () => {
    const { persistSessionMetadata } = await import("../../bridge/threadPersistence.js");
    let attempts = 0;
    memory.updateThread.mockImplementation(
      async ({
        id,
        title,
        metadata,
      }: {
        id: string;
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        attempts++;
        if (attempts < 3) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        const existing = threads.get(id) ?? {
          id,
          resourceId: "qingagent-user",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        threads.set(id, {
          ...existing,
          id,
          title,
          metadata,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        });
      },
    );
    const state = createSession("session-primary-busy");
    state.title = "Suspended primary retry";
    state.runId = "run-busy";
    state.toolCallId = "ask-busy";

    await expect(persistSessionMetadata(state, "tool_call_suspended")).resolves.toBeUndefined();

    expect(memory.updateThread).toHaveBeenCalledTimes(3);
    const meta = threads.get(state.sessionId)?.metadata as QingagentThreadMetadata;
    expect(meta.runId).toBe("run-busy");
    expect(meta.toolCallId).toBe("ask-busy");
  });
});

describe("shadow circuit breaker and write retry", () => {
  beforeEach(() => {
    __resetShadowCircuitForTest();
  });

  it("opens after consecutive failures and closes after a successful half-open probe", () => {
    const now = 1_000;
    for (let i = 0; i < SHADOW_CIRCUIT_FAIL_THRESHOLD - 1; i++) {
      recordShadowOutcome(false, now + i);
      expect(shadowCircuitOpen(now + i)).toBe(false);
    }

    recordShadowOutcome(false, now + SHADOW_CIRCUIT_FAIL_THRESHOLD);
    expect(shadowCircuitOpen(now + SHADOW_CIRCUIT_FAIL_THRESHOLD + 1)).toBe(true);
    expect(
      shadowCircuitOpen(
        now + SHADOW_CIRCUIT_FAIL_THRESHOLD + SHADOW_CIRCUIT_COOLDOWN_MS + 1,
      ),
    ).toBe(false);

    recordShadowOutcome(
      true,
      now + SHADOW_CIRCUIT_FAIL_THRESHOLD + SHADOW_CIRCUIT_COOLDOWN_MS + 2,
    );
    expect(getShadowCircuitState().consecutiveFailures).toBe(0);
    expect(shadowCircuitOpen(now + SHADOW_CIRCUIT_COOLDOWN_MS + 3)).toBe(false);
  });

  it("rate-limits warnings", () => {
    expect(shouldWarn(1_000)).toBe(true);
    expect(shouldWarn(1_500)).toBe(false);
    expect(shouldWarn(11_500)).toBe(true);
  });

  it("retries SQLITE_BUSY writes and does not retry unrelated errors", async () => {
    let attempts = 0;
    await expect(
      withWriteRetry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("SQLITE_BUSY: database is locked");
          return "ok";
        },
        5,
        1,
      ),
    ).resolves.toBe("ok");
    expect(attempts).toBe(3);

    let nonBusyAttempts = 0;
    await expect(
      withWriteRetry(async () => {
        nonBusyAttempts++;
        throw new Error("syntax error");
      }),
    ).rejects.toThrow("syntax error");
    expect(nonBusyAttempts).toBe(1);
  });
});
