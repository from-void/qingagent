import { describe, expect, it, vi } from "vitest";
import { GithubClient, encodeGithubFilePath, parseGithubRateLimit } from "../githubClient.js";

describe("GithubClient", () => {
  it("逐段编码 owner/repo/path/ref，不能注入 query 或路径", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ tree: [] }), { status: 200 }));
    const client = new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch });
    await client.tree("evil/../?x=1", "repo#x", "main?recursive=0");
    expect(fetch.mock.calls[0]?.[0]).toBe("http://fake/repos/evil%2F..%2F%3Fx%3D1/repo%23x/git/trees/main%3Frecursive%3D0?recursive=1");
    expect(() => encodeGithubFilePath("a/../secret")).toThrowError(/路径非法/);
  });

  it("固定 headers 且 Authorization 只在 client 内", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      return new Response(JSON.stringify({ id: 1, login: "qa" }), { status: 200 });
    });
    await new GithubClient({ baseUrl: "https://fake.example", token: "secret", fetch: fetch as typeof globalThis.fetch }).user();
  });

  it("403 映射 RATE_LIMIT/resetAt，缺失 header 保持 null，不重试", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 403, headers: { "X-RateLimit-Reset": "1780000000" } }));
    await expect(new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch }).user()).rejects.toMatchObject({ code: "RATE_LIMIT", resetAt: new Date(1780000000 * 1000).toISOString() });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(parseGithubRateLimit(new Headers())).toEqual({ limit: null, remaining: null, resetAt: null, resource: null });
  });

  it("畸形 JSON 稳定失败", async () => {
    const fetch = vi.fn(async () => new Response("{bad", { status: 200 }));
    await expect(new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch }).user()).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 502 });
  });

  it("调用前已取消时不发送请求", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 1, login: "qa" }), { status: 200 })
    );
    const controller = new AbortController();
    controller.abort(new DOMException("已取消", "AbortError"));

    await expect(
      new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch })
        .user(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
