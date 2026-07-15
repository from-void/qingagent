import { describe, expect, it } from "vitest";
import { EnvHttpProxyAgent } from "undici";
import {
  DEFAULT_MODEL_CONNECT_TIMEOUT_MS,
  createModelDispatcher,
  resolveModelDispatcherConfig,
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
    });
    expect(config).not.toHaveProperty("headersTimeout");
    expect(config).not.toHaveProperty("bodyTimeout");

    const dispatcher = createModelDispatcher(env);
    expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    await dispatcher.close();
  });

  it("非法连接超时配置回退到 5s", () => {
    expect(resolveModelDispatcherConfig({ QINGAGENT_MODEL_CONNECT_TIMEOUT_MS: "invalid" }).connectTimeout)
      .toBe(DEFAULT_MODEL_CONNECT_TIMEOUT_MS);
  });
});
