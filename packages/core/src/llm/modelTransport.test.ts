import { describe, expect, it } from "vitest";
import { Dispatcher } from "undici";
import {
  DEFAULT_MODEL_CONNECT_TIMEOUT_MS,
  createModelDispatcher,
  createModelDnsLookup,
  resolveModelDispatcherConfig,
  shouldProxyModelUrl,
} from "./modelTransport.js";

describe("modelTransport", () => {
  it("EnvHttpProxyAgent 保留大小写代理变量与 no_proxy 语义,且只配置 connectTimeout", async () => {
    const env = {
      http_proxy: "http://lower-http.test:8080",
      HTTP_PROXY: "http://upper-http.test:8080",
      HTTPS_PROXY: "http://upper-https.test:8443",
      no_proxy: "localhost,.internal.test",
      QINGAGENT_MODEL_CONNECT_TIMEOUT_MS: "4321",
    };

    const config = resolveModelDispatcherConfig(env);
    expect(config).toEqual({
      connectTimeout: 4321,
      httpProxy: "http://lower-http.test:8080",
      httpsProxy: "http://upper-https.test:8443",
      noProxy: "localhost,.internal.test",
      allowPrivate: false,
    });
    expect(config).not.toHaveProperty("headersTimeout");
    expect(config).not.toHaveProperty("bodyTimeout");

    const dispatcher = createModelDispatcher(env);
    expect(dispatcher).toBeInstanceOf(Dispatcher);
    await dispatcher.close();
  });

  it("DNS 固定 lookup 放行全部公网记录并拒绝任一私网记录", async () => {
    const publicLookup = createModelDnsLookup({}, (_hostname, _options, callback) => {
      callback(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);
    });
    await expect(new Promise((resolve, reject) => {
      publicLookup(new URL("https://public.example"), {}, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      });
    })).resolves.toMatchObject([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const mixedLookup = createModelDnsLookup({}, (_hostname, _options, callback) => {
      callback(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.9", family: 4 },
      ]);
    });
    await expect(new Promise((resolve, reject) => {
      mixedLookup(new URL("https://rebind.example"), {}, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      });
    })).rejects.toThrow(/Blocked private/);
  });

  it("DNS 固定 lookup 保留私网逃生舱语义", async () => {
    const privateLookup = createModelDnsLookup(
      { QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "1" },
      (_hostname, _options, callback) => {
        callback(null, [{ address: "10.0.0.9", family: 4 }]);
      },
    );
    await expect(new Promise((resolve, reject) => {
      privateLookup(new URL("https://private-model.example"), {}, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      });
    })).resolves.toMatchObject([{ address: "10.0.0.9", family: 4 }]);
  });

  it("DNS 固定前按原 hostname 保留 no_proxy 匹配", () => {
    const config = resolveModelDispatcherConfig({
      HTTP_PROXY: "http://proxy.test:8080",
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "localhost,.internal.test,api.example.com:8443",
    });
    expect(shouldProxyModelUrl(new URL("https://model.example.com"), config)).toBe(true);
    expect(shouldProxyModelUrl(new URL("https://svc.internal.test"), config)).toBe(false);
    expect(shouldProxyModelUrl(new URL("https://api.example.com:8443"), config)).toBe(false);
    expect(shouldProxyModelUrl(new URL("https://api.example.com"), config)).toBe(true);
  });

  it("NO_PROXY 正确匹配裸 IPv6 与带端口的方括号 IPv6", () => {
    const config = resolveModelDispatcherConfig({
      HTTP_PROXY: "http://proxy.test:8080",
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "::1,2001:db8::2,[2001:db8::3]:8443",
    });

    expect(shouldProxyModelUrl(new URL("http://[::1]:11434"), config)).toBe(false);
    expect(shouldProxyModelUrl(new URL("https://[2001:db8::2]"), config)).toBe(false);
    expect(shouldProxyModelUrl(new URL("https://[2001:db8::3]:8443"), config)).toBe(false);
    expect(shouldProxyModelUrl(new URL("https://[2001:db8::3]"), config)).toBe(true);
  });

  it("非法连接超时配置回退到 5s", () => {
    expect(resolveModelDispatcherConfig({ QINGAGENT_MODEL_CONNECT_TIMEOUT_MS: "invalid" }).connectTimeout)
      .toBe(DEFAULT_MODEL_CONNECT_TIMEOUT_MS);
  });
});
