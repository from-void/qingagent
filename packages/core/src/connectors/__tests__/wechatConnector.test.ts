import { describe, expect, it, vi } from "vitest";
import type { ConnectorCredentialBundle } from "../../credentials/credentialsRepo.js";
import type { WechatCredentialPayload } from "../wechatCredentials.js";
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

  it("disconnect 携当前 revision 删除 bundle（实现依赖内同时清 legacy）", async () => {
    const deleteBundle = vi.fn(async () => undefined);
    const connector = new WechatConnector({ readBundle: async () => bundle(7), deleteBundle, now });
    await expect(connector.disconnect()).resolves.toMatchObject({ state: "disconnected" });
    expect(deleteBundle).toHaveBeenCalledWith(7);
  });
});
