import { describe, expect, it, vi } from "vitest";
import { GithubDeviceAuth } from "../githubAuth.js";

describe("GithubDeviceAuth", () => {
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
});
