import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialsForPlatform } from "../../credentials/credentialsRepo.js";
import { wechatSearchMpTool, wechatListArticlesTool } from "../wechatSearch.js";

vi.mock("../../credentials/credentialsRepo.js", () => ({
  getCredentialsForPlatform: vi.fn(),
}));

const opts = { toolCallId: "wechat-search-test", messages: [] } as never;

function validCreds(): Record<string, string> {
  return { token: "TK", cookie: "slave_sid=x", expiry: new Date(Date.now() + 3600_000).toISOString() };
}

function mockFetchJson(obj: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({ text: async () => JSON.stringify(obj) }) as never;
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

  it("无凭据 → NO_CREDENTIAL,不发请求", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({});
    const r = await search("阮一峰");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("NO_CREDENTIAL");
  });

  it("凭据过期 → EXPIRED", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({
      token: "TK",
      cookie: "c",
      expiry: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await search("x");
    expect(r.state).toBe("EXPIRED");
  });

  it("半授权(有 token 无 expiry) → 视为未授权,与 status 判据一致(review #3)", async () => {
    // 凭据非原子写、中途断:token 写成、expiry 没写。旧实现会当"永不过期"放行,和 status 矛盾。
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({ token: "TK", cookie: "c" });
    global.fetch = vi.fn() as never;
    const r = await search("x");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("NO_CREDENTIAL");
    expect(global.fetch).not.toHaveBeenCalled(); // 未放行到真实请求
  });

  it("搜号解析出候选公众号(nickname/fakeid)", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({
      base_resp: { ret: 0 },
      list: [
        { nickname: "阮一峰的网络日志", fakeid: "MzA123", alias: "ruanyf", round_head_img: "http://img", signature: "sig" },
      ],
      total: 1,
    });
    const r = await search("阮一峰");
    expect(r.ok).toBe(true);
    const accounts = r.accounts as Array<Record<string, string>>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.nickname).toBe("阮一峰的网络日志");
    expect(accounts[0]?.fakeid).toBe("MzA123");
  });

  it("频控 ret=200013 → RATE_LIMIT", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: 200013, err_msg: "freq control" } });
    const r = await search("x");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("RATE_LIMIT");
  });

  it("列文解析多层嵌套 appmsgpublish", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    const publishInfo = JSON.stringify({
      appmsgex: [
        { title: "科技爱好者周刊#331", link: "https://mp.weixin.qq.com/s/abc", cover: "http://cov", update_time: 1700000000 },
      ],
    });
    const publishPage = JSON.stringify({ publish_list: [{ publish_info: publishInfo }], total_count: 1 });
    mockFetchJson({ base_resp: { ret: 0 }, publish_page: publishPage });
    const r = await list("MzA123");
    expect(r.ok).toBe(true);
    const articles = r.articles as Array<Record<string, unknown>>;
    expect(articles).toHaveLength(1);
    expect(articles[0]?.title).toBe("科技爱好者周刊#331");
    expect(String(articles[0]?.link)).toContain("mp.weixin.qq.com/s");
  });

  it("会话失效 ret=-6 → SESSION(引导重扫)", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    mockFetchJson({ base_resp: { ret: -6 } });
    const r = await list("x");
    expect(r.ok).toBe(false);
    expect(r.state).toBe("SESSION");
  });

  it("非 JSON 响应(被风控重定向) → SESSION", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue(validCreds());
    global.fetch = vi.fn().mockResolvedValue({ text: async () => "<html>验证</html>" }) as never;
    const r = await search("x");
    expect(r.state).toBe("SESSION");
  });
});
