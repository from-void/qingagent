import { describe, expect, it, vi } from "vitest";
import type { ConnectorCredentialBundle } from "../../credentials/credentialsRepo.js";
import type { WechatCredentialPayload } from "../wechatCredentials.js";

vi.mock("../wechatAuthService.js", () => ({ wechatAuthService: { status: vi.fn(), disconnectPending: vi.fn(), start: vi.fn() } }));

import { wechatAuthService } from "../wechatAuthService.js";
import { WechatConnector } from "../wechatConnector.js";

const now = () => new Date("2026-07-11T12:00:00.000Z");
const payload: WechatCredentialPayload = {
  strategy: "qr-session", version: 1, token: "token-test", cookie: "cookie-test",
  expiry: "2026-07-12T12:00:00.000Z", account: "测试公众号",
};
const bundle = (revision = 1, patch: Partial<WechatCredentialPayload> = {}): ConnectorCredentialBundle<WechatCredentialPayload> => ({
  version: 1, connectorId: "wechat-mp", revision, payload: { ...payload, ...patch },
});

describe("WechatConnector", () => {
  it("status 经 bundle TTL 判读且不 probe", async () => {
    const probeSearchbiz = vi.fn();
    const connector = new WechatConnector({ readBundle: async () => bundle(), probeSearchbiz, now });
    await expect(connector.status()).resolves.toMatchObject({ state: "connected", account: { displayName: "测试公众号" }, statusFreshness: "ttl" });
    expect(probeSearchbiz).not.toHaveBeenCalled();
  });

  it("cookie 缺失不误报已连接", async () => {
    const connector = new WechatConnector({ readBundle: async () => bundle(1, { cookie: "" }), now });
    await expect(connector.probe()).resolves.toMatchObject({ state: "disconnected", reasonCode: "WECHAT_CREDENTIAL_MISSING" });
  });

  it.each([
    [{ ok: true } as const, { state: "connected", reasonCode: null, statusFreshness: "fresh" }],
    [{ ok: false, kind: "reauth", message: "session" } as const, { state: "needs_reauth", reasonCode: "needs_reauth", statusFreshness: "fresh" }],
    [{ ok: false, kind: "rate_limit", message: "limited" } as const, { state: "connected", reasonCode: "rate_limit", statusFreshness: "ttl" }],
    [{ ok: false, kind: "transient", message: "network" } as const, { state: "connected", reasonCode: "transient", statusFreshness: "ttl" }],
  ])("probe 归一业务错误: %o", async (probeResult, expected) => {
    const connector = new WechatConnector({ readBundle: async () => bundle(), probeSearchbiz: async () => probeResult, now });
    await expect(connector.probe()).resolves.toMatchObject({ ...expected, lastCheckedAt: "2026-07-11T12:00:00.000Z" });
  });

  it("pending 轮询透传扫码信号:scanned → reasonCode=WECHAT_SCANNED", async () => {
    const connector = new WechatConnector({ readBundle: async () => null, now });
    const status = vi.mocked(wechatAuthService.status);
    status.mockResolvedValueOnce({ ok: true, state: "AUTHORIZING", scanned: false, mpName: "", message: "正在等待扫码授权" });
    await expect(connector.status("pid-1")).resolves.toMatchObject({ state: "pending", reasonCode: null });
    status.mockResolvedValueOnce({ ok: true, state: "AUTHORIZING", scanned: true, mpName: "", message: "已扫到二维码,请在手机上确认登录" });
    await expect(connector.status("pid-1")).resolves.toMatchObject({ state: "pending", reasonCode: "WECHAT_SCANNED" });
    status.mockResolvedValueOnce({ ok: true, state: "VERIFYING", scanned: true, mpName: "", message: "核验中" });
    await expect(connector.status("pid-1")).resolves.toMatchObject({ state: "pending", reasonCode: "WECHAT_SCANNED" });
  });

  it("disconnect 携当前 revision 删除 bundle（实现依赖内同时清 legacy）", async () => {
    const deleteBundle = vi.fn(async () => undefined);
    const connector = new WechatConnector({ readBundle: async () => bundle(7), deleteBundle, now });
    await expect(connector.disconnect()).resolves.toMatchObject({ state: "disconnected" });
    expect(deleteBundle).toHaveBeenCalledWith(7);
  });

  it("bundle 损坏时 disconnect 仍按无有效 revision 删除原始行", async () => {
    const deleteBundle = vi.fn(async () => undefined);
    const connector = new WechatConnector({
      readBundle: async () => { throw new Error("密文损坏"); },
      deleteBundle,
      now,
    });

    await expect(connector.disconnect()).resolves.toMatchObject({
      state: "disconnected",
      reasonCode: "USER_DISCONNECTED",
    });
    expect(deleteBundle).toHaveBeenCalledWith(null);
  });
});
