import { describe, expect, it, vi } from "vitest";
import type { SearchProvider, SearchResult } from "./provider.js";
import {
  MultiSourceSearchProvider,
  dedupeResults,
  normalizeResultUrl,
  raceToGood,
} from "./multiSource.js";

function r(url: string, title = "t"): SearchResult {
  return { title, url, snippet: "s" };
}

function mockProvider(results: SearchResult[], delayMs = 0, fail = false): SearchProvider {
  return {
    async search() {
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      if (fail) throw new Error("source failed");
      return results;
    },
  };
}

describe("normalizeResultUrl", () => {
  it("去末尾斜杠 / fragment / utm 跟踪参数,大小写归一", () => {
    expect(normalizeResultUrl("https://A.com/path/")).toBe("https://a.com/path");
    expect(normalizeResultUrl("https://a.com/p?utm_source=x&q=1#frag")).toBe(
      "https://a.com/p?q=1",
    );
  });
  it("非法 URL 回退小写 trim", () => {
    expect(normalizeResultUrl("  NotAUrl ")).toBe("notaurl");
  });
});

describe("dedupeResults", () => {
  it("按规范化 URL 去重,保留首次(靠前优先)", () => {
    const out = dedupeResults([
      r("https://a.com/x", "first"),
      r("https://a.com/x/", "dup-trailing-slash"),
      r("https://b.com/y", "second"),
    ]);
    expect(out.map((x) => x.title)).toEqual(["first", "second"]);
  });
  it("跳过空 url", () => {
    expect(dedupeResults([r(""), r("https://a.com")])).toHaveLength(1);
  });
});

describe("raceToGood", () => {
  it("率先达标(≥count)的源立即胜出,不等慢源", async () => {
    const fast = Promise.resolve([r("https://f.com/1"), r("https://f.com/2")]);
    const slow = new Promise<SearchResult[]>((res) =>
      setTimeout(() => res([r("https://s.com/1")]), 50),
    );
    const out = await raceToGood([slow, fast], 2);
    expect(out.map((x) => x.url)).toEqual(["https://f.com/1", "https://f.com/2"]);
  });
  it("无源达标 → 合并全部(按源顺序)", async () => {
    const a = Promise.resolve([r("https://a.com/1")]);
    const b = Promise.resolve([r("https://b.com/1")]);
    const out = await raceToGood([a, b], 5);
    expect(out.map((x) => x.url)).toEqual(["https://a.com/1", "https://b.com/1"]);
  });
  it("空输入 → []", async () => {
    expect(await raceToGood([], 3)).toEqual([]);
  });
});

describe("MultiSourceSearchProvider", () => {
  it("空 query / count<=0 / 无源 → []", async () => {
    const p = new MultiSourceSearchProvider([
      { name: "x", provider: mockProvider([r("https://a.com")]) },
    ]);
    expect(await p.search("", 5)).toEqual([]);
    expect(await p.search("q", 0)).toEqual([]);
    expect(await new MultiSourceSearchProvider([]).search("q", 5)).toEqual([]);
  });

  it("跨源去重 + 截断到 count", async () => {
    const p = new MultiSourceSearchProvider([
      { name: "s1", provider: mockProvider([r("https://a.com/x"), r("https://b.com/y")]) },
      { name: "s2", provider: mockProvider([r("https://b.com/y/"), r("https://c.com/z")]) },
    ]);
    // count=5,无单源达标 → 合并去重(a,b,c)
    const out = await p.search("q", 5);
    expect(out.map((x) => x.url)).toEqual([
      "https://a.com/x",
      "https://b.com/y",
      "https://c.com/z",
    ]);
  });

  it("某源抛错被吞,不影响其它源(best-effort)", async () => {
    const p = new MultiSourceSearchProvider([
      { name: "bad", provider: mockProvider([], 0, true) },
      { name: "good", provider: mockProvider([r("https://ok.com/1")]) },
    ]);
    expect((await p.search("q", 5)).map((x) => x.url)).toEqual(["https://ok.com/1"]);
  });

  it("全部源失败 → []", async () => {
    const p = new MultiSourceSearchProvider([
      { name: "b1", provider: mockProvider([], 0, true) },
      { name: "b2", provider: mockProvider([], 0, true) },
    ]);
    expect(await p.search("q", 5)).toEqual([]);
  });

  it("把级联取消 signal 转发给所有并发子 provider", async () => {
    const receivedSignals: AbortSignal[] = [];
    const firstSearch = vi.fn(async (_query, _count, options) => {
      receivedSignals.push(options?.signal as AbortSignal);
      return [r("https://a.com/1")];
    });
    const secondSearch = vi.fn(async (_query, _count, options) => {
      receivedSignals.push(options?.signal as AbortSignal);
      return [r("https://b.com/1")];
    });
    const p = new MultiSourceSearchProvider([
      { name: "first", provider: { search: firstSearch } },
      { name: "second", provider: { search: secondSearch } },
    ]);
    const controller = new AbortController();

    await p.search("q", 5, { signal: controller.signal });

    expect(firstSearch).toHaveBeenCalledWith("q", 5, {
      signal: expect.any(AbortSignal),
    });
    expect(secondSearch).toHaveBeenCalledWith("q", 5, {
      signal: expect.any(AbortSignal),
    });
    expect(receivedSignals[0]).toBe(receivedSignals[1]);
    expect(receivedSignals[0]).not.toBe(controller.signal);
  });

  it("快源足量胜出后取消仍在等待的慢源", async () => {
    let slowSignal: AbortSignal | undefined;
    const slowAborted = vi.fn();
    const slow: SearchProvider = {
      search: vi.fn(async (_query, _count, options) => {
        slowSignal = options?.signal;
        return new Promise<SearchResult[]>((_resolve, reject) => {
          const onAbort = () => {
            slowAborted();
            reject(options?.signal?.reason);
          };
          if (options?.signal?.aborted) onAbort();
          else options?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }),
    };
    const fast = mockProvider([r("https://fast.com/1"), r("https://fast.com/2")]);
    const provider = new MultiSourceSearchProvider([
      { name: "slow", provider: slow },
      { name: "fast", provider: fast },
    ]);

    const result = await provider.search("q", 2);

    expect(result.map((item) => item.url)).toEqual([
      "https://fast.com/1",
      "https://fast.com/2",
    ]);
    expect(slowSignal?.aborted).toBe(true);
    expect(slowAborted).toHaveBeenCalledTimes(1);
  });

  it("外部取消会级联到所有子 provider", async () => {
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const childAborted = vi.fn();
    const waiting: SearchProvider = {
      search: vi.fn(async (_query, _count, options) => {
        childSignal = options?.signal;
        return new Promise<SearchResult[]>((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            childAborted();
            resolve([]);
          }, { once: true });
        });
      }),
    };
    const provider = new MultiSourceSearchProvider([{ name: "waiting", provider: waiting }]);
    const result = provider.search("q", 2, { signal: parent.signal });
    await vi.waitFor(() => expect(childSignal).toBeInstanceOf(AbortSignal));

    parent.abort(new DOMException("用户取消", "AbortError"));

    await expect(result).resolves.toEqual([]);
    expect(childSignal?.aborted).toBe(true);
    expect(childAborted).toHaveBeenCalledTimes(1);
  });
});
