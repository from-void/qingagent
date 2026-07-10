import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialsForPlatform } from "../../credentials/credentialsRepo.js";
import { wechatListArticlesTool, wechatSearchMpTool } from "../wechatSearch.js";

vi.mock("../../credentials/credentialsRepo.js", () => ({
  getCredentialsForPlatform: vi.fn(),
}));

const opts = { toolCallId: "wechat-search-test", messages: [] } as never;

type FetchReply = { status: number; body: string };

function reply(status: number, body: unknown): FetchReply {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function validCreds(): Record<string, string> {
  return { token: "TK", cookie: "slave_sid=x", expiry: new Date(Date.now() + 3600_000).toISOString() };
}

function mockFetchJson(obj: unknown): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => JSON.stringify(obj) }));
}

async function search(query: string): Promise<Record<string, unknown>> {
  if (!wechatSearchMpTool.execute) throw new Error("execute missing");
  return (await wechatSearchMpTool.execute({ query }, opts)) as Record<string, unknown>;
}

async function list(fakeid: string): Promise<Record<string, unknown>> {
  if (!wechatListArticlesTool.execute) throw new Error("execute missing");
  return (await wechatListArticlesTool.execute({ fakeid }, opts)) as Record<string, unknown>;
}

describe("wechatSearch 路径B", () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("无凭据 → NO_CREDENTIAL,不发请求", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({});
    const result = await search("阮一峰");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("NO_CREDENTIAL");
  });

  it("凭据过期 → EXPIRED", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({
      token: "TK",
      cookie: "c",
      expiry: new Date(Date.now() - 1000).toISOString(),
    });
    const result = await search("x");
    expect(result.state).toBe("EXPIRED");
  });

  it("半授权(有 token 无 expiry) → 视为未授权,与 status 判据一致", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({ token: "TK", cookie: "c" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await search("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("NO_CREDENTIAL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("搜号解析出候选公众号(nickname/fakeid)", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({
      base_resp: { ret: 0 },
      list: [
        {
          nickname: "阮一峰的网络日志",
          fakeid: "MzA123",
          alias: "ruanyf",
          round_head_img: "http://img",
          signature: "sig",
        },
      ],
      total: 1,
    });
    const result = await search("阮一峰");
    expect(result.ok).toBe(true);
    const accounts = result.accounts as Array<Record<string, string>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.nickname).toBe("阮一峰的网络日志");
    expect(accounts[0]?.fakeid).toBe("MzA123");
  });

  it("频控 ret=200013 → RATE_LIMIT", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: 200013, err_msg: "freq control" } });
    const result = await search("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("RATE_LIMIT");
  });

  it("列文解析多层嵌套 appmsgpublish", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    const publishInfo = JSON.stringify({
      appmsgex: [
        {
          title: "科技爱好者周刊#331",
          link: "https://mp.weixin.qq.com/s/abc",
          cover: "http://cov",
          update_time: 1700000000,
        },
      ],
    });
    const publishPage = JSON.stringify({ publish_list: [{ publish_info: publishInfo }], total_count: 1 });
    mockFetchJson({ base_resp: { ret: 0 }, publish_page: publishPage });
    const result = await list("MzA123");
    expect(result.ok).toBe(true);
    const articles = result.articles as Array<Record<string, unknown>>;
    expect(articles).toHaveLength(1);
    expect(articles[0]?.title).toBe("科技爱好者周刊#331");
    expect(String(articles[0]?.link)).toContain("mp.weixin.qq.com/s");
  });

  it("会话失效 ret=-6 → SESSION(引导重扫)", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: -6 } });
    const result = await list("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("SESSION");
  });

  it("非 JSON 响应(被风控重定向) → TRANSIENT", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "<html>验证</html>" }));
    const result = await search("x");
    expect(result.state).toBe("TRANSIENT");
  });
});

describe("probeWechatSearchbiz", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [
      "搜索能力被拒绝",
      reply(200, { base_resp: { ret: 200007 } }),
      "capability_denied",
    ],
    ["登录态失效", reply(200, { base_resp: { ret: -6 } }), "reauth"],
    ["HTTP 429", reply(429, { base_resp: { ret: 0 } }), "transient"],
    ["未知业务 ret", reply(200, { base_resp: { ret: 123456 } }), "unknown"],
  ] as const)("将%s归类为 %s", async (_label, fetchReply, expectedKind) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: fetchReply.status,
      text: vi.fn().mockResolvedValue(fetchReply.body),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { probeWechatSearchbiz } = await import("../wechatSearch.js");

    await expect(probeWechatSearchbiz("TOKEN", "cookie=x")).resolves.toMatchObject({
      ok: false,
      kind: expectedKind,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/searchbiz?"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("探针在 6000ms 后中止仍未返回的 fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
      ),
    );
    const { probeWechatSearchbiz } = await import("../wechatSearch.js");
    const result = probeWechatSearchbiz("TOKEN", "cookie=x");

    await vi.advanceTimersByTimeAsync(5_999);
    await expect(Promise.race([result, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ ok: false, kind: "transient" });
  });

  it.each([
    ["HTTP 5xx", reply(503, "temporarily unavailable")],
    ["非 JSON 风控页", reply(200, "<html>verify</html>")],
  ] as const)("将%s保守归类为 transient", async (_label, fetchReply) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: fetchReply.status,
        text: vi.fn().mockResolvedValue(fetchReply.body),
      }),
    );
    const { probeWechatSearchbiz } = await import("../wechatSearch.js");

    await expect(probeWechatSearchbiz("TOKEN", "cookie=x")).resolves.toMatchObject({
      ok: false,
      kind: "transient",
    });
  });
});
