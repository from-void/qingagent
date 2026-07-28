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

  it("HTML 端点超时但 Lite 成功时只冷却失败端点，后续直用 Lite", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockImplementation(async () => new Response(
        '<table><tr><td><a class="result-link" href="https://example.com/Healthy">健康结果</a></td></tr>' +
        '<tr><td class="result-snippet">摘要</td></tr></table>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DuckDuckGoProvider().search("健康端点", 3)).resolves.toEqual([
      expect.objectContaining({ url: "https://example.com/Healthy" }),
    ]);
    expect(shouldSkipSearchProvider("ddg")).toBe(false);

    await expect(new DuckDuckGoProvider().search("再次搜索", 3)).resolves.toEqual([
      expect.objectContaining({ url: "https://example.com/Healthy" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://html.duckduckgo.com/html/",
      "https://lite.duckduckgo.com/lite/",
      "https://lite.duckduckgo.com/lite/",
    ]);
  });

  it("两个端点均超时时分别冷却，provider 仍可参与并在 10 分钟后探测", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DuckDuckGoProvider().search("特斯拉 Q4 财报", 3)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(shouldSkipSearchProvider("ddg")).toBe(false);

    const cooledSources = sourceNames(__buildManagedProviderForTest({}));
    expect(cooledSources).toContain("bing");
    expect(cooledSources).toContain("ddg");

    await expect(new DuckDuckGoProvider().search("冷却期间", 3)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await expect(new DuckDuckGoProvider().search("恢复探测", 3)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const restoredSources = sourceNames(__buildManagedProviderForTest({}));
    expect(restoredSources).toContain("bing");
    expect(restoredSources).toContain("ddg");
  });
});
