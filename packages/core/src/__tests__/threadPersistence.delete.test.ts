import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteDocumentFamily, memory, events } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    deleteDocumentFamily: vi.fn(async (sessionId: string) => {
      events.push(`documents:${sessionId}`);
    }),
    memory: {
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
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
  },
  getObservability: () => ({
    getDefaultInstance: () => ({
      startSpan: vi.fn(() => ({ end: vi.fn() })),
    }),
  }),
}));

describe("deleteSessionThread documents 级联顺序", () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
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
});
