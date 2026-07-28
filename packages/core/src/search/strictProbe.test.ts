import { afterEach, describe, expect, it, vi } from "vitest";
import { BingProvider } from "./bing.js";
import { DuckDuckGoProvider } from "./provider.js";
import { SearxngProvider } from "./searxng.js";

vi.mock("@qingagent/doc-render/browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@qingagent/doc-render/browser")>();
  return {
    ...actual,
    validateFetchUrl: vi.fn(async (raw: string | URL) => new URL(raw)),
  };
});

describe("免费搜索源严格连通探测", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["Bing", () => new BingProvider()],
    ["DuckDuckGo", () => new DuckDuckGoProvider()],
    ["SearXNG", () => new SearxngProvider("https://search.example.com")],
  ])("%s 网络失败在正常搜索中降级为空，严格探测中抛出", async (_name, createProvider) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const provider = createProvider();

    await expect(provider.search("测试", 3)).resolves.toEqual([]);
    await expect(provider.search("测试", 3, { strict: true })).rejects.toThrow("fetch failed");
  });

  it.each([
    ["Bing", () => new BingProvider()],
    ["SearXNG", () => new SearxngProvider("https://search.example.com")],
  ])("%s HTTP 故障只在严格探测中抛出", async (_name, createProvider) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const provider = createProvider();

    await expect(provider.search("测试", 3)).resolves.toEqual([]);
    await expect(provider.search("测试", 3, { strict: true })).rejects.toThrow("HTTP 503");
  });

  it("SearXNG 有效空响应仍算严格探测成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [] })));

    await expect(
      new SearxngProvider("https://search.example.com").search("测试", 3, { strict: true }),
    ).resolves.toEqual([]);
  });

  it("SearXNG JSON 解析失败在严格探测中抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(
      new SearxngProvider("https://search.example.com").search("测试", 3, { strict: true }),
    ).rejects.toThrow();
  });
});
