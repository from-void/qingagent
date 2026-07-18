import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { RequestContext } from "@mastra/core/request-context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshottingQingagentModel } from "./modelConfig.js";
import { isRetryableModelError } from "./repairingModel.js";
import {
  modelFetch,
  resetModelTransportForTests,
} from "./modelTransport.js";

// 真实监听本机 TCP 并模拟 CONNECT 黑洞，按仓库约定归入 heavy 层。

const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
  "QINGAGENT_MODEL_CONNECT_TIMEOUT_MS",
] as const;

type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];

function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => undefined);
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 server 未监听 TCP");
  return `http://127.0.0.1:${address.port}`;
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object" && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return codes;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe.sequential("modelTransport 集成", () => {
  let savedEnv: Partial<Record<ProxyEnvKey, string>>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    savedEnv = {};
    for (const key of PROXY_ENV_KEYS) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    await resetModelTransportForTests();
  });

  afterEach(async () => {
    await resetModelTransportForTests();
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const key of PROXY_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function installBlackholeProxy(timeoutMs = 250): Promise<void> {
    const sockets = new Set<Socket>();
    const proxy = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // 接受 TCP 并读取 CONNECT，但永远不返回响应。
      socket.on("data", () => {});
    });
    await listen(proxy);
    cleanups.push(() => closeServer(proxy, sockets));
    const proxyUrl = serverUrl(proxy);
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.no_proxy = "";
    process.env.QINGAGENT_MODEL_CONNECT_TIMEOUT_MS = String(timeoutMs);
  }

  async function fetchBlackholeError(
    request: () => Promise<unknown> = () => modelFetch("https://93.184.216.34/v1/chat/completions"),
  ): Promise<{ error: unknown; elapsedMs: number }> {
    await installBlackholeProxy();
    const startedAt = performance.now();
    let caught: unknown;
    try {
      await request();
    } catch (error) {
      caught = error;
    }
    if (!caught) throw new Error("黑洞代理请求不应成功");
    return { error: caught, elapsedMs: performance.now() - startedAt };
  }

  function requestThroughMainModel(): Promise<unknown> {
    const requestContext = new RequestContext([["modelOverrides", {
      visitorApiKey: "sk-connect-timeout-test",
      // 使用公网字面 IP，避免 DNS 固定护栏把“不可解析的 .invalid”先判为连接失败，
      // 确保本用例真正抵达并覆盖 CONNECT 黑洞代理。
      baseUrl: "https://93.184.216.34/v1",
      modelIds: { flash: "test-model" },
      protocol: "openai",
    }]] as never) as RequestContext;
    return Promise.resolve(createSnapshottingQingagentModel(requestContext).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "连接超时探针" }] }],
    } as never));
  }

  it("生产主模型 provider 对 CONNECT 黑洞在 3s 内 fail-fast", async () => {
    const { error, elapsedMs } = await fetchBlackholeError(requestThroughMainModel);
    expect(error).toBeInstanceOf(Error);
    expect(errorCodes(error)).toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(elapsedMs).toBeLessThan(3_000);
  }, 4_000);

  it("正常请求保留完整响应，且慢 TTFB 不受连接超时影响", async () => {
    const sockets = new Set<Socket>();
    const origin = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => {
        setTimeout(() => {
          const body = "完整响应：TTFB 晚于 connect timeout";
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        }, 450);
      });
    });
    await listen(origin);
    cleanups.push(() => closeServer(origin, sockets));

    process.env.http_proxy = "http://127.0.0.1:1";
    process.env.https_proxy = "http://127.0.0.1:1";
    process.env.no_proxy = "127.0.0.1";
    process.env.QINGAGENT_MODEL_CONNECT_TIMEOUT_MS = "200";

    const response = await modelFetch(`${serverUrl(origin)}/slow-headers`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("完整响应：TTFB 晚于 connect timeout");
  }, 4_000);

  it("CONNECT 黑洞产生的真实错误可进入既有模型重试", async () => {
    const { error } = await fetchBlackholeError(requestThroughMainModel);
    expect(isRetryableModelError(error)).toBe(true);
  }, 4_000);
});
