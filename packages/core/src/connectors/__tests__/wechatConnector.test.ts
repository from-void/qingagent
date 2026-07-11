import { describe, expect, it, vi } from "vitest";
import { WechatConnector } from "../wechatConnector.js";

const now = () => new Date("2026-07-11T12:00:00.000Z");
const credentials = {
  token: "token-test",
  cookie: "cookie-test",
  expiry: "2026-07-12T12:00:00.000Z",
  mp_name: "测试公众号",
};

describe("WechatConnector", () => {
  it("status 只按 TTL 判读并如实标 ttl", async () => {
    const probeSearchbiz = vi.fn();
    const connector = new WechatConnector({ getCredentials: async () => credentials, probeSearchbiz, now });
    await expect(connector.status()).resolves.toMatchObject({
      state: "connected",
      statusFreshness: "ttl",
      lastCheckedAt: null,
    });
    expect(probeSearchbiz).not.toHaveBeenCalled();
  });

  it("cookie 缺失时不误报已连接且不发起 probe", async () => {
    const probeSearchbiz = vi.fn();
    const connector = new WechatConnector({
      getCredentials: async () => ({ ...credentials, cookie: "" }),
      probeSearchbiz,
      now,
    });

    await expect(connector.probe()).resolves.toMatchObject({
      state: "disconnected",
      reasonCode: "WECHAT_CREDENTIAL_MISSING",
      statusFreshness: "ttl",
    });
    expect(probeSearchbiz).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: true } as const, { state: "connected", reasonCode: null, statusFreshness: "fresh" }],
    [{ ok: false, kind: "reauth", message: "session" } as const, { state: "needs_reauth", reasonCode: "SESSION", statusFreshness: "fresh" }],
    [{ ok: false, kind: "rate_limit", message: "limited" } as const, { state: "connected", reasonCode: "RATE_LIMIT", statusFreshness: "ttl" }],
  ])("probe 映射成功/SESSION/限速: %o", async (probeResult, expected) => {
    const connector = new WechatConnector({
      getCredentials: async () => credentials,
      probeSearchbiz: async () => probeResult,
      now,
    });
    await expect(connector.probe()).resolves.toMatchObject({
      ...expected,
      lastCheckedAt: "2026-07-11T12:00:00.000Z",
    });
  });

  it("disconnect 只调用事务删除依赖一次", async () => {
    const deleteCredentials = vi.fn(async () => undefined);
    const connector = new WechatConnector({ deleteCredentials, now });
    await expect(connector.disconnect()).resolves.toMatchObject({ state: "disconnected" });
    expect(deleteCredentials).toHaveBeenCalledTimes(1);
  });
});
