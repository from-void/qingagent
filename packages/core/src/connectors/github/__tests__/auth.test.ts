import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubDeviceAuth } from "../githubAuth.js";

describe("GithubDeviceAuth", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("authorization_pending 后 slow_down 增加 5 秒再成功", async () => {
    const waits: number[] = [];
    const replies = [
      { error: "authorization_pending" }, { error: "slow_down" },
      { access_token: "not-snapshotted", token_type: "bearer", scope: "public_repo" },
    ];
    const fetch = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
    const auth = new GithubDeviceAuth({ clientId: "fake", baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch, sleep: async (ms) => { waits.push(ms); } });
    const result = await auth.poll("device-secret", 2, Date.now() + 60_000, new AbortController().signal);
    expect(result.scope).toBe("public_repo");
    expect(waits).toEqual([2000, 2000, 7000]);
  });

  it.each([["expired_token", "PENDING_EXPIRED", 410], ["access_denied", "ACCESS_DENIED", 403]])("%s 映射稳定错误", async (providerError, code, status) => {
    const auth = new GithubDeviceAuth({ clientId: "fake", baseUrl: "http://fake", fetch: async () => new Response(JSON.stringify({ error: providerError })), sleep: async () => {} });
    await expect(auth.poll("secret", 1, Date.now() + 10_000, new AbortController().signal)).rejects.toMatchObject({ code, status });
  });

  it("每次轮询定时结束都移除 abort 监听器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const replies = [
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      { access_token: "token", token_type: "bearer", scope: "repo" },
    ];
    const auth = new GithubDeviceAuth({
      clientId: "fake",
      baseUrl: "http://fake",
      fetch: vi.fn(async () => new Response(JSON.stringify(replies.shift()))) as typeof globalThis.fetch,
    });

    const polling = auth.poll("secret", 1, Date.now() + 10_000, controller.signal);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(polling).resolves.toMatchObject({ access_token: "token" });

    expect(add).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
    for (const [, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith("abort", listener);
    }
  });

  it("取消轮询时清理定时器并移除 abort 监听器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetch = vi.fn();
    const auth = new GithubDeviceAuth({ clientId: "fake", baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch });

    const polling = auth.poll("secret", 1, Date.now() + 10_000, controller.signal);
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
