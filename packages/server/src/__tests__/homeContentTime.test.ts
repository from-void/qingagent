import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listHomeSessionThreads } = vi.hoisted(() => ({
  listHomeSessionThreads: vi.fn(),
}));

vi.mock("@qingagent/core", async () => {
  const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
  return { ...actual, listHomeSessionThreads };
});

vi.mock("../gateway/bridgeHandler", () => ({
  sessionManager: { disposeSession: vi.fn(async () => undefined) },
}));

describe("GET /home content edit time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updated_at 直接复用查询排序键，且非法底层日期不会触发 toISOString", async () => {
    listHomeSessionThreads.mockResolvedValue({
      threads: [{
        id: "home-content-time",
        title: "内容时间",
        resourceId: "qingagent-user",
        createdAt: new Date("invalid"),
        updatedAt: new Date("invalid"),
        createdAtIso: "1970-01-01T00:00:00.000Z",
        contentEditedAt: "2026-07-08T09:10:11.123Z",
        metadata: {
          docState: { kind: "editing" },
          docVersion: 1,
          lastSyncedDocumentSnapshot: 1,
          legacySections: [],
          materials: [],
          title: "内容时间",
          runId: null,
          toolCallId: null,
          askUserCompleted: false,
          lastPersistedAt: "2026-01-01T00:00:00.000Z",
        },
      }],
      total: 1,
      hasMore: false,
    });
    const { homeRoutes } = await import("../routes/home");
    const app = new Hono();
    app.route("/api/v1", homeRoutes);

    const response = await app.request("/api/v1/home");
    const body = await response.json() as {
      recent_sessions: Array<{ created_at: string; updated_at: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.recent_sessions[0]).toMatchObject({
      created_at: "1970-01-01T00:00:00.000Z",
      updated_at: "2026-07-08T09:10:11.123Z",
    });
  });
});
