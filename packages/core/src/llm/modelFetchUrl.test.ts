import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
const connectionLookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));
vi.mock("node:dns", () => ({
  lookup: connectionLookupMock,
}));

import { validateFetchUrl } from "@qingagent/doc-render/fetch-url";
import {
  MODEL_PREFLIGHT_RETRY_DELAYS_MS,
  modelFetch,
  resetModelTransportForTests,
} from "./modelTransport.js";
import { allowsPrivateModelHost, validateModelFetchUrl } from "./modelFetchUrl.js";

const TEST_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "QINGAGENT_ALLOW_PRIVATE_MODEL_HOST",
  "QINGAGENT_MODEL_CONNECT_TIMEOUT_MS",
] as const;

let savedEnv: Partial<Record<(typeof TEST_ENV_KEYS)[number], string>>;
const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 server 未监听 TCP");
  servers.push(server);
  return `http://127.0.0.1:${address.port}`;
}

/** 预检重试退避总和:测试推进假时钟时必须把它算进去。 */
function retryBackoffMs(): number {
  return MODEL_PREFLIGHT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) messages.push(current.message);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return messages;
}

describe("主模型 URL SSRF 策略", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of TEST_ENV_KEYS) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.no_proxy = "*";
    lookupMock.mockReset();
    connectionLookupMock.mockReset();
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "api.deepseek.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (hostname === "rebind.example.com") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      if (hostname === "loopback.example.com") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      throw new Error(`unresolved ${hostname}`);
    });
    connectionLookupMock.mockImplementation(
      (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(new Error("unexpected connection lookup"), []);
      },
    );
  });

  afterEach(async () => {
    await resetModelTransportForTests();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    for (const key of TEST_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/v1",
    "http://172.16.0.8/v1",
    "http://192.168.1.8/v1",
    "http://[fc00::1]:8080/v1",
    "http://[fd12:3456::1]/v1",
    "http://[fe90::1]/v1",
  ])("默认拒绝私网、链路本地与云元数据地址:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).rejects.toThrow(/Blocked private/);
  });

  it.each([
    "http://2852039166/latest/meta-data",
    "http://0xa9fea9fe/latest/meta-data",
    "http://167772161/v1",
    "http://0x0a000001/v1",
  ])("拒绝十进制/十六进制 IPv4 基本绕过:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).rejects.toThrow(/Blocked private/);
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
  ])("允许显式 loopback 本地模型:%s", async (url) => {
    await expect(validateModelFetchUrl(url, {})).resolves.toBeInstanceOf(URL);
  });

  it("允许解析到公网地址的域名", async () => {
    const checked = await validateModelFetchUrl("https://api.deepseek.com/v1", {});
    expect(checked.hostname).toBe("api.deepseek.com");
    expect(lookupMock).toHaveBeenCalledWith("api.deepseek.com", { all: true, verbatim: true });
  });

  it("普通域名即使解析到 loopback 也拒绝", async () => {
    await expect(
      validateModelFetchUrl("https://loopback.example.com/v1", {}),
    ).rejects.toThrow(/Blocked loopback/);
  });

  it.each([
    "http://10.0.0.8/v1",
    "http://192.168.1.8/v1",
    "http://169.254.169.254/latest/meta-data",
    "http://[fc00::1]:8080/v1",
  ])("逃生舱 =1 时放行私网地址:%s", async (url) => {
    await expect(
      validateModelFetchUrl(url, { QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "1" }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("逃生舱只接受精确值 1", () => {
    expect(allowsPrivateModelHost({ QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "1" })).toBe(true);
    expect(allowsPrivateModelHost({ QINGAGENT_ALLOW_PRIVATE_MODEL_HOST: "true" })).toBe(false);
    expect(allowsPrivateModelHost({})).toBe(false);
  });

  it("公共抓取策略仍默认拒绝 loopback", async () => {
    await expect(validateFetchUrl("http://127.0.0.1:11434/v1")).rejects.toThrow(
      /Blocked loopback/,
    );
  });

  it("modelFetch 在建立连接前执行同一策略兜底", async () => {
    await expect(modelFetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /Blocked private/,
    );
  });

  it("modelFetch 在 DNS 预检期间服从原请求取消原因", async () => {
    lookupMock.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const reason = new DOMException("turn cancelled", "AbortError");
    const pending = modelFetch("https://slow-dns.example.com/v1", {
      signal: controller.signal,
    });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("modelFetch 的连接超时覆盖 DNS 预检等待:不允许私网时重试一次后仍严格阻断", async () => {
    vi.useFakeTimers();
    process.env.QINGAGENT_MODEL_CONNECT_TIMEOUT_MS = "25";
    lookupMock.mockReturnValue(new Promise(() => undefined));
    try {
      const pending = modelFetch("https://slow-dns.example.com/v1");
      const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(25 + retryBackoffMs() + 25);
      await rejection;
      // 瞬时故障重试一次:预检是辅助防线,不该被一次慢解析一票否决。
      expect(lookupMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("允许私网时预检超时降级为尽力而为,请求继续走连接层的同一套策略", async () => {
    vi.useFakeTimers();
    process.env.QINGAGENT_ALLOW_PRIVATE_MODEL_HOST = "1";
    process.env.QINGAGENT_MODEL_CONNECT_TIMEOUT_MS = "25";
    lookupMock.mockReturnValue(new Promise(() => undefined));
    try {
      let caught: unknown;
      const pending = modelFetch("https://slow-dns.example.com/v1").catch((error) => {
        caught = error;
      });
      await vi.advanceTimersByTimeAsync(25 + retryBackoffMs() + 25);
      await pending;
      // 没有卡在预检超时上:失败来自真正的连接层 DNS(仍受同一策略校验)。
      expect(errorMessages(caught).join("\n")).toContain("unexpected connection lookup");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.8/internal",
  ])("modelFetch 拒绝公网首跳重定向到私网且不建立第二跳连接:%s", async (target) => {
    const firstHop = createServer((_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });
    const firstUrl = await listen(firstHop);

    let caught: unknown;
    try {
      await modelFetch(`${firstUrl}/models`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeTruthy();
    expect(errorMessages(caught).join("\n")).toMatch(/Blocked private/);
  });

  it("连接层 DNS 固定器拒绝预检公网、实际建连解析私网的 rebinding", async () => {
    connectionLookupMock.mockImplementationOnce(
      (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(null, [{ address: "10.0.0.9", family: 4 }]);
      },
    );

    let caught: unknown;
    try {
      await modelFetch("http://rebind.example.com:18080/models");
    } catch (error) {
      caught = error;
    }
    expect(lookupMock).toHaveBeenCalledWith(
      "rebind.example.com",
      { all: true, verbatim: true },
    );
    expect(connectionLookupMock).toHaveBeenCalledWith(
      "rebind.example.com",
      { all: true, verbatim: true },
      expect.any(Function),
    );
    expect(errorMessages(caught).join("\n")).toMatch(/Blocked private/);
  });

  it("正常多跳重定向可达，跨 origin 自动剥离 Authorization", async () => {
    let receivedAuthorization: string | undefined;
    const lastHop = createServer((req, res) => {
      receivedAuthorization = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    const lastUrl = await listen(lastHop);
    const firstHop = createServer((req, res) => {
      if (req.url === "/first") {
        res.writeHead(302, { Location: "/second" });
      } else {
        res.writeHead(307, { Location: `${lastUrl}/final` });
      }
      res.end();
    });
    const firstUrl = await listen(firstHop);

    const response = await modelFetch(`${firstUrl}/first`, {
      headers: { Authorization: "Bearer must-not-leak" },
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(receivedAuthorization).toBeUndefined();
  });

  it("全部解析为公网 IP 的代理多跳可达，且 CONNECT 目标固定为 IP", async () => {
    const connectTargets: string[] = [];
    let receivedAuthorization: string | undefined;
    const proxy = createServer();
    proxy.on("connect", (connectRequest, socket, head) => {
      connectTargets.push(connectRequest.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let pending = Buffer.from(head);
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const headerEnd = pending.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        socket.removeListener("data", onData);
        const lines = pending.subarray(0, headerEnd).toString("latin1").split("\r\n");
        const path = lines[0]?.split(" ")[1] ?? "/";
        const headers = Object.fromEntries(lines.slice(1).flatMap((line) => {
          const colon = line.indexOf(":");
          return colon < 0 ? [] : [[line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]];
        }));
        receivedAuthorization = headers.authorization;
        let response: string;
        if (path === "/first") {
          response =
            "HTTP/1.1 302 Found\r\nLocation: http://public-one.example:18080/second\r\n" +
            "Content-Length: 0\r\nConnection: close\r\n\r\n";
        } else if (path === "/second") {
          response =
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://public-two.example:18081/final\r\n" +
            "Content-Length: 0\r\nConnection: close\r\n\r\n";
        } else {
          response = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
        }
        socket.end(response);
      };
      socket.on("data", onData);
      if (head.length > 0) onData(Buffer.alloc(0));
    });
    const proxyUrl = await listen(proxy);
    process.env.http_proxy = proxyUrl;
    delete process.env.no_proxy;

    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === "public-one.example" || hostname === "public-two.example") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      throw new Error(`unresolved ${hostname}`);
    });
    connectionLookupMock.mockImplementation(
      (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(null, [{ address: "93.184.216.34", family: 4 }]);
      },
    );

    const response = await modelFetch("http://public-one.example:18080/first", {
      headers: { Authorization: "Bearer must-not-leak" },
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(connectTargets).toEqual([
      "93.184.216.34:18080",
      "93.184.216.34:18080",
      "93.184.216.34:18081",
    ]);
    expect(connectTargets.join(" ")).not.toContain("public-");
    expect(receivedAuthorization).toBeUndefined();
  });
});
