import { describe, expect, it, vi } from "vitest";
import {
  GithubClient,
  encodeGithubFilePath,
  parseGithubNextPage,
  parseGithubRateLimit,
} from "../githubClient.js";

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

  it("无明确限速信号的 403 映射为权限拒绝", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 403, headers: { "X-RateLimit-Reset": "1780000000" } }));
    await expect(new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch }).user()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: "GitHub 权限不足或访问被拒绝",
      status: 403,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(parseGithubRateLimit(new Headers())).toEqual({ limit: null, remaining: null, resetAt: null, resource: null });
  });

  it.each([
    [
      "remaining=0",
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1780000000" },
      "{}",
    ],
    ["Retry-After", { "Retry-After": "60" }, "{}"],
    [
      "明确限速响应",
      {},
      JSON.stringify({
        message: "You have exceeded a secondary rate limit.",
        documentation_url: "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
      }),
    ],
  ])("403 带 %s 时才映射 RATE_LIMIT", async (_name, headers, body) => {
    const fetch = vi.fn(async () => new Response(body, { status: 403, headers }));
    await expect(
      new GithubClient({
        baseUrl: "http://fake",
        fetch: fetch as typeof globalThis.fetch,
      }).user(),
    ).rejects.toMatchObject({
      code: "RATE_LIMIT",
      status: 403,
    });
  });

  it("429 无需额外 header 即映射 RATE_LIMIT", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(
      new GithubClient({
        baseUrl: "http://fake",
        fetch: fetch as typeof globalThis.fetch,
      }).user(),
    ).rejects.toMatchObject({
      code: "RATE_LIMIT",
      status: 429,
    });
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

  it("仓库列表传递受控页码并从 Link 解析下一页", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]", {
      status: 200,
      headers: {
        Link: '<http://fake/users/octo/repos?per_page=100&page=4>; rel="next", <http://fake/users/octo/repos?per_page=100&page=8>; rel="last"',
      },
    }));
    const client = new GithubClient({ baseUrl: "http://fake", fetch: fetch as typeof globalThis.fetch });

    const response = await client.listRepos("octo", 3);

    expect(fetch.mock.calls[0]?.[0]).toBe("http://fake/users/octo/repos?per_page=100&page=3");
    expect(response.nextPage).toBe(4);
    expect(parseGithubNextPage(new Headers())).toBeNull();
    expect(parseGithubNextPage(new Headers({ Link: '<http://fake/repos?page=0>; rel="next"' }))).toBeNull();
    expect(parseGithubNextPage(new Headers({ Link: '<not-a-url>; rel="next"' }))).toBeNull();
    expect(parseGithubNextPage(new Headers({ Link: '<http://fake/repos?page=2>; rel="prev"' }))).toBeNull();
    expect(() => client.listRepos("octo", 0)).toThrowError(/页码非法/);
  });

  it("分页仓库请求沿用 403 限速与权限拒绝分类", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", {
        status: 403,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1780000000",
        },
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const client = new GithubClient({
      baseUrl: "http://fake",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.listRepos("octo", 2)).rejects.toMatchObject({
      code: "RATE_LIMIT",
      resetAt: new Date(1780000000 * 1000).toISOString(),
      status: 403,
    });
    await expect(client.listRepos("octo", 3)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      status: 403,
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://fake/users/octo/repos?per_page=100&page=2",
      "http://fake/users/octo/repos?per_page=100&page=3",
    ]);
  });
});
