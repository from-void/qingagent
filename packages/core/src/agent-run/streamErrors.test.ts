import { describe, expect, it, vi } from "vitest";
import { withIdleTimeout } from "./streamErrors.js";

describe("withIdleTimeout 迭代器收尾", () => {
  it("消费方 break 后转发底层 return 并执行 async generator finally", async () => {
    const finalized = vi.fn();
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        finalized();
      }
    }

    for await (const value of withIdleTimeout(source(), 10_000, vi.fn())) {
      expect(value).toBe(1);
      break;
    }

    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
  });

  it("外部 signal 可提前结束挂起的 next 并尽力调用底层 return", async () => {
    const controller = new AbortController();
    const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(() => new Promise<IteratorResult<number>>(() => undefined)),
          return: returnSpy,
        };
      },
    };
    const wrapped = withIdleTimeout(source, 10_000, vi.fn(), {
      abortSignal: controller.signal,
    });
    const pending = wrapped.next();
    controller.abort(new DOMException("用户取消", "AbortError"));

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(returnSpy).toHaveBeenCalledTimes(1));
  });

  it("底层自然 done 时不额外调用 return", async () => {
    const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(async () => ({ done: true as const, value: undefined })),
          return: returnSpy,
        };
      },
    };

    await expect(withIdleTimeout(source, 10_000, vi.fn()).next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(returnSpy).not.toHaveBeenCalled();
  });
});
