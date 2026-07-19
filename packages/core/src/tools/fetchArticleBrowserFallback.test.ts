import { afterEach, describe, expect, it, vi } from "vitest";

const mockDeps = vi.hoisted(() => ({
  extractArticleContent: vi.fn(),
  scrapeWithBrowserImpl: vi.fn(),
}));

vi.mock("@qingagent/doc-render/browser", async () => {
  const actual = await vi.importActual<typeof import("@qingagent/doc-render/browser")>(
    "@qingagent/doc-render/browser",
  );
  return {
    ...actual,
    extractArticleContent: mockDeps.extractArticleContent,
    scrapeWithBrowserImpl: mockDeps.scrapeWithBrowserImpl,
  };
});

import { fetchArticleTool } from "./fetchArticle.js";

describe("fetchArticle 浏览器降级失败回退", () => {
  afterEach(() => {
    mockDeps.extractArticleContent.mockReset();
    mockDeps.scrapeWithBrowserImpl.mockReset();
  });

  it("浏览器不可用时回退静态最佳结果,不抛错", async () => {
    const staticText = "正在加载... 返回首页 返回顶部 版权所有 ICP备 扫一扫 下载App";
    mockDeps.extractArticleContent.mockResolvedValueOnce({
      title: "静态壳",
      body: staticText,
      images: [],
      screenshot: null,
      ogImageUrl: null,
    });
    mockDeps.scrapeWithBrowserImpl.mockRejectedValueOnce(
      new Error(
        "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium/chrome",
      ),
    );

    const result = await fetchArticleTool.execute!(
      { url: "https://example.com/article" },
      {} as never,
    ) as {
      title: string;
      text: string;
      wordCount: number;
      via: "static" | "browser";
    };

    expect(mockDeps.scrapeWithBrowserImpl).toHaveBeenCalledTimes(1);
    expect(result.title).toBe("静态壳");
    expect(result.text).toBe(staticText);
    expect(result.wordCount).toBe(staticText.replace(/\s+/g, "").length);
    expect(result.via).toBe("static");
  });

  it("把工具取消信号传给静态抓取并保持 AbortError", async () => {
    const controller = new AbortController();
    mockDeps.extractArticleContent.mockImplementationOnce(
      (_url: string, _selector: string | undefined, signal: AbortSignal | undefined) =>
        new Promise((_resolve, reject) => {
          const rejectOnAbort = () => reject(signal?.reason);
          if (signal?.aborted) rejectOnAbort();
          else signal?.addEventListener("abort", rejectOnAbort, { once: true });
        }),
    );

    const result = fetchArticleTool.execute!(
      { url: "https://example.com/slow-article" },
      { abortSignal: controller.signal } as never,
    );
    await vi.waitFor(() => expect(mockDeps.extractArticleContent).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("用户取消", "AbortError"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mockDeps.extractArticleContent).toHaveBeenCalledWith(
      "https://example.com/slow-article",
      undefined,
      controller.signal,
    );
    expect(mockDeps.scrapeWithBrowserImpl).not.toHaveBeenCalled();
  });
});
