import { afterEach, describe, expect, it, vi } from "vitest";
import { __setSearchFetchForTest } from "./apiUtils.js";
import type { SearchProvider, SearchResult } from "./provider.js";
import { SearchProviderError } from "./errors.js";
import { TavilyProvider } from "./tavily.js";
import { SerperProvider } from "./serper.js";
import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { JinaProvider } from "./jina.js";
import { BochaProvider } from "./bocha.js";

interface ProviderCase {
  name: string;
  create: () => SearchProvider;
  body: unknown;
  expected: SearchResult[];
  assertRequest?: (input: RequestInfo | URL, init?: RequestInit) => void;
}

function mockJsonFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  // apiUtils 用 undici 自身的 fetch(代理兼容),stubGlobal 拦不到——走显式注入点。
  __setSearchFetchForTest(fetchMock as unknown as Parameters<typeof __setSearchFetchForTest>[0]);
  return fetchMock;
}

const dirtySnippet = '正文里有 ] / } / "quoted" / \\"escaped\\" 收尾,不能破坏解析。';

const cases: ProviderCase[] = [
  {
    name: "tavily",
    create: () => new TavilyProvider("tvly-test"),
    body: {
      results: [
        { title: "Tavily A", url: "https://a.example/t", content: dirtySnippet },
        { title: "无 URL", content: "skip" },
      ],
    },
    expected: [{ title: "Tavily A", url: "https://a.example/t", snippet: dirtySnippet }],
    assertRequest: (_input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
    },
  },
  {
    name: "serper",
    create: () => new SerperProvider("serper-test"),
    body: {
      organic: [
        { title: "Serper A", link: "https://a.example/s", snippet: dirtySnippet },
        { title: "坏链接", link: "javascript:alert(1)", snippet: "skip" },
      ],
    },
    expected: [{ title: "Serper A", url: "https://a.example/s", snippet: dirtySnippet }],
    assertRequest: (_input, init) => {
      expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("serper-test");
    },
  },
  {
    name: "brave",
    create: () => new BraveProvider("brave-test"),
    body: {
      web: {
        results: [
          {
            title: "Brave A",
            url: "https://a.example/b",
            description: `<strong>${dirtySnippet}</strong>`,
          },
        ],
      },
    },
    expected: [{ title: "Brave A", url: "https://a.example/b", snippet: dirtySnippet }],
    assertRequest: (input, init) => {
      expect(String(input)).toContain("https://api.search.brave.com/res/v1/web/search");
      expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-test");
    },
  },
  {
    name: "exa",
    create: () => new ExaProvider("exa-test"),
    body: {
      results: [
        {
          title: "Exa A",
          url: "https://a.example/e",
          highlights: [dirtySnippet],
          summary: "summary fallback",
        },
      ],
    },
    expected: [{ title: "Exa A", url: "https://a.example/e", snippet: dirtySnippet }],
    assertRequest: (_input, init) => {
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("exa-test");
    },
  },
  {
    name: "jina",
    create: () => new JinaProvider("jina-test"),
    body: {
      data: [
        { title: "Jina A", url: "https://a.example/j", content: dirtySnippet },
        { title: "", url: "https://a.example/skip", content: "skip" },
      ],
    },
    expected: [{ title: "Jina A", url: "https://a.example/j", snippet: dirtySnippet }],
    assertRequest: (input, init) => {
      expect(String(input)).toContain("https://s.jina.ai/");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jina-test");
    },
  },
  {
    name: "bocha",
    create: () => new BochaProvider("bocha-test"),
    body: {
      webPages: {
        value: [
          { name: "博查 A", url: "https://a.example/c", snippet: "snippet", summary: dirtySnippet },
        ],
      },
    },
    expected: [{ title: "博查 A", url: "https://a.example/c", snippet: dirtySnippet }],
    assertRequest: (_input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer bocha-test");
    },
  },
];

describe("API search providers", () => {
  afterEach(() => {
    __setSearchFetchForTest(null);
    vi.unstubAllGlobals();
  });

  for (const item of cases) {
    describe(item.name, () => {
      it("401 分类为 auth", async () => {
        mockJsonFetch(401, { error: "invalid key" });
        await expect(item.create().search("测试", 3)).rejects.toMatchObject({
          kind: "auth",
          status: 401,
        });
      });

      it("429 分类为 quota", async () => {
        mockJsonFetch(429, { error: "rate limited" });
        await expect(item.create().search("测试", 3)).rejects.toMatchObject({
          kind: "quota",
          status: 429,
        });
      });

      it("正常解析官方响应字段并过滤坏结果", async () => {
        const fetchMock = mockJsonFetch(200, item.body);
        const results = await item.create().search("测试", 3);

        expect(results).toEqual(item.expected);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        if (!call) throw new Error("fetch was not called");
        item.assertRequest?.(call[0], call[1]);
      });

      it("把外部取消传到底层 fetch", async () => {
        let requestSignal: AbortSignal | null | undefined;
        const fetchMock = vi.fn(
          async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            requestSignal = init?.signal;
            return await new Promise<Response>((_resolve, reject) => {
              if (requestSignal?.aborted) {
                reject(requestSignal.reason);
                return;
              }
              requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
                once: true,
              });
            });
          },
        );
        __setSearchFetchForTest(
          fetchMock as unknown as Parameters<typeof __setSearchFetchForTest>[0],
        );
        const controller = new AbortController();
        const reason = new DOMException("parent aborted", "AbortError");

        const pending = item.create().search("测试", 3, { signal: controller.signal });
        controller.abort(reason);

        await expect(pending).rejects.toBeInstanceOf(SearchProviderError);
        expect(requestSignal?.aborted).toBe(true);
        expect(requestSignal?.reason).toBe(reason);
      });
    });
  }

  it("缺少 API key 时不发请求并抛 auth", async () => {
    const fetchMock = mockJsonFetch(200, {});
    await expect(new TavilyProvider("").search("测试", 1)).rejects.toBeInstanceOf(
      SearchProviderError,
    );
    await expect(new TavilyProvider("").search("测试", 1)).rejects.toMatchObject({
      kind: "auth",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
