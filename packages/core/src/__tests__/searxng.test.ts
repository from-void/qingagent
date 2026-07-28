import { afterEach, describe, expect, it, vi } from "vitest";
import { SearxngProvider } from "../search/searxng.js";

describe("SearxngProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("请求地址保留配置中的部署子路径", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new SearxngProvider("https://search.example.com/internal/searxng").search(
      "路径测试",
      3,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://search.example.com/internal/searxng/search?q=%E8%B7%AF%E5%BE%84%E6%B5%8B%E8%AF%95&format=json",
    );
  });
});
