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

  it.each([
    [
      "Bing",
      () => new BingProvider(),
      "<html><body>request blocked</body></html>",
    ],
    [
      "DuckDuckGo",
      () => new DuckDuckGoProvider(),
      "<html><body>verify you are human</body></html>",
    ],
  ])("%s 无效或反爬 HTML 不得在严格探测中冒充空结果", async (
    _name,
    createProvider,
    html,
  ) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));

    await expect(createProvider().search("测试", 3)).resolves.toEqual([]);
    await expect(createProvider().search("测试", 3, { strict: true })).rejects.toThrow(
      /invalid HTML/,
    );
  });

  it("SearXNG 缺少 results 数组的 200 响应不得通过严格探测", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));

    const provider = new SearxngProvider("https://search.example.com");
    await expect(provider.search("测试", 3)).resolves.toEqual([]);
    await expect(provider.search("测试", 3, { strict: true })).rejects.toThrow(
      "invalid response",
    );
  });

  it.each([
    [
      "Bing",
      () => new BingProvider(),
      "<html><body><ol id=\"b_results\"></ol></body></html>",
    ],
    [
      "DuckDuckGo",
      () => new DuckDuckGoProvider(),
      "<html><body><div id=\"links\"></div><table></table></body></html>",
    ],
  ])("%s 有效空结果结构仍通过严格探测", async (_name, createProvider, html) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));

    await expect(createProvider().search("测试", 3, { strict: true })).resolves.toEqual([]);
  });
});
