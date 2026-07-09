import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserLaunchCandidates } from "../../browser/pool.js";
import {
  getCredentialsForPlatform,
  saveCredentialRecord,
} from "../../credentials/credentialsRepo.js";
import { wechatAuthStartTool, wechatAuthStatusTool } from "../wechatAuth.js";

vi.mock("../../browser/pool.js", () => ({
  browserLaunchCandidates: vi.fn(),
}));

vi.mock("../../credentials/credentialsRepo.js", () => ({
  saveCredentialRecord: vi.fn(),
  getCredentialsForPlatform: vi.fn(),
}));

const toolInvocationOptions = { toolCallId: "wechat-auth-test", messages: [] } as never;

function createBrowserMock() {
  const qrElement = {
    screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(qrElement),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=ABC&lang=zh_CN"),
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
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, context, page, qrElement };
}

async function executeStart() {
  if (!wechatAuthStartTool.execute) throw new Error("wechat_auth_start execute missing");
  return await wechatAuthStartTool.execute({}, toolInvocationOptions) as {
    ok: boolean;
    imageDataUri: string;
    expiresInSec: number;
  };
}

async function executeStatus() {
  if (!wechatAuthStatusTool.execute) throw new Error("wechat_auth_status execute missing");
  return await wechatAuthStatusTool.execute({}, toolInvocationOptions) as {
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
  });

  it("wechat_auth_start 返回二维码,后台登录成功后保存 token/cookie/expiry", async () => {
    const { browser, context, page, qrElement } = createBrowserMock();
    vi.mocked(browserLaunchCandidates).mockReturnValue([
      { kind: "default", label: "test", launch: async () => browser as never },
    ]);

    const result = await executeStart();

    expect(result.ok).toBe(true);
    expect(result.imageDataUri).toMatch(/^data:image\/png;base64,/);
    expect(result.expiresInSec).toBe(240);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith("https://mp.weixin.qq.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(page.waitForSelector).toHaveBeenCalledWith(".login__type__container__scan__qrcode", {
      timeout: 10_000,
    });
    expect(qrElement.screenshot).toHaveBeenCalledWith({ type: "png" });

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
      expect(saveCredentialRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: "wechat",
          key: "expiry",
          value: expect.any(String),
        }),
      );
      expect(saveCredentialRecord).toHaveBeenCalledWith({
        platform: "wechat",
        key: "mp_name",
        value: "测试公众号",
      });
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
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
      ok: false,
      state: "EXPIRED",
      mpName: "测试公众号",
      message: "授权已过期",
    });
  });

  it("wechat_auth_status 对空凭据返回 NO_CREDENTIAL", async () => {
    vi.mocked(getCredentialsForPlatform).mockResolvedValue({});

    await expect(executeStatus()).resolves.toEqual({
      ok: false,
      state: "NO_CREDENTIAL",
      mpName: "",
      message: "未授权",
    });
  });
});
