import { afterEach, describe, expect, it, vi } from "vitest";
import { modelWarmupUrl, warmUpModelEndpoint } from "./modelWarmup";

describe("modelWarmup", () => {
  const originalFlag = process.env.QINGAGENT_MODEL_WARMUP;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.QINGAGENT_MODEL_WARMUP;
    } else {
      process.env.QINGAGENT_MODEL_WARMUP = originalFlag;
    }
    vi.unstubAllGlobals();
  });

  it("/models 拼接对尾斜杠 baseUrl 不产生双斜杠", () => {
    expect(modelWarmupUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/models");
    expect(modelWarmupUrl("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1/models");
  });

  it("后台请求不带 key,成功时记录 status/ms", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("unauthorized", { status: 401 }));
    const log = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => warmUpModelEndpoint("https://api.deepseek.com/v1", log)).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/models",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(log.mock.calls[0]?.[0]).toMatch(/^\[warmup\] origin=https:\/\/api\.deepseek\.com status=401 ms=\d+$/);
  });

  it("fetch 失败或超时时吞错并记录 error", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const log = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => warmUpModelEndpoint("https://api.deepseek.com/v1", log)).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(log.mock.calls[0]?.[0]).toMatch(/^\[warmup\] origin=https:\/\/api\.deepseek\.com status=error ms=\d+$/);
  });

  it("QINGAGENT_MODEL_WARMUP=0 时 no-op", async () => {
    process.env.QINGAGENT_MODEL_WARMUP = "0";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    warmUpModelEndpoint("https://api.deepseek.com/v1", vi.fn());
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
