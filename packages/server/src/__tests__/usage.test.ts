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
      "/api/v1/usage/summary?view=day&timeZone=America%2FLos_Angeles",
    );

    expect(response.status).toBe(200);
    expect(mockCore.aggregateUsageByDay).toHaveBeenCalledWith(30, "America/Los_Angeles");
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

  it("会话标题全量读取线程，不遗漏第 201 条后的标题", async () => {
    mockCore.aggregateUsageBySession.mockResolvedValue([
      { ...usageRow, bucket: "thread-201", sessionId: "thread-201" },
    ]);
    const threads = Array.from({ length: 201 }, (_, index) => ({
      id: `thread-${index + 1}`,
      title: `线程 ${index + 1}`,
      metadata: index === 200 ? { title: "第 201 条标题" } : {},
    }));
    mockCore.listSessionThreads.mockImplementation(async (
      opts: { perPage?: number | false },
    ) => ({
      threads: opts.perPage === false ? threads : threads.slice(0, 200),
      total: threads.length,
      hasMore: opts.perPage !== false,
    }));
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/summary?view=session");
    const body = await response.json() as { rows: Array<{ label?: string }> };

    expect(body.rows[0]?.label).toBe("第 201 条标题");
    expect(mockCore.listSessionThreads).toHaveBeenCalledWith({
      page: 0,
      perPage: false,
    });
  });

  it("文档统计全量读取线程，不在 updatedAt 前 200 条上截断 createdAt 窗口", async () => {
    const oldDate = new Date(Date.now() - 30 * 86_400_000);
    const recentDate = new Date();
    const threads = Array.from({ length: 201 }, (_, index) => ({
      id: `thread-${index + 1}`,
      createdAt: index === 200 ? recentDate : oldDate,
      metadata: index === 200
        ? {
            doc: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "遗漏文档" }] },
              ],
            },
          }
        : {},
    }));
    mockCore.listSessionThreads.mockImplementation(async (
      opts: { perPage?: number | false },
    ) => ({
      threads: opts.perPage === false ? threads : threads.slice(0, 200),
      total: threads.length,
      hasMore: opts.perPage !== false,
    }));
    const app = await loadApp();

    const response = await app.request("/api/v1/usage/docstats?days=7");

    await expect(response.json()).resolves.toEqual({
      days: 7,
      docs: 1,
      words: 4,
    });
    expect(mockCore.listSessionThreads).toHaveBeenCalledWith({
      page: 0,
      perPage: false,
    });
  });
});
