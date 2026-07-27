import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, FolderSourceRecord } from "@qingagent/contract-ts";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";

const { logger, memory } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const memory = {
    updateThread: vi.fn(),
    saveThread: vi.fn(),
  };
  return { logger, memory };
});

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

vi.mock("../agent-run/agentSpans.js", () => ({
  sessionIdToTraceId: (sessionId: string) => `trace-${sessionId}`,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function readDraftMessage(id: string): ChatMessage {
  return {
    id: `msg-${id}`,
    role: { kind: "agent" },
    ts: "2026-01-01T00:00:00.000Z",
    chips: null,
    parts: [
      {
        kind: "toolCall",
        data: {
          id,
          name: "readDraft",
          render: { kind: "chatInline" },
          status: { kind: "done" },
          body: { kind: "generic", data: { argsJson: "{}" } },
          result: { kind: "genericText", data: "draft" },
        },
      },
    ],
  };
}

function folderSource(sessionId: string): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_schedule",
    sessionId,
    provider: "desktop-local",
    name: "Schedule Docs",
    pathLabel: "Schedule Docs",
    mountName: "source_schedule",
    mountPath: "/sources/source_schedule",
    readOnly: true,
    fileCount: 1,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    desktopRootPath: "/tmp/qingagent-schedule-docs",
  };
}

describe("schedulePersist dirty-loop", () => {
  let tempDb: TempDocumentsDb;

  beforeEach(async () => {
    // 影子双写已恒开:用临时 libsql 库做真隔离,双写落在临时库而不是工作目录的 qingagent.db。
    tempDb = prepareTempDocumentsDb("qingagent-schedule-persist-");
    vi.clearAllMocks();
    memory.updateThread.mockReset();
    memory.saveThread.mockReset();
    const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
    __resetSessionPersistenceForTest();
  });

  afterEach(async () => {
    const { __resetSessionPersistenceForTest } = await import("../session/threadPersistence.js");
    __resetSessionPersistenceForTest();
    tempDb.cleanup();
  });

  it("慢写期间再次 mutate 会补写 trailing-edge 快照且合并 N 次 schedule", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const firstWrite = deferred();
    const writes: Array<Record<string, unknown>> = [];
    memory.updateThread.mockImplementation(
      async ({ metadata }: { metadata: Record<string, unknown> }) => {
        writes.push(metadata);
        if (writes.length === 1) await firstWrite.promise;
      },
    );

    const state = createSession("schedule-slow-write");
    state.docVersion = 1;
    schedulePersist(state, "first");

    await vi.waitFor(() => expect(memory.updateThread).toHaveBeenCalledTimes(1));
    state.docVersion = 2;
    state.chatHistory.push(readDraftMessage("read-1"));
    for (let i = 0; i < 5; i += 1) {
      schedulePersist(state, `second-${i}`);
    }

    firstWrite.resolve();
    await drainSessionPersistence();

    expect(memory.updateThread).toHaveBeenCalledTimes(2);
    expect(writes[0]?.docVersion).toBe(1);
    expect(writes[1]?.docVersion).toBe(2);
    const persistedHistory = writes[1]?.chatHistory as ChatMessage[] | undefined;
    expect(
      persistedHistory?.some((message) =>
        message.parts.some((part) => part.kind === "toolCall" && part.data.name === "readDraft"),
      ),
    ).toBe(true);
  });

  it("旧对象首轮写入阻塞时会消费同 sessionId 的最新对象且不残留 pending", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const firstWrite = deferred();
    const writes: Array<Record<string, unknown>> = [];
    memory.updateThread.mockImplementation(
      async ({ metadata }: { metadata: Record<string, unknown> }) => {
        writes.push(metadata);
        if (writes.length === 1) await firstWrite.promise;
      },
    );

    const oldState = createSession("schedule-replaced-state");
    oldState.docVersion = 1;
    const oldPersist = schedulePersist(oldState, "old-state");

    await vi.waitFor(() => expect(memory.updateThread).toHaveBeenCalledTimes(1));
    const newState = createSession(oldState.sessionId);
    newState.docVersion = 2;
    newState.title = "内存新对象";
    const newPersist = schedulePersist(newState, "new-state");

    firstWrite.resolve();
    await Promise.all([oldPersist, newPersist]);
    await drainSessionPersistence();

    expect(memory.updateThread).toHaveBeenCalledTimes(2);
    expect(writes.map((metadata) => metadata.docVersion)).toEqual([1, 2]);
    expect(writes[1]?.title).toBe("内存新对象");
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 0,
      loopCount: 0,
      pendingCount: 0,
    });
  });

  it("OM sidecar 持有的旧引用先调度时，后恢复的新对象仍会成为最终写入", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const sidecarWrite = deferred();
    const writes: Array<Record<string, unknown>> = [];
    memory.updateThread.mockImplementation(
      async ({ metadata }: { metadata: Record<string, unknown> }) => {
        writes.push(metadata);
        if (writes.length === 1) await sidecarWrite.promise;
      },
    );

    const sidecarOldState = createSession("schedule-om-old-reference");
    sidecarOldState.omCompressionEpoch = 1;
    schedulePersist(sidecarOldState, "om_sidecar:cursor");

    await vi.waitFor(() => expect(memory.updateThread).toHaveBeenCalledTimes(1));
    const restoredState = createSession(sidecarOldState.sessionId);
    restoredState.omCompressionEpoch = 2;
    restoredState.docVersion = 7;
    schedulePersist(restoredState, "stream_end");

    sidecarWrite.resolve();
    await drainSessionPersistence();

    expect(writes.map((metadata) => metadata.docVersion)).toEqual([0, 7]);
    expect(writes[1]?.omCompressionEpoch).toBe(2);
    expect(__getSessionPersistenceStateForTest().pendingCount).toBe(0);
  });

  it("loop 收尾微任务里追加的 mutation 不会被 finally 清理窗口吞掉", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const firstWrite = deferred();
    const writes: Array<Record<string, unknown>> = [];
    let queuedTailMutation = false;
    let state: ReturnType<typeof createSession>;
    memory.updateThread.mockImplementation(
      async ({ metadata }: { metadata: Record<string, unknown> }) => {
        writes.push(metadata);
        if (writes.length === 1) {
          await firstWrite.promise;
          queueMicrotask(() => {
            state.docVersion = 9;
            queuedTailMutation = true;
            schedulePersist(state, "tail-microtask");
          });
        }
      },
    );

    state = createSession("schedule-finally-window");
    state.docVersion = 1;
    schedulePersist(state, "first");

    await vi.waitFor(() => expect(memory.updateThread).toHaveBeenCalledTimes(1));
    firstWrite.resolve();
    await drainSessionPersistence();

    expect(queuedTailMutation).toBe(true);
    expect(memory.updateThread).toHaveBeenCalledTimes(2);
    expect(writes[1]?.docVersion).toBe(9);
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 0,
      loopCount: 0,
      pendingCount: 0,
    });
  });

  it("初始 thread 创建完成前不执行 updateThread，完成后写入包含 folderSources 的最新快照", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const initialCreate = deferred();
    const writes: Array<Record<string, unknown>> = [];
    memory.updateThread.mockImplementation(
      async ({ metadata }: { metadata: Record<string, unknown> }) => {
        writes.push(metadata);
      },
    );

    const state = createSession("schedule-await-initial-create");
    state.threadCreatePromise = initialCreate.promise;
    const source = folderSource(state.sessionId);
    state.folderSources.set(source.id, source);
    const persistPromise = schedulePersist(state, "command:attachFolder");

    await Promise.resolve();
    expect(memory.updateThread).not.toHaveBeenCalled();

    initialCreate.resolve();
    await persistPromise;
    await drainSessionPersistence();

    expect(memory.updateThread).toHaveBeenCalledTimes(1);
    expect((writes[0]?.folderSources as FolderSourceRecord[] | undefined)?.[0]?.id).toBe(source.id);
  });

  it("updateThread 遇到 thread-not-found 时用当前 metadata saveThread 兜底", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const { schedulePersist } = await import("../session/threadPersistence.js");
    const state = createSession("schedule-thread-not-found-fallback");
    const source = folderSource(state.sessionId);
    state.folderSources.set(source.id, source);
    memory.updateThread.mockRejectedValue(new Error("Thread not found"));
    memory.saveThread.mockResolvedValue(undefined);

    await expect(schedulePersist(state, "command:attachFolder")).resolves.toBeUndefined();

    expect(memory.saveThread).toHaveBeenCalledTimes(1);
    const saved = memory.saveThread.mock.calls[0]?.[0]?.thread as
      | { id: string; metadata: Record<string, unknown> }
      | undefined;
    expect(saved?.id).toBe(state.sessionId);
    expect((saved?.metadata.folderSources as FolderSourceRecord[] | undefined)?.[0]?.id).toBe(source.id);
    expect(logger.warn).toHaveBeenCalledWith(
      "Primary metadata update missed thread; falling back to saveThread",
      expect.objectContaining({
        sessionId: state.sessionId,
        reason: "command:attachFolder",
      }),
    );
  });

  it("主写首次失败会保留 dirty，退避重试成功后才清理", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    memory.updateThread
      .mockRejectedValueOnce(new Error("primary write syntax error"))
      .mockResolvedValueOnce(undefined);

    const state = createSession("schedule-nonbusy-primary-fail");
    await expect(schedulePersist(state, "tool_call_suspended")).resolves.toBeUndefined();

    expect(memory.updateThread).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to persist session metadata",
      expect.objectContaining({
        sessionId: state.sessionId,
        reason: "tool_call_suspended",
        error: "primary write syntax error",
      }),
    );
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 0,
      loopCount: 0,
      pendingCount: 0,
    });
  });

  it("主写失败期间立墓碑会停止退避重试并清理 dirty", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      markSessionDeleted,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    const state = createSession("schedule-deleted-during-failure");
    memory.updateThread.mockImplementationOnce(async () => {
      markSessionDeleted(state.sessionId);
      throw new Error("primary write failed after deletion");
    });

    await expect(schedulePersist(state, "stream_end")).resolves.toBeUndefined();

    expect(memory.updateThread).toHaveBeenCalledTimes(1);
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 0,
      loopCount: 0,
      pendingCount: 0,
    });
  });

  it("主写重试耗尽后拒绝调用方并保留 dirty", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    memory.updateThread.mockRejectedValue(new Error("primary write unavailable"));

    const state = createSession("schedule-primary-exhausted");
    await expect(schedulePersist(state, "stream_end")).rejects.toThrow("primary write unavailable");

    expect(memory.updateThread).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      "Scheduled session metadata persist exhausted retries; session remains dirty",
      expect.objectContaining({
        sessionId: state.sessionId,
        reason: "stream_end",
        attempts: 3,
        error: "primary write unavailable",
      }),
    );
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 1,
      loopCount: 0,
      pendingCount: 1,
    });
  });

  it("关机 drain 会重新尝试已耗尽但仍 dirty 的会话", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const {
      __getSessionPersistenceStateForTest,
      drainSessionPersistence,
      schedulePersist,
    } = await import("../session/threadPersistence.js");
    memory.updateThread.mockRejectedValue(new Error("primary write unavailable"));
    const state = createSession("schedule-shutdown-retry");
    await expect(schedulePersist(state, "stream_end")).rejects.toThrow("primary write unavailable");
    expect(__getSessionPersistenceStateForTest().dirtyCount).toBe(1);

    memory.updateThread.mockResolvedValue(undefined);
    await drainSessionPersistence();

    expect(memory.updateThread).toHaveBeenCalledTimes(4);
    expect(__getSessionPersistenceStateForTest()).toEqual({
      queueCount: 0,
      dirtyCount: 0,
      loopCount: 0,
      pendingCount: 0,
    });
  });

  it("关机 drain 超时会明确记录仍未保存的会话", async () => {
    vi.useFakeTimers();
    try {
      const { createSession } = await import("../session/sessionState.js");
      const {
        drainSessionPersistence,
        schedulePersist,
      } = await import("../session/threadPersistence.js");
      memory.updateThread.mockRejectedValue(new Error("storage offline"));
      const state = createSession("schedule-shutdown-timeout");

      const initialPersist = schedulePersist(state, "stream_end");
      const initialPersistRejection = expect(initialPersist).rejects.toThrow("storage offline");
      await vi.runAllTimersAsync();
      await initialPersistRejection;

      const drain = drainSessionPersistence(25);
      const drainRejection = expect(drain).rejects.toThrow("drainSessionPersistence timed out");
      await vi.advanceTimersByTimeAsync(25);
      await drainRejection;
      expect(logger.error).toHaveBeenCalledWith(
        "会话持久化 drain 超时，仍有未保存会话",
        expect.objectContaining({
          timeoutMs: 25,
          unsavedSessionCount: 1,
          sessionIds: [state.sessionId],
        }),
      );

      // 让已被 timeout race 放到后台的有限重试循环收尾，避免跨测试残留。
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
