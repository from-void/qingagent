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
const mockBalance = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  get: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
}));

vi.mock("@qingagent/core", () => mockCore);
vi.mock("../providerBalanceProbe", () => ({
  refreshDeepseekBalanceSnapshot: mockBalance.refresh,
  getEnvDeepseekBalanceComparison: mockBalance.get,
}));

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
    mockCore.estimateCostCny.mockReset().mockReturnValue(0.123);
    mockCore.hasModelPricing.mockReset().mockReturnValue(true);
    mockCore.aggregateUsageByDay.mockResolvedValue([usageRow]);
    mockCore.aggregateUsageBySession.mockResolvedValue([]);
    mockCore.aggregateUsageTotal.mockResolvedValue([]);
    mockCore.getSessionThreadTitles.mockResolvedValue(new Map([
      ["thread-a", "元数据标题"],
    ]));
    mockCore.getSessionDocumentStatsSince.mockResolvedValue({ docs: 0, words: 0 });
    mockBalance.get.mockResolvedValue(null);
  });

  it("按天看板返回环境 key 的账户余额变动提示，总计视图不重复探测", async () => {
    mockBalance.get.mockResolvedValue({
      provider: "deepseek",
      credentialFingerprint: "not-exposed",
      latestBalanceCny: 18,
      latestAt: "2026-08-08T00:00:00.000Z",
      previousBalanceCny: 20,
      changeCny: -2,
    });
    const app = await loadApp();
    const day = await app.request("/api/v1/usage/summary?view=day&timeZone=UTC");
    expect((await day.json()).providerBalance).toEqual({
      provider: "deepseek",
      latestBalanceCny: 18,
      latestAt: "2026-08-08T00:00:00.000Z",
      previousBalanceCny: 20,
      changeCny: -2,
    });
    expect(mockBalance.refresh).toHaveBeenCalledOnce();
    expect(mockBalance.refresh).toHaveBeenCalledWith({ force: true });

    await app.request("/api/v1/usage/summary?view=total&timeZone=UTC");
    expect(mockBalance.refresh).toHaveBeenCalledOnce();
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

  it("估算 token 与金额单列，不混入 provider 实测金额", async () => {
    mockCore.estimateCostCny
      .mockReturnValueOnce(5.3297)
      .mockReturnValueOnce(2.545);
    mockCore.aggregateUsageByDay.mockResolvedValue([{
      ...usageRow,
      calls: 3,
      estimatedInputTokens: 300,
      estimatedOutputTokens: 80,
      estimatedCacheHitTokens: 200,
      estimatedCacheMissTokens: 100,
      estimatedCalls: 1,
      missingCalls: 1,
      coverageRate: 1 / 3,
    }]);
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/summary?view=day");
    const body = await response.json() as {
      rows: Array<{ costCny?: number; estimatedCostCny?: number }>;
    };

    expect(body.rows[0]).toMatchObject({
      costCny: 5.3297,
      estimatedCostCny: 2.545,
    });
    expect(mockCore.estimateCostCny).toHaveBeenNthCalledWith(1, usageRow.modelId, {
      input: usageRow.inputTokens,
      output: usageRow.outputTokens,
      cacheHit: usageRow.cacheHitTokens,
      cacheMiss: usageRow.cacheMissTokens,
    });
    expect(mockCore.estimateCostCny).toHaveBeenNthCalledWith(2, usageRow.modelId, {
      input: 300,
      output: 80,
      cacheHit: 200,
      cacheMiss: 100,
    });
  });

  it("优先返回调用发生时已落库的金额快照，不按当前价表重算历史", async () => {
    mockCore.estimateCostCny.mockReturnValue(999);
    mockCore.aggregateUsageByDay.mockResolvedValue([{
      ...usageRow,
      calls: 2,
      recordedCalls: 1,
      estimatedCalls: 1,
      estimatedInputTokens: 30,
      estimatedOutputTokens: 5,
      costCny: 0.0123,
      estimatedCostCny: 0.0045,
      peakPricedCalls: 2,
      peakPricingMultiplierMin: 2,
      peakPricingMultiplierMax: 2,
    }]);
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/summary?view=day");
    const body = await response.json() as { rows: Array<Record<string, unknown>> };

    expect(body.rows[0]).toMatchObject({
      costCny: 0.0123,
      estimatedCostCny: 0.0045,
      peakPricedCalls: 2,
      peakPricingMultiplierMin: 2,
      peakPricingMultiplierMax: 2,
    });
    expect(mockCore.estimateCostCny).not.toHaveBeenCalled();
  });

  it("迁移前旧行只按旧基础价兼容，不把当前高峰配置追溯到历史", async () => {
    mockCore.estimateCostCny.mockReturnValue(0.003);
    mockCore.aggregateUsageByDay.mockResolvedValue([{
      ...usageRow,
      inputTokens: 300,
      outputTokens: 60,
      cacheHitTokens: 120,
      cacheMissTokens: 180,
      pricingSnapshotCalls: 1,
      legacyPricingCalls: 1,
      legacyInputTokens: 200,
      legacyOutputTokens: 40,
      legacyCacheHitTokens: 80,
      legacyCacheMissTokens: 120,
      costCny: 0.0123,
      peakPricedCalls: 1,
      peakPricingMultiplierMin: 2,
      peakPricingMultiplierMax: 2,
    }]);
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/summary?view=day");
    const body = await response.json() as { rows: Array<{ costCny?: number }> };

    expect(body.rows[0]?.costCny).toBeCloseTo(0.0153, 12);
    expect(mockCore.estimateCostCny).toHaveBeenCalledOnce();
    expect(mockCore.estimateCostCny).toHaveBeenCalledWith(usageRow.modelId, {
      input: 200,
      output: 40,
      cacheHit: 80,
      cacheMiss: 120,
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
