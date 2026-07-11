import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnectorCredentialBundle } from "../../credentials/credentialsRepo.js";
import { buildGithubCodeSearchQuery, githubSearchCodeTool } from "../githubSearchCode.js";

vi.mock("../../credentials/credentialsRepo.js", () => ({ getConnectorCredentialBundle: vi.fn() }));

const opts = { toolCallId: "github-search-test", messages: [] } as never;
const headers = { "X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "9", "X-RateLimit-Reset": "1780000000", "X-RateLimit-Resource": "search" };

async function execute(input: Record<string, unknown>) {
  if (!githubSearchCodeTool.execute) throw new Error("execute missing");
  return await githubSearchCodeTool.execute(input as never, opts) as Record<string, unknown>;
}

function hit(fragment = "const answer = 42;", line = 7) {
  return { total_count: 1, incomplete_results: false, items: [{ path: "src/a.ts", html_url: "https://github.test/o/r/blob/main/src/a.ts", score: 2.5, text_matches: [{ fragment, line_number: line }] }] };
}

describe("github_search_code fake provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QINGAGENT_GITHUB_API_BASE_URL = "http://127.0.0.1:9876";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("未连接明确拒绝且不访问 provider", async () => {
    vi.mocked(getConnectorCredentialBundle).mockResolvedValue(null);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(execute({ action: "search", owner: "o", repo: "r", query: "answer" })).resolves.toMatchObject({ ok: false, reasonCode: "GITHUB_NOT_CONNECTED", count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("命中与空结果，search 资源限额独立透传且 URL 整体编码", async () => {
    vi.mocked(getConnectorCredentialBundle).mockResolvedValue({ payload: { token: "secret" } } as never);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(hit()), { status: 200, headers }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200, headers }));
    vi.stubGlobal("fetch", fetchMock);
    const found = await execute({ action: "search", owner: "o", repo: "r", query: "answer language:ts" });
    expect(found).toMatchObject({ ok: true, count: 1, rateLimit: { resource: "search", remaining: 9 } });
    expect((found.hits as Array<Record<string, unknown>>)[0]).toMatchObject({ path: "src/a.ts", fragment: "const answer = 42;", score: 2.5 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=answer+language%3Ats+repo%3Ao%2Fr");
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get("Accept")).toContain("text-match");
    await expect(execute({ action: "search", owner: "o", repo: "r", query: "missing" })).resolves.toMatchObject({ ok: true, count: 0, hits: [] });
  });

  it("403 搜索限额携带 resetAt 且不盲重试", async () => {
    vi.mocked(getConnectorCredentialBundle).mockResolvedValue({ payload: { token: "secret" } } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 403, headers })); vi.stubGlobal("fetch", fetchMock);
    await expect(execute({ action: "search", owner: "o", repo: "r", query: "x" })).rejects.toMatchObject({ code: "RATE_LIMIT", resetAt: new Date(1780000000 * 1000).toISOString() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("畸形 JSON 稳定失败", async () => {
    vi.mocked(getConnectorCredentialBundle).mockResolvedValue({ payload: { token: "secret" } } as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{bad", { status: 200, headers })));
    await expect(execute({ action: "search", owner: "o", repo: "r", query: "x" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("选择片段才返回正文，空片段拒绝，fragmentId 稳定", async () => {
    vi.mocked(getConnectorCredentialBundle).mockResolvedValue({ payload: { token: "secret" } } as never);
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(hit()), { status: 200, headers })); vi.stubGlobal("fetch", fetchMock);
    const first = await execute({ action: "search", owner: "o", repo: "r", query: "answer" });
    expect(first).not.toHaveProperty("text");
    const id = (first.hits as Array<Record<string, unknown>>)[0]?.fragmentId;
    const selected = await execute({ action: "select_fragment", owner: "o", repo: "r", query: "answer", fragmentId: id });
    expect(selected).toMatchObject({ selected: true, materialId: id, title: "r/src/a.ts#L7", text: "const answer = 42;" });

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(hit("   ")), { status: 200, headers })));
    const emptySearch = await execute({ action: "search", owner: "o", repo: "r", query: "blank" });
    const emptyId = (emptySearch.hits as Array<Record<string, unknown>>)[0]?.fragmentId;
    await expect(execute({ action: "select_fragment", owner: "o", repo: "r", query: "blank", fragmentId: emptyId })).rejects.toMatchObject({ code: "EMPTY_FRAGMENT" });
  });

  it("拒绝 repo/query 注入字符", () => {
    expect(() => buildGithubCodeSearchQuery("o/evil", "r", "x")).toThrow();
    expect(() => buildGithubCodeSearchQuery("o", "r", "x repo:evil/r")).toThrow();
    expect(() => buildGithubCodeSearchQuery("o", "r", "x\nOR y")).toThrow();
  });
});
