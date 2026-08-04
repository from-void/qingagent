import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  beginSessionDeletion,
  completeSessionDeletion,
  deleteSessionDocumentsAndAdvance,
  memory,
  events,
  logger,
} = vi.hoisted(() => {
  const events: string[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    events,
    logger,
    beginSessionDeletion: vi.fn(async (sessionId: string) => ({
      sessionId,
      phase: "draining" as const,
    })),
    deleteSessionDocumentsAndAdvance: vi.fn(async (sessionId: string) => {
      events.push(`documents:${sessionId}`);
      return "documents_deleted" as const;
    }),
    completeSessionDeletion: vi.fn(async () => undefined),
    memory: {
      updateThread: vi.fn(async () => undefined),
      saveThread: vi.fn(async () => undefined),
      deleteThread: vi.fn(async (sessionId: string) => {
        events.push(`thread:${sessionId}`);
      }),
    },
  };
});

vi.mock("@qingagent/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qingagent/db")>()),
  resolveDbUrl: () => "file::memory:",
  beginSessionDeletion,
  completeSessionDeletion,
  deleteSessionDocumentsAndAdvance,
}));

vi.mock("../mastra.js", () => ({
  mastra: {
    getLogger: () => logger,
    getMemory: () => memory,
  },
  getObservability: () => ({
    getDefaultInstance: () => ({
      startSpan: vi.fn(() => ({ end: vi.fn() })),
    }),
  }),
}));

describe("deleteSessionThread documents 级联顺序", () => {
  beforeEach(async () => {
    events.length = 0;
    vi.clearAllMocks();
    const { __resetSessionPersistenceForTest } = await import(
      "../session/threadPersistence.js"
    );
    __resetSessionPersistenceForTest();
  });

  it("先删除 documents 族,再删除 Mastra thread", async () => {
    const { deleteSessionThread } = await import("../session/threadPersistence.js");

    await deleteSessionThread("delete-order-session");

    expect(events).toEqual(["documents:delete-order-session", "thread:delete-order-session"]);
  });

  it("documents 族删除失败时抛错并阻断 Mastra thread 删除", async () => {
    const { deleteSessionThread } = await import("../session/threadPersistence.js");
    deleteSessionDocumentsAndAdvance.mockRejectedValueOnce(new Error("documents cleanup failed"));

    await expect(deleteSessionThread("delete-fail-session")).rejects.toThrow("documents cleanup failed");
    expect(memory.deleteThread).not.toHaveBeenCalled();
  });

  it("F2: documents 删除已提交后 thread 删除失败会携带 documents_deleted 阶段", async () => {
    const { deleteSessionThread } = await import("../session/threadPersistence.js");
    memory.deleteThread.mockRejectedValueOnce(new Error("thread cleanup failed"));

    await expect(deleteSessionThread("delete-thread-fail-session")).rejects.toMatchObject({
      phase: "documents_deleted",
    });
    expect(events).toEqual(["documents:delete-thread-fail-session"]);
  });

  it("墓碑在 updateThread 返回 not-found 后阻止 saveThread 复建", async () => {
    const { createSession } = await import("../session/sessionState.js");
    const { markSessionDeleted, persistSessionMetadata } = await import(
      "../session/threadPersistence.js"
    );
    const state = createSession("deleted-during-persist");
    state.threadId = state.sessionId;
    memory.updateThread.mockImplementationOnce(async () => {
      markSessionDeleted(state.sessionId);
      throw new Error("thread not found");
    });

    await persistSessionMetadata(state, "test:deleted-during-update");

    expect(memory.saveThread).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Refusing to recreate deleted session thread",
      expect.objectContaining({ sessionId: state.sessionId }),
    );
  });
});
