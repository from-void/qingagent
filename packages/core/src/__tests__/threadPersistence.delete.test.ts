import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteDocumentFamily, memory, events, logger } = vi.hoisted(() => {
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
    deleteDocumentFamily: vi.fn(async (sessionId: string) => {
      events.push(`documents:${sessionId}`);
    }),
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
  deleteDocumentFamily,
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
    deleteDocumentFamily.mockRejectedValueOnce(new Error("documents cleanup failed"));

    await expect(deleteSessionThread("delete-fail-session")).rejects.toThrow("documents cleanup failed");
    expect(memory.deleteThread).not.toHaveBeenCalled();
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
