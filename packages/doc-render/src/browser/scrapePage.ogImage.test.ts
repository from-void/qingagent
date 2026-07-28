import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
}));

vi.mock("./extractor.js", () => ({
  resolveSiteAdapter: vi.fn(() => null),
  trimArticleBoilerplateLines: vi.fn((text: string) => text),
  validateFetchUrl: vi.fn(async (url: string) => new URL(url)),
}));

vi.mock("./contentQuality.js", () => ({
  isSubstantiveContent: vi.fn(() => true),
}));

vi.mock("./wechatArticle.js", () => ({
  extractWechatArticle: vi.fn(),
  isWechatArticleUrl: vi.fn(() => false),
}));

vi.mock("./browserSecurity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installBrowserRequestPolicy: vi.fn(async () => undefined),
}));

vi.mock("./pool.js", () => ({
  assertBrowserProxyAclConfigured: vi.fn(),
  browserProxyAclEnforced: vi.fn(() => false),
  getBrowser: vi.fn(async () => ({
    version: () => "120.0.0.0",
    newContext: vi.fn(async () => ({
      addInitScript: vi.fn(async () => undefined),
      newPage: vi.fn(async () => ({
        goto: vi.fn(async () => undefined),
        url: () => "https://redirected.example/news/final.html",
        waitForLoadState: vi.fn(async () => undefined),
        evaluate: vi.fn(async (callback: () => unknown) => callback()),
        screenshot: vi.fn(async () => null),
      })),
      close: mocks.close,
    })),
  })),
  proxyFromEnv: vi.fn(() => null),
  withBrowserContextSlot: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

import { scrapeWithBrowserImpl } from "./scrapePage.js";

describe("scrapeWithBrowserImpl OG 图片地址", () => {
  beforeEach(() => {
    const articleText = "浏览器渲染后的有效正文内容。".repeat(40);
    const article = { innerText: articleText };
    vi.stubGlobal("location", new URL("https://redirected.example/news/final.html"));
    vi.stubGlobal("document", {
      title: "重定向后的正文",
      body: { innerText: articleText },
      querySelectorAll: (selector: string) => (selector === "article" ? [article] : []),
      querySelector: (selector: string) =>
        selector === 'meta[property="og:image"]'
          ? { content: "../assets/cover.jpg" }
          : null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("按重定向后的页面地址解析相对 OG 图片", async () => {
    const result = await scrapeWithBrowserImpl("https://origin.example/start");

    expect(result).toMatchObject({
      ok: true,
      ogImageUrl: "https://redirected.example/assets/cover.jpg",
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
