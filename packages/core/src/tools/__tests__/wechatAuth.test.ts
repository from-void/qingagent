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
  readWechatCredentialBundle: vi.fn(),
}));
vi.mock("../wechatSearch.js", () => ({ probeWechatSearchbiz: vi.fn() }));

const opts = { toolCallId: "wechat-auth-test", messages: [] } as never;
const EXPECTED_WECHAT_SEARCH_ROUTE_QUESTIONNAIRE_LITERAL = `{"id":"wechat-search-route","rationale":"先选一种查找方式，我再继续帮你找这篇公众号文章。","questions":[{"header":"查找方式","question":"你想用哪种方式查找公众号文章？","multiSelect":false,"options":[{"value":"login-owned","label":"我有公众号，直接扫码登录（推荐）","description":"借用公众号后台自带的搜索能力，你的公众号只是登录入口。"},{"value":"login-register","label":"我没有，先去 mp.weixin.qq.com 免费注册再扫码","description":"注册后借用公众号后台自带的搜索能力，你的公众号只是登录入口。"},{"value":"fallback-websearch","label":"先用联网搜索（效果较差，只有零散公开网页）","description":"不登录公众号后台，改用公开网页检索，结果可能不完整。"}]}]}`;

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
  return { browser, context, page, launch, qrElement };
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

  it("空凭据返回 NO_CREDENTIAL，并逐字携带路由问卷", async () => {
    const result = await status();
    expect(result).toMatchObject({ state: "NO_CREDENTIAL", mpName: "" });
    expect(JSON.stringify(result.questionnaire))
      .toBe(EXPECTED_WECHAT_SEARCH_ROUTE_QUESTIONNAIRE_LITERAL);
  });

  it("损坏凭据返回可恢复的未授权状态，不抛出或暴露原始异常", async () => {
    vi.mocked(readWechatCredentialBundle).mockRejectedValue(
      new Error("decrypt failed: legacy-secret"),
    );

    const result = await status();

    expect(result).toMatchObject({
      state: "NO_CREDENTIAL",
      mpName: "",
      message: "授权信息已损坏，请重新扫码登录",
      questionnaire: expect.any(Object),
    });
    expect(JSON.stringify(result)).not.toContain("decrypt failed");
    expect(JSON.stringify(result)).not.toContain("legacy-secret");
  });

  it.each([
    ["payload 为 null", null],
    [
      "payload 缺少 token",
      {
        strategy: "qr-session",
        version: 1,
        account: "测试公众号",
        cookie: "sid=secret-cookie",
        expiry: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    [
      "payload 字段类型错误",
      {
        strategy: "qr-session",
        version: 1,
        account: "测试公众号",
        cookie: "sid=secret-cookie",
        token: 123,
        expiry: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  ])("已读出的损坏凭据（%s）仍返回可恢复的未授权状态", async (_label, payload) => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue({
      version: 1,
      connectorId: "wechat-mp",
      revision: 1,
      payload,
    } as never);

    await expect(status()).resolves.toMatchObject({
      state: "NO_CREDENTIAL",
      mpName: "",
      message: "授权信息已损坏，请重新扫码登录",
      questionnaire: expect.any(Object),
    });
  });

  it("READY 状态不再携带路由问卷", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue({
      version: 1,
      connectorId: "wechat-mp",
      revision: 1,
      payload: {
        strategy: "qr-session",
        version: 1,
        account: "测试公众号",
        cookie: "sid=secret-cookie",
        token: "ABC",
        expiry: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(status()).resolves.toMatchObject({
      state: "READY",
      mpName: "测试公众号",
      questionnaire: null,
    });
  });

  it("有效期内 bundle 已标记会话失效时返回 EXPIRED", async () => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue({
      version: 1,
      connectorId: "wechat-mp",
      revision: 3,
      payload: {
        strategy: "qr-session",
        version: 1,
        account: "测试公众号",
        cookie: "sid=secret-cookie",
        token: "ABC",
        expiry: new Date(Date.now() + 60_000).toISOString(),
        sessionIssue: {
          reasonCode: "needs_reauth",
          lastCheckedAt: "2026-07-11T12:00:00.000Z",
        },
      },
    });

    await expect(status()).resolves.toMatchObject({
      state: "EXPIRED",
      mpName: "测试公众号",
      questionnaire: expect.any(Object),
    });
  });

  it.each([
    [
      { ok: false, kind: "capability_denied", message: "denied" } as const,
      "CAPABILITY_DENIED",
    ],
    [
      { ok: false, kind: "reauth", message: "expired" } as const,
      "NO_CREDENTIAL",
    ],
  ])("本轮授权终态 %s 优先于有效旧 bundle", async (probeResult, expectedState) => {
    vi.mocked(readWechatCredentialBundle).mockResolvedValue({
      version: 1,
      connectorId: "wechat-mp",
      revision: 2,
      payload: {
        strategy: "qr-session",
        version: 1,
        account: "旧公众号",
        cookie: "sid=old-cookie",
        token: "OLD",
        expiry: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    vi.mocked(probeWechatSearchbiz).mockResolvedValue(probeResult);
    browserMock();

    await start();

    await vi.waitFor(async () => {
      await expect(status()).resolves.toMatchObject({
        state: expectedState,
        questionnaire: expect.any(Object),
      });
    });
  });

  it.each([
    ["NO_CREDENTIAL", true],
    ["AUTHORIZING", false],
    ["VERIFYING", false],
    ["READY", false],
    ["CAPABILITY_DENIED", true],
    ["TIMEOUT", true],
    ["EXPIRED", true],
  ] as const)("%s 状态的路由问卷附带规则正确", async (state, shouldIncludeQuestionnaire) => {
    const statusSpy = vi.spyOn(wechatAuthService, "status").mockResolvedValue({
      ok: true,
      state,
      mpName: "",
      message: "测试状态",
    });

    try {
      const result = await status();

      if (shouldIncludeQuestionnaire) {
        expect(JSON.stringify(result.questionnaire))
          .toBe(EXPECTED_WECHAT_SEARCH_ROUTE_QUESTIONNAIRE_LITERAL);
      } else {
        expect(result.questionnaire).toBeNull();
      }
    } finally {
      statusSpy.mockRestore();
    }
  });

  it("授权成功单事务写 bundle，结果携 connectorId/pendingId", async () => {
    browserMock();
    const result = await start();
    expect(result).toMatchObject({ ok: true, connectorId: "wechat-mp", pendingId: expect.any(String), reused: false });
    await vi.waitFor(() => expect(saveConnectorCredentialBundle).toHaveBeenCalledWith("wechat-mp", expect.objectContaining({
      strategy: "qr-session", version: 1, account: "测试公众号", cookie: "sid=secret-cookie", token: "ABC", expiry: expect.any(String),
    }), expect.objectContaining({ writeGuard: expect.any(Function) })));
  });

  it("浏览器启动失败时立即清理 pending，并只返回中性页面加载失败", async () => {
    vi.mocked(browserLaunchCandidates).mockReturnValue([
      {
        kind: "default",
        label: "test",
        launch: vi.fn().mockRejectedValue(
          new Error("browser executable missing: /private/runtime/path"),
        ),
      },
    ]);

    await expect(start()).rejects.toThrow("授权页面加载失败，请稍后重试");
    await expect(status()).resolves.toMatchObject({
      state: "NO_CREDENTIAL",
      message: "未授权",
    });

    browserMock();
    await expect(start()).resolves.toMatchObject({ reused: false });
  });

  it("登录页导航失败时立即清理 pending，不误报扫码超时", async () => {
    const { page } = browserMock();
    page.goto.mockRejectedValueOnce(
      new Error("net::ERR_CONNECTION_RESET at https://mp.weixin.qq.com/"),
    );

    await expect(start()).rejects.toThrow("授权页面加载失败，请稍后重试");
    await expect(status()).resolves.toMatchObject({
      state: "NO_CREDENTIAL",
      message: "未授权",
    });
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

  it("二维码就绪后统一续期 Store、浏览器等待与对外截止时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const neverLands = new Promise<void>(() => {});
    const { browser, qrElement } = browserMock(neverLands);
    qrElement.screenshot.mockImplementation(
      () => new Promise<Buffer>((resolve) => {
        setTimeout(() => resolve(Buffer.alloc(1_600, 1)), 30_000);
      }),
    );

    const starting = start();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await starting;
    const expectedExpiresAt = Date.parse("2026-07-11T12:04:30.000Z");

    expect(result).toMatchObject({
      expiresAt: expectedExpiresAt,
      expiresInSec: 240,
    });

    await vi.advanceTimersByTimeAsync(210_000);
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(browser.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("pending 状态供旧 confirmQuery status 兜底读取", async () => {
    let rejectLanding!: (error: Error) => void;
    browserMock(new Promise<void>((_resolve, reject) => { rejectLanding = reject; }));
    await start();
    await expect(status()).resolves.toMatchObject({ state: "AUTHORIZING" });
    rejectLanding(new DOMException("扫码落地超时", "TimeoutError"));
    await vi.waitFor(async () => expect((await status()).state).toBe("TIMEOUT"));
  });

  it("waitForURL 非超时异常进入中性失败，不误报扫码超时或泄漏异常", async () => {
    browserMock(Promise.reject(new Error("frame detached: /private/browser/path")));

    await start();

    await vi.waitFor(async () => {
      const result = await status();
      expect(result).toMatchObject({
        state: "NO_CREDENTIAL",
        message: "授权未能完成,请重新发起授权",
      });
      expect(JSON.stringify(result)).not.toContain("frame detached");
      expect(JSON.stringify(result)).not.toContain("/private/browser/path");
    });
  });

  it("waitForURL 成功后读取 cookies 失败进入中性失败", async () => {
    const { context } = browserMock();
    context.cookies.mockRejectedValueOnce(new Error("cookie store unavailable"));

    await start();

    await vi.waitFor(async () => {
      await expect(status()).resolves.toMatchObject({
        state: "NO_CREDENTIAL",
        message: "授权未能完成,请重新发起授权",
      });
    });
  });

  it("首页 token 兜底请求 10 秒超时后进入中性失败", async () => {
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
    await expect(status()).resolves.toMatchObject({
      state: "NO_CREDENTIAL",
      message: "授权未能完成,请重新发起授权",
    });
  });

  it("waitForURL 成功后探针异常进入中性失败", async () => {
    browserMock();
    vi.mocked(probeWechatSearchbiz).mockRejectedValueOnce(
      new Error("probe transport secret"),
    );

    await start();

    await vi.waitFor(async () => {
      const result = await status();
      expect(result).toMatchObject({
        state: "NO_CREDENTIAL",
        message: "授权未能完成,请重新发起授权",
      });
      expect(JSON.stringify(result)).not.toContain("probe transport secret");
    });
  });

  it("waitForURL 成功后凭据保存失败进入中性失败", async () => {
    browserMock();
    vi.mocked(saveConnectorCredentialBundle).mockRejectedValueOnce(
      new Error("credential storage secret"),
    );

    await start();

    await vi.waitFor(async () => {
      const result = await status();
      expect(result).toMatchObject({
        state: "NO_CREDENTIAL",
        message: "授权未能完成,请重新发起授权",
      });
      expect(JSON.stringify(result)).not.toContain("credential storage secret");
    });
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
