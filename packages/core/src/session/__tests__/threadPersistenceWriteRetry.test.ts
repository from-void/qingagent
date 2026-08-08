import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../sessionState.js";
import type { QingagentThreadMetadata } from "../threadPersistence.js";
import { withWriteRetry } from "@qingagent/db";

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

vi.mock("../../agent-run/agentSpans.js", () => ({
  sessionIdToTraceId: (sessionId: string) => `trace-${sessionId}`,
}));

beforeEach(() => {
  threads.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("thread persistence write retry", () => {
  it("retries SQLITE_BUSY primary metadata writes and eventually persists suspension ids", async () => {
    const { persistSessionMetadata } = await import("../threadPersistence.js");
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
