import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserLaunchCandidates } from "../../browser/pool.js";
import {
  getCredentialsForPlatform,
  saveCredentialRecord,
} from "../../credentials/credentialsRepo.js";
import { probeWechatSearchbiz } from "../wechatSearch.js";
import { wechatAuthStartTool, wechatAuthStatusTool } from "../wechatAuth.js";

vi.mock("../../browser/pool.js", () => ({
  browserLaunchCandidates: vi.fn(),
}));

vi.mock("../../credentials/credentialsRepo.js", () => ({
  saveCredentialRecord: vi.fn(),
  getCredentialsForPlatform: vi.fn(),
}));

// 只 mock 探针这一个导出——wechatAuth 只从 wechatSearch 引入它。
vi.mock("../wechatSearch.js", () => ({
  probeWechatSearchbiz: vi.fn(),
}));

const toolInvocationOptions = { toolCallId: "wechat-auth-test", messages: [] } as never;

function createBrowserMock(landingUrl?: string) {
  const qrElement = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(qrElement),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    mainFrame: vi.fn().mockReturnValue({}),
    url: vi
      .fn()
      .mockReturnValue(
        landingUrl ?? "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=ABC&lang=zh_CN",
      ),
    locator: vi.fn().mockReturnValue({
      innerText: vi.fn().mockResolvedValue("测试公众号"),
    }),
  };
  const context = {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    cookies: vi.fn().mockResolvedValue([{ name: "slave_sid", value: "x" }]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const launch = vi.fn(async () => browser as never);
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page, qrElement, launch };
}

function mountBrowser(landingUrl?: string) {
  const mock = createBrowserMock(landingUrl);
  vi.mocked(browserLaunchCandidates).mockReturnValue([
    { kind: "default", label: "test", launch: mock.launch },
  ]);
  return mock;
}

async function executeStart() {
  if (!wechatAuthStartTool.execute) throw new Error("wechat_auth_start execute missing");
  return (await wechatAuthStartTool.execute({}, toolInvocationOptions)) as {
    ok: boolean;
    imageDataUri: string;
    expiresInSec: number;
  };
}

async function executeStatus() {
  if (!wechatAuthStatusTool.execute) throw new Error("wechat_auth_status execute missing");
  return (await wechatAuthStatusTool.execute({}, toolInvocationOptions)) as {
    ok: boolean;
    state: string;
    mpName: string;
    message: string;
  };
}

describe("wechat auth tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveCredentialRecord).mockResolvedValue(undefined);
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({});
    vi.mocked(probeWechatSearchbiz).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 排最前:此刻模块级 authState 尚为空,才测得到 NO_CREDENTIAL 兜底(后续 start 测试会污染 authState)。
  it("wechat_auth_status 对空凭据返回 NO_CREDENTIAL", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({});

    await expect(executeStatus()).resolves.toEqual({
      ok: true,
      state: "NO_CREDENTIAL",
      mpName: "",
      message: "未授权",
    });
  });

  it("wechat_auth_status 对有效凭据返回 READY", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({
      token: "ABC",
      expiry: new Date(Date.now() + 60_000).toISOString(),
      mp_name: "测试公众号",
    });

    await expect(executeStatus()).resolves.toEqual({
      ok: true,
      state: "READY",
      mpName: "测试公众号",
      message: "已授权",
    });
  });

  it("wechat_auth_status 对过期凭据返回 EXPIRED", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({
      token: "ABC",
      expiry: new Date(Date.now() - 60_000).toISOString(),
      mp_name: "测试公众号",
    });

    await expect(executeStatus()).resolves.toEqual({
      ok: true,
      state: "EXPIRED",
      mpName: "测试公众号",
      message: "授权已过期",
    });
  });

  it("扫码尚未落地时 status 立即返回 AUTHORIZING，不等待核验 deferred", async () => {
    const { page } = mountBrowser();
    let rejectWaitForUrl!: (error: Error) => void;
    page.waitForURL.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectWaitForUrl = reject;
      }),
    );

    await executeStart();

    await expect(executeStatus()).resolves.toEqual({
      ok: true,
      state: "AUTHORIZING",
      mpName: "",
      message: "正在等待扫码授权",
    });

    rejectWaitForUrl(new Error("test cleanup"));
    await vi.waitFor(async () => expect((await executeStatus()).state).toBe("TIMEOUT"));
  });

  it("落地 /cgi-bin/home + 探针通过 → 存 token/cookie/expiry + READY", async () => {
    const { browser } = mountBrowser();

    const result = await executeStart();

    expect(result.ok).toBe(true);
    expect(result.imageDataUri).toMatch(/^data:image\/png;base64,/);
    expect(result.expiresInSec).toBe(240);

    await vi.waitFor(() => {
      expect(saveCredentialRecord).toHaveBeenCalledWith({
        platform: "wechat",
        key: "token",
        value: "ABC",
      });
      expect(saveCredentialRecord).toHaveBeenCalledWith({
        platform: "wechat",
        key: "cookie",
        value: "slave_sid=x",
      });
    });
    // token 最后写(半授权防护):cookie/expiry/mp_name 都在 token 之前。
    const order = vi
      .mocked(saveCredentialRecord)
      .mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(order[order.length - 1]).toBe("token");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("落地 /cgi-bin/acctclose(带 token)+ 探针通过 → 照样存凭据 + READY(不猜落地页语义)", async () => {
    mountBrowser(
      "https://mp.weixin.qq.com/cgi-bin/acctclose?action=page&token=XYZ&lang=zh_CN",
    );

    await executeStart();

    await vi.waitFor(() => {
      expect(saveCredentialRecord).toHaveBeenCalledWith({
        platform: "wechat",
        key: "token",
        value: "XYZ",
      });
    });
  });

  it("已扫码进入 verifying 后，status 等本次探针完成并重读为 READY", async () => {
    const saved: Record<string, string> = {
      token: "OLD",
      expiry: new Date(Date.now() - 60_000).toISOString(),
    };
    vi.mocked(saveCredentialRecord).mockImplementation(async ({ key, value }) => {
      saved[key] = value;
    });
    vi.mocked(getCredentialsForPlatform).mockImplementation(async () => saved);
    let resolveProbe!: (result: { ok: true }) => void;
    vi.mocked(probeWechatSearchbiz).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    mountBrowser();

    await executeStart();
    await vi.waitFor(() => expect(probeWechatSearchbiz).toHaveBeenCalledTimes(1));

    const statusPromise = executeStatus();
    let statusSettled = false;
    void statusPromise.then(() => {
      statusSettled = true;
    });
    await Promise.resolve();
    expect(statusSettled).toBe(false);

    resolveProbe({ ok: true });

    await expect(statusPromise).resolves.toMatchObject({
      ok: true,
      state: "READY",
      mpName: "测试公众号",
    });
  });

  it("已扫码进入 verifying 后，status 等本次探针完成并重读为 CAPABILITY_DENIED", async () => {
    let resolveProbe!: (result: {
      ok: false;
      kind: "capability_denied";
      message: string;
    }) => void;
    vi.mocked(probeWechatSearchbiz).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    mountBrowser();

    await executeStart();
    await vi.waitFor(() => expect(probeWechatSearchbiz).toHaveBeenCalledTimes(1));
    const statusPromise = executeStatus();
    let statusSettled = false;
    void statusPromise.then(() => {
      statusSettled = true;
    });
    await Promise.resolve();
    expect(statusSettled).toBe(false);

    resolveProbe({
      ok: false,
      kind: "capability_denied",
      message: "当前所选公众号无法使用搜索能力",
    });

    await expect(statusPromise).resolves.toMatchObject({
      ok: true,
      state: "CAPABILITY_DENIED",
      message: expect.stringContaining("搜索能力"),
    });
    expect(saveCredentialRecord).not.toHaveBeenCalled();
  });

  it.each([
    ["capability_denied", "CAPABILITY_DENIED", 1],
    ["reauth", "TIMEOUT", 1],
    ["transient", "TIMEOUT", 2],
    ["unknown", "TIMEOUT", 1],
  ] as const)("探针分类 %s 映射为状态 %s", async (kind, expectedState, callCount) => {
    mountBrowser();
    vi.mocked(probeWechatSearchbiz).mockResolvedValue({
      ok: false,
      kind,
      message: `probe ${kind}`,
    });

    await executeStart();

    await vi.waitFor(async () => {
      const status = await executeStatus();
      expect(status).toMatchObject({ ok: true, state: expectedState });
    });
    expect(probeWechatSearchbiz).toHaveBeenCalledTimes(callCount);
    expect(saveCredentialRecord).not.toHaveBeenCalled();
  });

  it("探针返回搜索能力拒绝 → 不存凭据,状态 CAPABILITY_DENIED", async () => {
    mountBrowser("https://mp.weixin.qq.com/cgi-bin/acctclose?action=page&token=XYZ");
    vi.mocked(probeWechatSearchbiz).mockResolvedValue({
      ok: false,
      kind: "capability_denied",
      message: "当前所选公众号无法使用搜索能力",
    });

    await executeStart();

    await vi.waitFor(async () => {
      const st = await executeStatus();
      expect(st.ok).toBe(true);
      expect(st.state).toBe("CAPABILITY_DENIED");
      expect(st.message).toContain("已认证公众号");
    });
    expect(saveCredentialRecord).not.toHaveBeenCalled();
  });

  it("落地 URL 无 token → 兜底带 cookie 请求首页,从最终 URL 提取 token", async () => {
    mountBrowser("https://mp.weixin.qq.com/cgi-bin/home?t=home/index"); // 无 token
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        url: "https://mp.weixin.qq.com/cgi-bin/home?token=FALLBACK&lang=zh_CN",
      }),
    );

    await executeStart();

    await vi.waitFor(() => {
      expect(saveCredentialRecord).toHaveBeenCalledWith({
        platform: "wechat",
        key: "token",
        value: "FALLBACK",
      });
    });
  });

  it("waitForURL 超时(没等到扫码确认)→ 不存凭据,状态 TIMEOUT", async () => {
    const { page } = mountBrowser();
    page.waitForURL.mockRejectedValue(new Error("Timeout 240000ms exceeded"));

    const result = await executeStart(); // 二维码已 resolve,超时发生在后台
    expect(result.ok).toBe(true);

    await vi.waitFor(async () => {
      const st = await executeStatus();
      expect(st.ok).toBe(true);
      expect(st.state).toBe("TIMEOUT");
      expect(st.message).toContain("没等到扫码确认");
    });
    expect(saveCredentialRecord).not.toHaveBeenCalled();
    expect(probeWechatSearchbiz).not.toHaveBeenCalled();
  });

  // 压轴:幂等守卫会把 authState 留在 verifying(探针不返回),故排最后,不污染前面。
  it("§3 幂等守卫:verifying 中二次调用复用同一张码,不新开浏览器", async () => {
    const { launch } = mountBrowser();
    // 让探针不返回，保持 verifying 态 + pendingQr 存活。
    vi.mocked(probeWechatSearchbiz).mockReturnValue(new Promise(() => {}));

    const first = await executeStart();
    await vi.waitFor(() => expect(probeWechatSearchbiz).toHaveBeenCalledTimes(1));
    const second = await executeStart();

    expect(second.imageDataUri).toBe(first.imageDataUri);
    expect(launch).toHaveBeenCalledTimes(1); // 第二次没 launch 新浏览器
    expect(second.expiresInSec).toBeLessThanOrEqual(240);
    expect(second.expiresInSec).toBeGreaterThan(0);
  });
});
