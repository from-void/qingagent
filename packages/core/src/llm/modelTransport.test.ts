import { describe, expect, it } from "vitest";
import { Dispatcher } from "undici";
import {
  DEFAULT_MODEL_CONNECT_TIMEOUT_MS,
  MODEL_CONNECTION_REUSE_OPTIONS,
  MODEL_KEEP_ALIVE_MAX_TIMEOUT_MS,
  createModelDispatcher,
  createModelDnsLookup,
  isConnectionResetError,
  isReplayableModelRequest,
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

  it("模型出站关闭 H2 并压住 keep-alive 可信上限", () => {
    // undici 8 的 allowH2 默认是 true；一旦复活 H2 会话复用，工具执行后的续写就会
    // 撞上被网关掐掉的空闲会话（other side closed）。
    expect(MODEL_CONNECTION_REUSE_OPTIONS.allowH2).toBe(false);
    expect(MODEL_CONNECTION_REUSE_OPTIONS.keepAliveMaxTimeout)
      .toBe(MODEL_KEEP_ALIVE_MAX_TIMEOUT_MS);
    expect(MODEL_KEEP_ALIVE_MAX_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("连接复用竞态判定", () => {
  function wrapFetchFailed(cause: unknown): Error {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = cause;
    return error;
  }

  it("识别 undici SocketError 的 other side closed（含 fetch 包装层）", () => {
    const socketError = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    expect(isConnectionResetError(socketError)).toBe(true);
    expect(isConnectionResetError(wrapFetchFailed(socketError))).toBe(true);
  });

  it("识别 socket hang up / ECONNRESET / EPIPE", () => {
    expect(isConnectionResetError(wrapFetchFailed(new Error("socket hang up")))).toBe(true);
    expect(isConnectionResetError(
      wrapFetchFailed(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    )).toBe(true);
    expect(isConnectionResetError(
      wrapFetchFailed(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    )).toBe(true);
  });

  it("取消/超时/普通失败不算连接复用竞态", () => {
    expect(isConnectionResetError(
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    )).toBe(false);
    expect(isConnectionResetError(
      Object.assign(new Error("Model DNS preflight timed out"), { name: "TimeoutError" }),
    )).toBe(false);
    expect(isConnectionResetError(
      wrapFetchFailed(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    )).toBe(false);
    expect(isConnectionResetError(new Error("Blocked private address"))).toBe(false);
  });

  it("cause 环不会导致死循环", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isConnectionResetError(a)).toBe(false);
  });

  it("只有可原样重放的请求体才允许重试", () => {
    expect(isReplayableModelRequest("https://model.test/v1", undefined)).toBe(true);
    expect(isReplayableModelRequest("https://model.test/v1", { body: "{\"a\":1}" })).toBe(true);
    expect(isReplayableModelRequest(new URL("https://model.test/v1"), {
      body: new Uint8Array([1, 2, 3]),
    })).toBe(true);
    expect(isReplayableModelRequest("https://model.test/v1", {
      body: new ReadableStream(),
    } as RequestInit)).toBe(false);
    expect(isReplayableModelRequest(
      new Request("https://model.test/v1", { method: "POST", body: "x" }),
      undefined,
    )).toBe(false);
  });
});
