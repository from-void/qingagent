import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../search/provider.js";
import type { ResearchCardBody } from "@qingagent/contract-ts";

const mockSearchDeps = vi.hoisted(() => {
  type PrimaryConfig = { enabled: boolean; apiKey?: string };
  const fetchDeepseekSearchLinks = vi.fn(async (): Promise<SearchResult[]> => []);
  const fallbackSearch = vi.fn();

  return {
    fetchDeepseekSearchLinks,
    fallbackSearch,
    getManagedSearchProvider: vi.fn(async () => ({ search: fallbackSearch })),
    getPrimarySearchConfig: vi.fn(async (): Promise<PrimaryConfig> => ({ enabled: true })),
  };
});

const mockFetchDeps = vi.hoisted(() => ({
  fetchArticleExecute: vi.fn(),
}));

vi.mock("../search/deepseekWebSearch.js", () => ({
  fetchDeepseekSearchLinks: mockSearchDeps.fetchDeepseekSearchLinks,
}));

vi.mock("../search/managedSearch.js", () => ({
  getManagedSearchProvider: mockSearchDeps.getManagedSearchProvider,
  getPrimarySearchConfig: mockSearchDeps.getPrimarySearchConfig,
}));

vi.mock("../tools/fetchArticle.js", () => ({
  fetchArticleTool: { execute: mockFetchDeps.fetchArticleExecute },
}));

import { webSearchTool } from "../tools/webSearch.js";

const oldDeepseekEnv = process.env.DEEPSEEK_API_KEY;

type WebSearchOutput = {
  ok: boolean;
  query: string;
  note?: string;
  items: Array<{
    url: string;
    title: string;
    snippet: string;
    status: "done" | "browser" | "skipped";
    wordCount: number;
    materialId: string;
    truncated: boolean;
    text: string;
  }>;
};

const deepseekResult: SearchResult = {
  title: "DeepSeek 来源",
  url: "https://deepseek.example/source",
  snippet: "",
};

const fallbackResult: SearchResult = {
  title: "Fallback",
  url: "https://fallback.example/source",
  snippet: "fallback",
};

const goodText =
  "这是一段可用于研究的真实正文，包含清晰事实、背景、原因和影响分析。".repeat(12);
const browserText =
  "浏览器渲染后得到的完整正文，包含事件经过、关键数据、来源背景和后续影响。".repeat(12);
const hollowText = "正在加载... 返回首页 分享到微信";

function wordCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function articleResult(
  url: string,
  title = "静态标题",
  text = goodText,
  via: "static" | "browser" = "static",
) {
  return {
    title,
    text,
    wordCount: wordCount(text),
    images: [],
    screenshotSrc: null,
    ogImageUrl: null,
    sourceUrl: url,
    materialId: "mat-test",
    via,
  };
}

async function executeWebSearch(
  input: { query: string; keywords?: string | null; count?: number },
  context: Record<string, unknown> = {},
) {
  return (await webSearchTool.execute!(input as never, context as never)) as WebSearchOutput;
}

describe("webSearchTool.execute — DeepSeek×多源 并发竞速 + 搜索即抓取", () => {
  beforeEach(() => {
    mockSearchDeps.fetchDeepseekSearchLinks.mockReset();
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([]);
    mockSearchDeps.fallbackSearch.mockReset();
    mockSearchDeps.fallbackSearch.mockResolvedValue([fallbackResult]);
    mockSearchDeps.getManagedSearchProvider.mockClear();
    mockSearchDeps.getManagedSearchProvider.mockResolvedValue({ search: mockSearchDeps.fallbackSearch });
    mockSearchDeps.getPrimarySearchConfig.mockReset();
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true });
    mockFetchDeps.fetchArticleExecute.mockReset();
    mockFetchDeps.fetchArticleExecute.mockImplementation(async ({ url }: { url: string }) =>
      articleResult(url),
    );
    delete process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (oldDeepseekEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepseekEnv;
  });

  it("enabled+有 key 且 DeepSeek 在预算内返回 → 质量优先用 DeepSeek 链接并抓正文", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true, apiKey: "cfg-key" });
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([deepseekResult]);

    const result = await executeWebSearch({
      query: "  今日 新闻  ",
      keywords: " 今日\n新闻   2026 ",
      count: 4,
    });

    expect(result.ok).toBe(true);
    expect(result.query).toBe("今日 新闻");
    expect(result.items).toEqual([
      {
        url: deepseekResult.url,
        title: "静态标题",
        snippet: deepseekResult.snippet,
        status: "done",
        wordCount: wordCount(goodText),
        materialId: "mat-test",
        truncated: false,
        text: goodText,
      },
    ]);
    expect(mockSearchDeps.fetchDeepseekSearchLinks).toHaveBeenCalledWith("今日 新闻", "cfg-key", 4);
    // 多源始终并发起跑(兜底),即便最终没用到它;传统源使用 keywords。
    expect(mockSearchDeps.getManagedSearchProvider).toHaveBeenCalled();
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledWith("今日 新闻 2026", 4);
  });

  // 回归(0702 桌面验收根因):桌面端 DeepSeek key 是 visitor 层(x-deepseek-key header,服务端不落盘),
  // 无搜索专配 key、无 env DEEPSEEK_API_KEY。修复前 deepseekKey 恒空 → 永远回退 Bing 垃圾;
  // 修复后应从 requestContext 的 modelOverrides.visitorApiKey 取到 key 并走 DeepSeek。
  it("桌面 visitor key:无专配 key/无 env 时,从 requestContext 取 visitor key 走 DeepSeek(不回退多源)", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true }); // 无搜索专配 key
    delete process.env.DEEPSEEK_API_KEY; // 无 env(桌面场景)
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([deepseekResult]);

    const requestContext = {
      get: (key: string) =>
        key === "modelOverrides" ? { visitorApiKey: "sk-visitor-desktop" } : undefined,
    };
    const result = await executeWebSearch({ query: "英格兰 刚果金 世界杯" }, { requestContext });

    expect(mockSearchDeps.fetchDeepseekSearchLinks).toHaveBeenCalledWith(
      "英格兰 刚果金 世界杯",
      "sk-visitor-desktop",
      8,
    );
    expect(result.items[0]?.url).toBe(deepseekResult.url);
  });

  it("disabled 时跳过 DeepSeek 只走多源,默认抓取 8 条", async () => {
    process.env.DEEPSEEK_API_KEY = "env-key";
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false, apiKey: "cfg-key" });

    const result = await executeWebSearch({ query: "fallback", keywords: "fallback keyword" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe(fallbackResult.url);
    expect(mockSearchDeps.fetchDeepseekSearchLinks).not.toHaveBeenCalled();
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledWith("fallback keyword", 8);
  });

  it("keywords 为 null/缺省时,多源回退使用 query", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });

    await executeWebSearch({ query: "fallback query", keywords: null, count: 2 });
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledWith("fallback query", 2);
  });

  it("配置 key 优先级高于 env key", async () => {
    process.env.DEEPSEEK_API_KEY = "env-key";
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true, apiKey: "cfg-key" });
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([deepseekResult]);

    await executeWebSearch({ query: "priority" });

    expect(mockSearchDeps.fetchDeepseekSearchLinks).toHaveBeenCalledWith("priority", "cfg-key", 8);
  });

  it("DeepSeek 返回空 → 用并发已就绪的多源", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true, apiKey: "cfg-key" });
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([]);

    const result = await executeWebSearch({ query: "empty ds", count: 3 });

    expect(result.items.map((item) => item.url)).toEqual([fallbackResult.url]);
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledWith("empty ds", 3);
  });

  it("最终 0 召回时返回可执行重试建议 note", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    mockSearchDeps.fallbackSearch.mockResolvedValue([]);

    const result = await executeWebSearch({ query: "无结果 查询", count: 3 });

    expect(result.items).toEqual([]);
    expect(result.note).toBe("未检索到相关结果;请精简为 2-6 个关键词后重试,或改写检索角度");
    expect(mockFetchDeps.fetchArticleExecute).not.toHaveBeenCalled();
  });

  it("DeepSeek 5s 内没回来 → 超时后用多源(整体 5s 封顶)", async () => {
    vi.useFakeTimers();
    // 必须 try/finally 复原 real timers:否则 fake timers 泄漏到同进程后续串行文件,
    // 把它们的真实 setTimeout 卡住→无关用例随机超时(本轮组合跑就这样冷启偶发超时)。
    try {
      mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true, apiKey: "cfg-key" });
      // DeepSeek 永不返回,模拟它墨迹/卡住
      mockSearchDeps.fetchDeepseekSearchLinks.mockReturnValue(new Promise<SearchResult[]>(() => {}));
      mockSearchDeps.fallbackSearch.mockResolvedValue([fallbackResult]);

      const pending = executeWebSearch({ query: "slow ds" });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.items.map((item) => item.url)).toEqual([fallbackResult.url]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("并发抓取保持搜索顺序,区分 done/browser/skipped 并写出抓取进度", async () => {
    const results: SearchResult[] = [
      { title: "一", url: "https://example.com/static", snippet: "s1" },
      { title: "二", url: "https://example.com/browser", snippet: "s2" },
      { title: "三", url: "https://example.com/empty", snippet: "s3" },
    ];
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    mockSearchDeps.fallbackSearch.mockResolvedValue(results);
    mockFetchDeps.fetchArticleExecute.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/browser")) return articleResult(url, "二浏览器正文", browserText, "browser");
      if (url.endsWith("/empty")) return articleResult(url, "三空壳", "[Error] blocked", "static");
      return articleResult(url, "一静态正文", goodText, "static");
    });
    const writes: Array<{ type?: string; progress?: ResearchCardBody }> = [];
    const writer = { write: vi.fn((chunk) => writes.push(chunk)) };

    const result = await executeWebSearch({ query: "progress", count: 3 }, { writer });

    expect(result.items.map((item) => item.url)).toEqual(results.map((item) => item.url));
    expect(result.items.map((item) => item.status)).toEqual(["done", "browser", "skipped"]);
    expect(result.items[0]?.wordCount).toBe(wordCount(goodText));
    expect(result.items[1]?.wordCount).toBe(wordCount(browserText));
    expect(result.items[1]?.text).toBe(browserText);
    expect(result.items[2]?.wordCount).toBe(0);
    expect(result.items[2]?.text).toBe("");
    expect(mockFetchDeps.fetchArticleExecute).toHaveBeenCalledTimes(3);
    expect(mockFetchDeps.fetchArticleExecute).toHaveBeenCalledWith(
      { url: "https://example.com/browser" },
      expect.objectContaining({ writer }),
    );

    const progressEvents = writes
      .filter((write) => write.type === "research-progress")
      .map((write) => write.progress!);
    expect(progressEvents[0]?.phase).toBe("searching");
    expect(progressEvents.some((event) => event.phase === "fetching")).toBe(true);
    expect(progressEvents.some((event) =>
      event.items.some((item) => item.url.endsWith("/browser") && item.status === "browser")
    )).toBe(true);
    const done = progressEvents.at(-1)!;
    expect(done.phase).toBe("done");
    expect(done.total).toBe(3);
    expect(done.fetchedCount).toBe(3);
    expect(done.okCount).toBe(2);
    expect(done.skippedCount).toBe(1);
    expect(done.items.map((item) => item.status)).toEqual(["done", "done", "skipped"]);
    expect(done.items[1]?.wordCount).toBe(wordCount(browserText));
  });

  it("返回给模型的 text 只含节选,全文经 research-fulltext 旁路写给 bridge", async () => {
    const longText =
      "这是一篇超长研究材料，包含事实、背景、关键数据、影响分析、来源信息和完整论证。".repeat(180);
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    mockSearchDeps.fallbackSearch.mockResolvedValue([
      { title: "长文来源", url: "https://example.com/long", snippet: "长文摘要" },
    ]);
    mockFetchDeps.fetchArticleExecute.mockResolvedValue(
      articleResult("https://example.com/long", "长文标题", longText, "static"),
    );
    const writes: Array<{ type?: string; items?: Array<{ text: string; materialId: string }> }> = [];
    const writer = { write: vi.fn((chunk) => writes.push(chunk)) };

    const result = await executeWebSearch({ query: "long", count: 1 }, { writer });

    const item = result.items[0]!;
    expect(item.text.length).toBeLessThanOrEqual(2500);
    expect(item.text).toBe(longText.slice(0, 2500));
    expect(item.truncated).toBe(true);
    expect(item.materialId).toEqual(expect.any(String));
    expect(item.materialId.length).toBeGreaterThan(0);
    expect(item.wordCount).toBe(wordCount(longText));
    expect(item).not.toHaveProperty("__fullText");

    const fullTextChunk = writes.find((write) => write.type === "research-fulltext");
    expect(fullTextChunk).toBeTruthy();
    expect(fullTextChunk?.items).toHaveLength(1);
    expect(fullTextChunk?.items?.[0]?.text).toBe(longText);
    expect(fullTextChunk?.items?.[0]?.text.length).toBeGreaterThan(2500);
    expect(fullTextChunk?.items?.[0]?.materialId).toBe(item.materialId);
  });
});
