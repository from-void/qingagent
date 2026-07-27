import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setSearchFetchForTest } from "../search/apiUtils.js";
import {
  SEARCH_PROVIDER_AUTH_COOLDOWN_MS,
  SEARCH_PROVIDER_AUTH_PROBE_INTERVAL_MS,
  __resetSearchProviderHealthForTest,
  clearSearchProviderHealth,
  getSearchProviderHealth,
  recordSearchProviderError,
  shouldSkipSearchProvider,
} from "../search/health.js";
import { __buildManagedProviderForTest } from "../search/managedSearch.js";
import type { SearchProvider } from "../search/provider.js";

function sourceProvider(provider: SearchProvider, name: string): SearchProvider {
  const sources = (
    provider as unknown as { sources?: Array<{ name: string; provider: SearchProvider }> }
  ).sources ?? [];
  const source = sources.find((candidate) => candidate.name === name);
  if (!source) throw new Error(`missing source: ${name}`);
  return source.provider;
}

describe("API 搜索源认证熔断分级", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    __resetSearchProviderHealthForTest();
  });

  afterEach(() => {
    __setSearchFetchForTest(null);
    vi.useRealTimers();
    __resetSearchProviderHealthForTest();
  });

  it.each([403, 422])("HTTP %i 仅进入短冷却，到期后自动允许探测", async (status) => {
    const startedAt = Date.now();
    recordSearchProviderError("brave", "auth", status);

    expect(getSearchProviderHealth("brave")).toEqual({
      status: "auth",
      authRetryAt: startedAt + SEARCH_PROVIDER_AUTH_COOLDOWN_MS,
    });
    expect(shouldSkipSearchProvider("brave")).toBe(true);

    await vi.advanceTimersByTimeAsync(SEARCH_PROVIDER_AUTH_PROBE_INTERVAL_MS - 1);
    expect(shouldSkipSearchProvider("brave")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(getSearchProviderHealth("brave")).toEqual({ status: "ok" });
    expect(shouldSkipSearchProvider("brave")).toBe(false);
  });

  it("HTTP 401 长期熔断，只有凭据变更触发的显式清理才恢复", async () => {
    recordSearchProviderError("brave", "auth", 401);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(getSearchProviderHealth("brave")).toEqual({ status: "auth" });
    expect(shouldSkipSearchProvider("brave")).toBe(true);

    clearSearchProviderHealth("brave");
    expect(getSearchProviderHealth("brave")).toEqual({ status: "ok" });
  });

  it("ManagedApiProvider 保留 HTTP 状态并把 403 记录为可恢复冷却", async () => {
    __setSearchFetchForTest(
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "temporary forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      ) as unknown as Parameters<typeof __setSearchFetchForTest>[0],
    );
    const managed = __buildManagedProviderForTest({
      brave: { enabled: true, apiKey: "brave-test" },
    });

    await expect(sourceProvider(managed, "brave").search("固态电池", 2)).resolves.toEqual([]);
    expect(getSearchProviderHealth("brave")).toMatchObject({
      status: "auth",
      authRetryAt: Date.now() + SEARCH_PROVIDER_AUTH_COOLDOWN_MS,
    });
  });
});
