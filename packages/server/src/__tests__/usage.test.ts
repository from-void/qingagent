import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCore = vi.hoisted(() => ({
  aggregateUsageByDay: vi.fn(),
  aggregateUsageBySession: vi.fn(),
  aggregateUsageTotal: vi.fn(),
  estimateCostCny: vi.fn(() => 0.123),
  hasModelPricing: vi.fn(() => true),
  listSessionThreads: vi.fn(),
}));

vi.mock("@qingagent/core", () => mockCore);

async function loadApp() {
  const { Hono } = await import("hono");
  const { usageRoutes } = await import("../routes/usage");
  const app = new Hono();
  app.route("/api/v1", usageRoutes);
  return app;
}

const usageRow = {
  bucket: "2026-07-26",
  sessionId: "thread-a",
  documentId: "doc-a",
  documentTitle: "文档主表标题",
  callSite: "agent",
  modelId: "deepseek-v4-flash",
  inputTokens: 100,
  outputTokens: 20,
  cacheHitTokens: 40,
  cacheMissTokens: 60,
  cacheCreationTokens: 0,
  cacheHitRate: 0.4,
  calls: 1,
  recordedCalls: 1,
  missingCalls: 0,
  coverageRate: 1,
};

describe("usageRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.aggregateUsageByDay.mockResolvedValue([usageRow]);
    mockCore.aggregateUsageBySession.mockResolvedValue([]);
    mockCore.aggregateUsageTotal.mockResolvedValue([]);
    mockCore.listSessionThreads.mockResolvedValue({
      threads: [
        {
          id: "thread-a",
          title: "线程标题",
          metadata: { title: "元数据标题" },
        },
      ],
      total: 1,
      hasMore: false,
    });
  });

  it("按天响应新增真实文档 ID/标题且不泄露内部 sessionId", async () => {
    const app = await loadApp();
    const response = await app.request(
      "/api/v1/usage/summary?view=day&timezoneOffsetMinutes=420",
    );

    expect(response.status).toBe(200);
    expect(mockCore.aggregateUsageByDay).toHaveBeenCalledWith(30, 420);
    await expect(response.json()).resolves.toEqual({
      view: "day",
      rows: [
        {
          bucket: "2026-07-26",
          documentId: "doc-a",
          documentTitle: "文档主表标题",
          callSite: "agent",
          modelId: "deepseek-v4-flash",
          inputTokens: 100,
          outputTokens: 20,
          cacheHitTokens: 40,
          cacheMissTokens: 60,
          cacheCreationTokens: 0,
          cacheHitRate: 0.4,
          calls: 1,
          recordedCalls: 1,
          missingCalls: 0,
          coverageRate: 1,
          costCny: 0.123,
        },
      ],
    });
  });

  it("拒绝越界的客户端时区偏移", async () => {
    const app = await loadApp();
    const response = await app.request(
      "/api/v1/usage/summary?view=day&timezoneOffsetMinutes=900",
    );

    expect(response.status).toBe(400);
    expect(mockCore.aggregateUsageByDay).not.toHaveBeenCalled();
  });

  it("旧文档主表标题缺失时用真实线程标题兼容补齐", async () => {
    mockCore.aggregateUsageByDay.mockResolvedValue([
      { ...usageRow, documentTitle: undefined },
    ]);
    const app = await loadApp();
    const response = await app.request("/api/v1/usage/summary?view=day");
    const body = await response.json() as { rows: Array<{ documentTitle?: string }> };

    expect(body.rows[0]?.documentTitle).toBe("元数据标题");
  });
});
