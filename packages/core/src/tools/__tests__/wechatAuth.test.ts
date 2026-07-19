import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLaunchCandidates } from "@qingagent/doc-render/browser";
import { saveConnectorCredentialBundle } from "../../credentials/credentialsRepo.js";
import { readWechatCredentialBundle } from "../../connectors/wechatCredentials.js";
import { wechatAuthService } from "../../connectors/wechatAuthService.js";
import { probeWechatSearchbiz } from "../wechatSearch.js";
import { wechatAuthStartTool, wechatAuthStatusTool } from "../wechatAuth.js";

vi.mock("@qingagent/doc-render/browser", () => ({ browserLaunchCandidates: vi.fn() }));
vi.mock("../../credentials/credentialsRepo.js", () => ({ saveConnectorCredentialBundle: vi.fn() }));
vi.mock("../../connectors/wechatCredentials.js", () => ({
  readWechatCredentialBundle: vi.fn(), clearWechatSessionIssue: vi.fn(),
}));
vi.mock("../wechatSearch.js", () => ({ probeWechatSearchbiz: vi.fn() }));

const opts = { toolCallId: "wechat-auth-test", messages: [] } as never;
function browserMock(
  waitForURL: Promise<void> = Promise.resolve(),
  pageUrl = "https://mp.weixin.qq.com/cgi-bin/home?token=ABC",
) {
  const qrElement = { screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined), waitForSelector: vi.fn().mockResolvedValue(qrElement), waitForFunction: vi.fn().mockResolvedValue(undefined), waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockReturnValue(waitForURL), on: vi.fn(), mainFrame: vi.fn().mockReturnValue({}),
    url: vi.fn().mockReturnValue(pageUrl),
    locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue("测试公众号") }),
  };
  const context = { addInitScript: vi.fn(), newPage: vi.fn().mockResolvedValue(page), cookies: vi.fn().mockResolvedValue([{ name: "sid", value: "secret-cookie" }]) };
  const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
  const launch = vi.fn().mockResolvedValue(browser);
  vi.mocked(browserLaunchCandidates).mockReturnValue([{ kind: "default", label: "test", launch }]);
  return { browser, page, launch };
}
async function start() { return await wechatAuthStartTool.execute!({}, opts) as Record<string, unknown>; }
async function status() { return await wechatAuthStatusTool.execute!({}, opts) as Record<string, unknown>; }

describe("wechat auth connector service thin tools", () => {
  beforeEach(() => {
    vi.clearAllMocks(); wechatAuthService.resetForTests();
    vi.mocked(readWechatCredentialBundle).mockResolvedValue(null);
    vi.mocked(saveConnectorCredentialBundle).mockResolvedValue({ version: 1, connectorId: "wechat-mp", revision: 1, payload: {} });
    vi.mocked(probeWechatSearchbiz).mockResolvedValue({ ok: true });
  });
  afterEach(() => { wechatAuthService.resetForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("空凭据返回 NO_CREDENTIAL", async () => {
    await expect(status()).resolves.toMatchObject({ state: "NO_CREDENTIAL", mpName: "" });
  });

  it("授权成功单事务写 bundle，结果携 connectorId/pendingId", async () => {
    browserMock();
    const result = await start();
    expect(result).toMatchObject({ ok: true, connectorId: "wechat-mp", pendingId: expect.any(String), reused: false });
    await vi.waitFor(() => expect(saveConnectorCredentialBundle).toHaveBeenCalledWith("wechat-mp", expect.objectContaining({
      strategy: "qr-session", version: 1, account: "测试公众号", cookie: "sid=secret-cookie", token: "ABC", expiry: expect.any(String),
    }), expect.objectContaining({ writeGuard: expect.any(Function) })));
  });

  it("并发/重复 start 单飞复用同一 pending 与二维码，不互关 browser", async () => {
    let resolveLanding!: () => void;
    const { launch, browser } = browserMock(new Promise<void>((resolve) => { resolveLanding = resolve; }));
    const first = await start();
    const second = await start();
    expect(second).toMatchObject({ pendingId: first.pendingId, imageDataUri: first.imageDataUri, reused: true });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    resolveLanding();
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledTimes(1));
  });

  it("pending 状态供旧 confirmQuery status 兜底读取", async () => {
    let rejectLanding!: (error: Error) => void;
    browserMock(new Promise<void>((_resolve, reject) => { rejectLanding = reject; }));
    await start();
    await expect(status()).resolves.toMatchObject({ state: "AUTHORIZING" });
    rejectLanding(new Error("timeout"));
    await vi.waitFor(async () => expect((await status()).state).toBe("TIMEOUT"));
  });

  it("首页兜底请求 10 秒超时后授权及时收尾", async () => {
    vi.useFakeTimers();
    browserMock(Promise.resolve(), "https://mp.weixin.qq.com/cgi-bin/home");
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    await start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const requestSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignal?.aborted).toBe(true);
    await expect(status()).resolves.toMatchObject({ state: "TIMEOUT" });
  });

  it("取消授权会中止正在进行的首页兜底请求", async () => {
    const { browser } = browserMock(Promise.resolve(), "https://mp.weixin.qq.com/cgi-bin/home");
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    await start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const requestSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(false);

    wechatAuthService.resetForTests();

    expect(requestSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalled());
  });
});
