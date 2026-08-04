import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCore = vi.hoisted(() => ({
  aggregateUsageByDay: vi.fn(),
  aggregateUsageBySession: vi.fn(),
  aggregateUsageTotal: vi.fn(),
  estimateCostCny: vi.fn(() => 0.123),
  getSessionDocumentStatsSince: vi.fn(),
  getSessionThreadTitles: vi.fn(),
  hasModelPricing: vi.fn(() => true),
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
  coldStartMissTokens: 60,
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
    mockCore.getSessionThreadTitles.mockResolvedValue(new Map([
      ["thread-a", "元数据标题"],
    ]));
    mockCore.getSessionDocumentStatsSince.mockResolvedValue({ docs: 0, words: 0 });
  });

  it("按天响应新增真实文档 ID/标题且不泄露内部 sessionId", async () => {
    const app = await loadApp();
    const response = await app.request(
      "/api/v1/usage/summary?view=day&timeZone=America%2FLos_Angeles",
    );

    expect(response.status).toBe(200);
    expect(mockCore.aggregateUsageByDay).toHaveBeenCalledWith(30, "America/Los_Angeles");
    expect(mockCore.getSessionThreadTitles).toHaveBeenCalledWith([]);
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
          coldStartMissTokens: 60,
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

  it("拒绝无效的 IANA 时区", async () => {
    const app = await loadApp();
    const response = await app.request(
      "/api/v1/usage/summary?view=day&timeZone=Invalid%2FTimezone",
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

  it("会话标题只按聚合结果中的 id 定点读取", async () => {
    mockCore.aggregateUsageBySession.mockResolvedValue([
      { ...usageRow, bucket: "thread-201", sessionId: "thread-201" },
    ]);
    mockCore.getSessionThreadTitles.mockResolvedValue(new Map([
      ["thread-201", "第 201 条标题"],
    ]));
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/summary?view=session");
    const body = await response.json() as { rows: Array<{ label?: string }> };

    expect(body.rows[0]?.label).toBe("第 201 条标题");
    expect(mockCore.getSessionThreadTitles).toHaveBeenCalledWith(["thread-201"]);
  });

  it("文档统计把精确时间窗下推到字段级查询", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
      mockCore.getSessionDocumentStatsSince.mockResolvedValue({ docs: 1, words: 4 });
      const app = await loadApp();

      const response = await app.request("/api/v1/usage/docstats?days=7");

      await expect(response.json()).resolves.toEqual({
        days: 7,
        docs: 1,
        words: 4,
      });
      expect(mockCore.getSessionDocumentStatsSince).toHaveBeenCalledWith(
        Date.parse("2026-07-28T12:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
