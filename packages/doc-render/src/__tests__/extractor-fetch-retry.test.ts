import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
  __setPinnedFetchForTest,
  extractArticleContent,
} from "../browser/extractor.js";
import type { PinnedFetchUrl } from "../browser/fetchUrlPolicy.js";

type TestPinnedFetch = (target: PinnedFetchUrl, init: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  __setPinnedFetchForTest(null);
});

describe("extractArticleContent fetch 轻量重试", () => {
  it("fetch 瞬时网络失败后重试并成功提取正文", async () => {
    const html =
      "<html><head><title>重试成功</title></head><body><article>" +
      "<h1>重试成功</h1>" +
      "<p>这是一次网络抖动后的正文内容，长度足够通过静态文章抽取的最低质量门槛。</p>" +
      "<p>第二次请求返回完整 HTML，应该正常提取标题和文章正文。</p>" +
      "</article></body></html>";
    const fetchMock = vi
      .fn<TestPinnedFetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(Buffer.from(html), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    __setPinnedFetchForTest(fetchMock);

    const result = await extractArticleContent("https://example.com/article");

    expect(result.title).toBe("重试成功");
    expect(result.body).toContain("网络抖动后的正文内容");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: "93.184.216.34", family: 4 }),
      expect.any(Object),
    );
  });

  it("静态 fetch 超时最多额外重试一次,不会卡到 60 秒", async () => {
    vi.useFakeTimers();
    const abortControllers: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      // 单次静态抓取超时降到 6s(原 12s),让慢站快速失败,满足"外部抓取≤15s"。
      expect(ms).toBe(6_000);
      const controller = new AbortController();
      abortControllers.push(controller);
      return controller.signal;
    });
    const fetchMock = vi.fn<TestPinnedFetch>((_target, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    __setPinnedFetchForTest(fetchMock);

    const result = extractArticleContent("https://example.com/slow-article");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abortControllers[0]?.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    abortControllers[1]?.abort(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(result).rejects.toMatchObject({
      name: expect.stringMatching(/AbortError|TimeoutError/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("超时重试预算跨重定向共享", async () => {
    vi.useFakeTimers();
    const abortControllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(12_000);
      const controller = new AbortController();
      abortControllers.push(controller);
      return controller.signal;
    });

    let callCount = 0;
    const fetchMock = vi.fn<TestPinnedFetch>((_target, init) => {
      callCount += 1;
      if (callCount === 2) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://example.com/redirected-slow-article" },
          }),
        );
      }

      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new DOMException("The operation was aborted.", "AbortError"),
          );
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    __setPinnedFetchForTest(fetchMock);

    const result = extractArticleContent("https://example.com/redirect-then-slow");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abortControllers[0]?.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    abortControllers[2]?.abort(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(result).rejects.toMatchObject({
      name: expect.stringMatching(/AbortError|TimeoutError/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["HTML", "text/html", 10 * 1024 * 1024 + 1, "https://example.com/oversized.html"],
    ["PDF", "application/pdf", 30 * 1024 * 1024 + 1, "https://example.com/oversized.pdf"],
  ] as const)("%s Content-Length 超限时在读取前取消响应体", async (kind, contentType, size, url) => {
    const body = new ReadableStream<Uint8Array>({
      pull() {},
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(size),
      },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn<TestPinnedFetch>(async () => response);
    __setPinnedFetchForTest(fetchMock);

    await expect(extractArticleContent(url)).rejects.toThrow(
      new RegExp(`\\[unsupported-content\\] ${kind} 过大`),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("HTML 未给 Content-Length 时边读边累计，越过 10MiB 立即取消", async () => {
    const cancel = vi.fn();
    let emitted = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) return;
        emitted = true;
        controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const fetchMock = vi.fn<TestPinnedFetch>(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    __setPinnedFetchForTest(fetchMock);

    await expect(extractArticleContent("https://example.com/streaming-too-large")).rejects.toThrow(
      /\[unsupported-content\] HTML 过大/,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
