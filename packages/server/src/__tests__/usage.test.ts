import { beforeEach, describe, expect, it, vi } from "vitest";

const REVISION = "a".repeat(64);
const sliceSpec = { epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z" }] };
const rawDay = [{ occurredAt: "2026-08-08T00:00:00.000Z" }];
const sliceRows = [{ pricingSlice: 0 }];
const usageRow = {
  bucket: "2026-08-08",
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
  calls: 2,
  recordedCalls: 1,
  estimatedCalls: 1,
  missingCalls: 0,
  coverageRate: 0.5,
  costCny: 0,
  estimatedCostCny: 0.2,
  pricedCalls: 1,
  unpricedCalls: 0,
  estimatedPricedCalls: 1,
  estimatedUnpricedCalls: 0,
  lastAt: "2026-08-08T00:00:00.000Z",
};

const mockCore = vi.hoisted(() => ({
  PRICING_SCHEDULE: { revision: "a".repeat(64), epochs: [] },
  toPricingSliceSpec: vi.fn(() => ({
    epochs: [{ effectiveFrom: "1970-01-01T00:00:00.000Z" }],
  })),
  queryUsageByDay: vi.fn(),
  aggregateUsageBySession: vi.fn(),
  aggregateUsageTotal: vi.fn(),
  priceUsageByDay: vi.fn(),
  priceAggregatedSlices: vi.fn(),
  getSessionDocumentStatsSince: vi.fn(),
  getSessionThreadTitles: vi.fn(),
}));
const mockBalance = vi.hoisted(() => ({
  refresh: vi.fn(async (): Promise<void> => undefined),
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

describe("usageRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCore.queryUsageByDay.mockResolvedValue(rawDay);
    mockCore.aggregateUsageBySession.mockResolvedValue(sliceRows);
    mockCore.aggregateUsageTotal.mockResolvedValue(sliceRows);
    mockCore.priceUsageByDay.mockReturnValue([usageRow]);
    mockCore.priceAggregatedSlices.mockReturnValue([usageRow]);
    mockCore.getSessionThreadTitles.mockResolvedValue(new Map([["thread-a", "元数据标题"]]));
    mockCore.getSessionDocumentStatsSince.mockResolvedValue({ docs: 0, words: 0 });
    mockBalance.get.mockResolvedValue(null);
    mockBalance.refresh.mockResolvedValue(undefined);
  });

  it("day 由 server 组合原始行逐行计价，响应带完整 schedule revision", async () => {
    const app = await loadApp();
    const response = await app.request(
      "/api/v1/usage/summary?view=day&timeZone=America%2FLos_Angeles",
    );
    expect(response.status).toBe(200);
    expect(mockCore.queryUsageByDay).toHaveBeenCalledWith(30, "America/Los_Angeles");
    expect(mockCore.priceUsageByDay).toHaveBeenCalledWith(
      mockCore.PRICING_SCHEDULE,
      rawDay,
    );
    const body = await response.json() as Record<string, unknown>;
    expect(body.scheduleRevision).toBe(REVISION);
    expect(body.scheduleRevision).toMatch(/^[0-9a-f]{64}$/);
    const { sessionId: _sessionId, lastAt: _lastAt, ...publicRow } = usageRow;
    expect(body.rows).toEqual([publicRow]);
    expect(JSON.stringify(body)).not.toContain("sessionId");
    expect(JSON.stringify(body)).not.toContain("lastAt");
  });

  it.each(["session", "total"] as const)("%s 注入 slice spec 后交给 core 折算", async (view) => {
    const app = await loadApp();
    const response = await app.request(`/api/v1/usage/summary?view=${view}`);
    expect(response.status).toBe(200);
    expect(mockCore.toPricingSliceSpec).toHaveBeenCalledWith(mockCore.PRICING_SCHEDULE);
    const aggregate = view === "session"
      ? mockCore.aggregateUsageBySession
      : mockCore.aggregateUsageTotal;
    expect(aggregate).toHaveBeenCalledWith(sliceSpec);
    expect(mockCore.priceAggregatedSlices).toHaveBeenCalledWith(
      mockCore.PRICING_SCHEDULE,
      sliceRows,
    );
  });

  it("day 先返回缓存余额，后台非 force 刷新不阻塞 HTTP", async () => {
    let release: (() => void) | undefined;
    mockBalance.refresh.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    mockBalance.get.mockResolvedValue({
      latestBalanceCny: 18,
      latestAt: "2026-08-08T00:00:00.000Z",
      previousBalanceCny: 20,
      changeCny: -2,
    });
    const app = await loadApp();
    const response = await app.request("/api/v1/usage/summary?view=day");
    expect(response.status).toBe(200);
    expect((await response.json()).providerBalance).toEqual({
      provider: "deepseek",
      latestBalanceCny: 18,
      latestAt: "2026-08-08T00:00:00.000Z",
      previousBalanceCny: 20,
      changeCny: -2,
    });
    expect(mockBalance.refresh).toHaveBeenCalledWith();
    release?.();
  });

  it("会话标题只按入选聚合结果定点读取", async () => {
    const app = await loadApp();
    const response = await app.request("/api/v1/usage/summary?view=session");
    const body = await response.json() as { rows: Array<{ label?: string }> };
    expect(body.rows[0]?.label).toBe("元数据标题");
    expect(mockCore.getSessionThreadTitles).toHaveBeenCalledWith(["thread-a"]);
  });

  it("拒绝无效 IANA 时区且不查询账本", async () => {
    const app = await loadApp();
    const response = await app.request("/api/v1/usage/summary?timeZone=Invalid%2FTimezone");
    expect(response.status).toBe(400);
    expect(mockCore.queryUsageByDay).not.toHaveBeenCalled();
  });

  it("文档统计保持精确时间窗", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
    const app = await loadApp();
    await app.request("/api/v1/usage/docstats?days=7");
    expect(mockCore.getSessionDocumentStatsSince).toHaveBeenCalledWith(
      Date.parse("2026-07-28T12:00:00.000Z"),
    );
    vi.useRealTimers();
  });
});
