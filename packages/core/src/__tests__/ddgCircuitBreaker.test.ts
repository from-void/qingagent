import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

import { __resetSearchProviderHealthForTest, shouldSkipSearchProvider } from "../search/health.js";
import { __buildManagedProviderForTest } from "../search/managedSearch.js";
import { DuckDuckGoProvider } from "../search/provider.js";

function sourceNames(provider: unknown): string[] {
  return ((provider as { sources?: Array<{ name: string }> }).sources ?? []).map(
    (source) => source.name,
  );
}

describe("DuckDuckGo 快速熔断", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    __resetSearchProviderHealthForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetSearchProviderHealthForTest();
  });

  it("fetch TimeoutError 触发 ddg 冷却,构建多源时跳过 ddg 且保留 bing,10 分钟后恢复", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timeout", "TimeoutError");
      }),
    );

    await expect(new DuckDuckGoProvider().search("特斯拉 Q4 财报", 3)).resolves.toEqual([]);
    expect(shouldSkipSearchProvider("ddg")).toBe(true);

    const cooledSources = sourceNames(__buildManagedProviderForTest({}));
    expect(cooledSources).toContain("bing");
    expect(cooledSources).not.toContain("ddg");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(shouldSkipSearchProvider("ddg")).toBe(false);

    const restoredSources = sourceNames(__buildManagedProviderForTest({}));
    expect(restoredSources).toContain("bing");
    expect(restoredSources).toContain("ddg");
  });
});
