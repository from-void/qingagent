import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../search/provider.js";

const mockSearchDeps = vi.hoisted(() => {
  type PrimaryConfig = { enabled: boolean; apiKey?: string };
  const fetchDeepseekSearchLinks = vi.fn(async (): Promise<SearchResult[]> => []);
  const fallbackSearch = vi.fn(async (): Promise<SearchResult[]> => []);
  return {
    fetchDeepseekSearchLinks,
    fallbackSearch,
    getManagedSearchProvider: vi.fn(async () => ({ search: fallbackSearch })),
    getPrimarySearchConfig: vi.fn(async (): Promise<PrimaryConfig> => ({ enabled: true })),
  };
});

const mockObservabilityDeps = vi.hoisted(() => ({
  getObservability: vi.fn(() => null),
}));

vi.mock("../search/deepseekWebSearch.js", () => ({
  fetchDeepseekSearchLinks: mockSearchDeps.fetchDeepseekSearchLinks,
}));

vi.mock("../search/managedSearch.js", () => ({
  getManagedSearchProvider: mockSearchDeps.getManagedSearchProvider,
  getPrimarySearchConfig: mockSearchDeps.getPrimarySearchConfig,
}));

vi.mock("../mastra.js", () => ({
  getObservability: mockObservabilityDeps.getObservability,
}));

import {
  __resetSearchCacheForTest,
  clearSearchCache,
  getCachedSearch,
  setCachedSearch,
} from "../search/searchCache.js";
import { searchLinksForEval } from "../tools/webSearch.js";

const fallbackResult: SearchResult = {
  title: "多源结果",
  url: "https://fallback.example/source",
  snippet: "fallback",
};

const deepseekResult: SearchResult = {
  title: "DeepSeek 结果",
  url: "https://deepseek.example/source",
  snippet: "deepseek",
};

function result(id: string): SearchResult {
  return {
    title: `Result ${id}`,
    url: `https://example.com/${id}`,
    snippet: id,
  };
}

describe("searchCache", () => {
  beforeEach(() => {
    __resetSearchCacheForTest();
    mockSearchDeps.fetchDeepseekSearchLinks.mockReset();
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([]);
    mockSearchDeps.fallbackSearch.mockReset();
    mockSearchDeps.fallbackSearch.mockResolvedValue([fallbackResult]);
    mockSearchDeps.getManagedSearchProvider.mockClear();
    mockSearchDeps.getManagedSearchProvider.mockResolvedValue({ search: mockSearchDeps.fallbackSearch });
    mockSearchDeps.getPrimarySearchConfig.mockReset();
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true });
    mockObservabilityDeps.getObservability.mockReset();
    mockObservabilityDeps.getObservability.mockReturnValue(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetSearchCacheForTest();
  });

  it("同 key 二次检索命中缓存,真实多源只调一次", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });

    await expect(searchLinksForEval("  Cache   Query  ", " Cache Keyword ", 3, "")).resolves.toEqual([
      fallbackResult,
    ]);
    await expect(searchLinksForEval("cache query", "cache keyword", 3, "")).resolves.toEqual([
      fallbackResult,
    ]);

    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledTimes(1);
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledWith(
      "Cache Keyword",
      3,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("TTL 过期后删除缓存并重新真实检索", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });

    await searchLinksForEval("ttl query", "ttl", 2, "");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await searchLinksForEval("ttl query", "ttl", 2, "");

    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledTimes(2);
  });

  it("provider 设置更新清缓存后，同 key 不再返回旧结果", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    const updatedResult = result("updated-provider");
    mockSearchDeps.fallbackSearch
      .mockResolvedValueOnce([fallbackResult])
      .mockResolvedValueOnce([updatedResult]);

    await expect(searchLinksForEval("provider update", "same-key", 2, "")).resolves.toEqual([
      fallbackResult,
    ]);
    clearSearchCache();
    await expect(searchLinksForEval("provider update", "same-key", 2, "")).resolves.toEqual([
      updatedResult,
    ]);

    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledTimes(2);
  });

  it("空结果不写缓存", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    mockSearchDeps.fallbackSearch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([fallbackResult]);

    await expect(searchLinksForEval("empty query", "empty", 2, "")).resolves.toEqual([]);
    await expect(searchLinksForEval("empty query", "empty", 2, "")).resolves.toEqual([fallbackResult]);

    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledTimes(2);
  });

  it("第 101 个 key 逐出最旧 key", () => {
    for (let i = 0; i < 101; i += 1) {
      setCachedSearch(`k-${i}`, [result(String(i))]);
    }

    expect(getCachedSearch("k-0")).toBeNull();
    expect(getCachedSearch("k-1")).toEqual([result("1")]);
    expect(getCachedSearch("k-100")).toEqual([result("100")]);
  });

  it("DeepSeek 可用维度不同不会串用缓存", async () => {
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: true });
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([deepseekResult]);

    await expect(searchLinksForEval("same query", "same", 2, "")).resolves.toEqual([fallbackResult]);
    await expect(searchLinksForEval("same query", "same", 2, "sk-live")).resolves.toEqual([
      deepseekResult,
    ]);
    await expect(searchLinksForEval("same query", "same", 2, "")).resolves.toEqual([fallbackResult]);
    await expect(searchLinksForEval("same query", "same", 2, "sk-live")).resolves.toEqual([
      deepseekResult,
    ]);

    // DeepSeek 可用时多源兜底仍并发起跑一次,但不会复用 ds:0 的缓存结果。
    expect(mockSearchDeps.fallbackSearch).toHaveBeenCalledTimes(2);
    expect(mockSearchDeps.fetchDeepseekSearchLinks).toHaveBeenCalledTimes(1);
  });
});

describe("webSearch.links span", () => {
  beforeEach(() => {
    __resetSearchCacheForTest();
    mockSearchDeps.fetchDeepseekSearchLinks.mockReset();
    mockSearchDeps.fetchDeepseekSearchLinks.mockResolvedValue([]);
    mockSearchDeps.fallbackSearch.mockReset();
    mockSearchDeps.fallbackSearch.mockResolvedValue([fallbackResult]);
    mockSearchDeps.getManagedSearchProvider.mockClear();
    mockSearchDeps.getManagedSearchProvider.mockResolvedValue({ search: mockSearchDeps.fallbackSearch });
    mockSearchDeps.getPrimarySearchConfig.mockReset();
    mockSearchDeps.getPrimarySearchConfig.mockResolvedValue({ enabled: false });
    mockObservabilityDeps.getObservability.mockReset();
    mockObservabilityDeps.getObservability.mockReturnValue(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetSearchCacheForTest();
  });

  it("span 创建失败不影响 searchLinks 返回结果", async () => {
    mockObservabilityDeps.getObservability.mockImplementation(() => {
      throw new Error("observability down");
    });

    await expect(searchLinksForEval("span fail", "span", 2, "")).resolves.toEqual([fallbackResult]);
  });

  it("缓存命中仍触发 done 日志和 cacheHit=true 的 span", async () => {
    const end = vi.fn();
    const startSpan = vi.fn(() => ({ end }));
    mockObservabilityDeps.getObservability.mockReturnValue({
      getDefaultInstance: () => ({ startSpan }),
    } as never);

    await searchLinksForEval("span cache", "span", 2, "");
    startSpan.mockClear();
    end.mockClear();

    await expect(searchLinksForEval("span cache", "span", 2, "")).resolves.toEqual([fallbackResult]);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("via cache"));
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "webSearch.links",
        metadata: expect.objectContaining({
          cacheHit: true,
          source: "cache",
          resultCount: 1,
          zeroHit: false,
        }),
      }),
    );
    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          cacheHit: true,
          source: "cache",
        }),
      }),
    );
  });
});
