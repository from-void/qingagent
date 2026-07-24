import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markWechatSessionNeedsReauth, readWechatCredentialBundle } from "../../connectors/wechatCredentials.js";
import {
  probeWechatSearchbiz,
  resetWechatRateLimitForTest,
  wechatListArticlesTool,
  wechatSearchMpTool,
} from "../wechatSearch.js";

vi.mock("../../connectors/wechatCredentials.js", () => ({
  readWechatCredentialBundle: vi.fn(),
  markWechatSessionNeedsReauth: vi.fn(),
}));

const opts = { toolCallId: "wechat-search-test", messages: [] } as never;

type FetchReply = { status: number; body: string };

function reply(status: number, body: unknown): FetchReply {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function validCreds(patch: Record<string, string> = {}) {
  return { version: 1 as const, connectorId: "wechat-mp", revision: 3, payload: { strategy: "qr-session" as const, version: 1 as const, account: "", token: "TK", cookie: "slave_sid=x", expiry: new Date(Date.now() + 3600_000).toISOString(), ...patch } };
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
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetWechatRateLimitForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("无凭据 → NO_CREDENTIAL,不发请求", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(null);
    const result = await search("阮一峰");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("NO_CREDENTIAL");
  });

  it("凭据过期 → EXPIRED", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds({ expiry: new Date(Date.now() - 1000).toISOString() }));
    const result = await search("x");
    expect(result.state).toBe("EXPIRED");
  });

  it("半授权(有 token 无 expiry) → 视为未授权,与 status 判据一致", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await search("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("NO_CREDENTIAL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("搜号解析出候选公众号(nickname/fakeid)", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
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
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: 200013, err_msg: "freq control" } });
    const result = await search("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("rate_limit");
  });

  it("列文解析多层嵌套 appmsgpublish", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
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
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: -6 } });
    const result = await list("x");
    expect(result.ok).toBe(false);
    expect(result.state).toBe("needs_reauth");
    expect(markWechatSessionNeedsReauth).toHaveBeenCalledWith(3);
  });

  it("非 JSON 响应(被风控重定向) → TRANSIENT", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "<html>验证</html>" }));
    const result = await search("x");
    expect(result.state).toBe("transient");
  });

  it("搜索能力拒绝保留 ACCESS_DENIED 语义", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: 200007 } });
    expect((await search("x")).state).toBe("ACCESS_DENIED");
  });
});

describe("probeWechatSearchbiz", () => {
  beforeEach(async () => {
    vi.resetModules();
    await resetWechatRateLimitForTest();
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
    ["HTTP 429", reply(429, { base_resp: { ret: 0 } }), "rate_limit"],
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

  it("探针把父取消与本地 timeout 合并，并保留父取消原因", async () => {
    const parent = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      }),
    );
    const { probeWechatSearchbiz } = await import("../wechatSearch.js");
    const reason = new DOMException("用户取消微信请求", "AbortError");
    const result = probeWechatSearchbiz("TOKEN", "cookie=x", parent.signal);
    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));
    expect(requestSignal).not.toBe(parent.signal);

    parent.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("1.2s 限速等待中取消：立即退出、绝不发请求且不占后续槽位", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ base_resp: { ret: 0 }, list: [] })),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeWechatSearchbiz("TOKEN", "cookie=x")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cancelled = new AbortController();
    const reason = new DOMException("用户取消排队中的微信请求", "AbortError");
    const second = probeWechatSearchbiz("TOKEN", "cookie=x", cancelled.signal);
    await Promise.resolve();
    cancelled.abort(reason);

    await expect(second).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const third = probeWechatSearchbiz("TOKEN", "cookie=x");
    await vi.advanceTimersByTimeAsync(1_199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(third).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
