import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  persistScreenshot: vi.fn(),
  screenshot: vi.fn(async () => Buffer.from("screenshot")),
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

vi.mock("./persistScreenshot.js", () => ({
  persistScreenshot: mocks.persistScreenshot,
}));

vi.mock("./pool.js", () => ({
  assertBrowserProxyAclConfigured: vi.fn(),
  browserProxyAclEnforced: vi.fn(() => false),
  getBrowser: vi.fn(async () => ({
    version: () => "120.0.0.0",
    newContext: vi.fn(async () => {
      const evaluate = vi
        .fn()
        .mockResolvedValueOnce("已渲染正文".repeat(60))
        .mockResolvedValueOnce({
          title: "正文标题",
          body:
            "这是已经成功抽取的正文内容，长度足够通过浏览器抓取的最低质量门槛。" +
            "即使后续可选截图无法写入磁盘，这段完整正文也必须继续返回给调用方。",
          ogImageUrl: null,
          images: [],
        });
      return {
        addInitScript: vi.fn(async () => undefined),
        newPage: vi.fn(async () => ({
          goto: vi.fn(async () => undefined),
          url: () => "https://example.com/article",
          waitForLoadState: vi.fn(async () => undefined),
          evaluate,
          screenshot: mocks.screenshot,
        })),
        close: mocks.close,
      };
    }),
  })),
  proxyFromEnv: vi.fn(() => null),
  withBrowserContextSlot: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

import { scrapeWithBrowserImpl } from "./scrapePage.js";

describe("scrapeWithBrowserImpl 可选截图", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("截图写盘失败时仍返回已成功抽取的正文", async () => {
    mocks.persistScreenshot.mockRejectedValueOnce(new Error("ENOSPC"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await scrapeWithBrowserImpl("https://example.com/article");

    expect(result).toMatchObject({
      ok: true,
      title: "正文标题",
      text: expect.stringContaining("已经成功抽取的正文内容"),
      screenshotSrc: null,
    });
    expect(mocks.persistScreenshot).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
