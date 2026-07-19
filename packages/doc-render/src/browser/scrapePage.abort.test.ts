import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  goto: vi.fn(),
}));

vi.mock("./extractor.js", () => ({
  resolveSiteAdapter: vi.fn(() => null),
  trimArticleBoilerplateLines: vi.fn((text: string) => text),
  validateFetchUrl: vi.fn(async (url: string) => new URL(url)),
}));

vi.mock("./pool.js", () => ({
  withBrowserContextSlot: vi.fn(async (run: () => Promise<unknown>) => run()),
  getBrowser: vi.fn(async () => ({
    version: () => "120.0.0.0",
    newContext: vi.fn(async () => ({
      addInitScript: vi.fn(async () => undefined),
      newPage: vi.fn(async () => ({
        goto: mocks.goto,
        url: () => "https://example.com/article",
      })),
      route: vi.fn(async () => undefined),
      close: mocks.close,
    })),
  })),
}));

import { scrapeWithBrowserImpl } from "./scrapePage.js";

describe("scrapeWithBrowserImpl 取消收尾", () => {
  it("导航挂起时收到 signal 会关闭 browser context", async () => {
    const controller = new AbortController();
    let rejectNavigation: ((reason?: unknown) => void) | undefined;
    mocks.goto.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectNavigation = reject;
      }),
    );
    mocks.close.mockImplementation(async () => {
      rejectNavigation?.(new Error("Target page, context or browser has been closed"));
    });

    const result = scrapeWithBrowserImpl("https://example.com/article", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.goto).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("用户取消", "AbortError"));

    await expect(result).rejects.toBeInstanceOf(Error);
    expect(mocks.close).toHaveBeenCalled();
  });
});
