import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSessionSummariesWithExistingThreads: vi.fn(),
  listWithExistingThreads: vi.fn(),
  getOrRestoreSessionReadOnly: vi.fn(),
}));

vi.mock("@qingagent/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@qingagent/core")>();
  return {
    ...actual,
    documentRepo: {
      ...actual.documentRepo,
      listSessionSummariesWithExistingThreads:
        mocks.listSessionSummariesWithExistingThreads,
      listWithExistingThreads: mocks.listWithExistingThreads,
    },
  };
});

vi.mock("../gateway/sessionLifecycle", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../gateway/sessionLifecycle")
  >();
  return {
    ...actual,
    getOrRestoreSessionReadOnly: mocks.getOrRestoreSessionReadOnly,
  };
});

import { sessionManager } from "../gateway/bridgeHandler";
import { externalRoutes } from "../routes/external";

describe("external sessions 稳定快照", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.listSessionSummariesWithExistingThreads.mockReset();
    mocks.listWithExistingThreads.mockReset();
    mocks.getOrRestoreSessionReadOnly.mockReset();
  });

  it("大集合首页只冻结小摘要，不读取 PM 全行或等待逐会话恢复", async () => {
    const summaries = Array.from({ length: 5_000 }, (_, index) => ({
      id: `session-${String(index).padStart(5, "0")}`,
      title: `会话 ${index}`,
      docState: "editing",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }));
    mocks.listSessionSummariesWithExistingThreads.mockResolvedValue(summaries);
    mocks.listWithExistingThreads.mockResolvedValue({
      rows: summaries,
      total: summaries.length,
    });
    mocks.getOrRestoreSessionReadOnly.mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.spyOn(sessionManager, "listSessionIds").mockReturnValue([]);
    const app = new Hono();
    app.route("/api/v1/external", externalRoutes);

    const response = await withDeadline(
      Promise.resolve(
        app.request("/api/v1/external/sessions?limit=5&cursor=start"),
      ),
      250,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      sessions: summaries.slice(0, 5).map(({ docState, ...summary }) => ({
        ...summary,
        state: docState,
      })),
      total: summaries.length,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(mocks.listSessionSummariesWithExistingThreads).toHaveBeenCalledWith({
      resourceId: "qingagent-user",
      limit: 50_001,
    });
    expect(mocks.listWithExistingThreads).not.toHaveBeenCalled();
    expect(mocks.getOrRestoreSessionReadOnly).not.toHaveBeenCalled();
  });
});

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
