import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { createDesktopAppProxyHandler } from "./desktopAppProtocol.js";
import {
  createNodeHttpProxyFetch,
  createUpstreamBodyStream,
} from "./desktopAppProxyFetch.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

/** 起一个真实回环 HTTP 服务,用真 socket 验证流式与取消,不依赖 Electron。 */
async function startServer(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function proxyTo(port: number) {
  return createDesktopAppProxyHandler(port, createNodeHttpProxyFetch(), "test-command-token");
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  assert.equal(done, false);
  return Buffer.from(value!).toString();
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

after(async () => {
  await Promise.all(servers.map(closeServer));
});

test("SSE 分块逐个透传,不等整条响应结束就能读到首帧", async () => {
  const firstChunkRead = deferred();
  const port = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("event: frame\ndata: {\"seq\":1}\n\n");
    // 只有当代理确实把首块吐给了调用方,服务端才会写第二块——整体缓冲的实现会在此死锁。
    void firstChunkRead.promise.then(() => {
      res.write("event: frame\ndata: {\"seq\":2}\n\n");
      res.end();
    });
  });

  const response = await proxyTo(port)(
    new Request("qingagent://app/api/v1/events?sessionId=s1", {
      headers: { accept: "text/event-stream" },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  assert.equal(await readChunk(reader), "event: frame\ndata: {\"seq\":1}\n\n");
  firstChunkRead.resolve();
  assert.equal(await readChunk(reader), "event: frame\ndata: {\"seq\":2}\n\n");
  await reader.cancel();
});

test("渲染端取消响应体时上游连接立即关闭,不泄漏 SSE 连接", async () => {
  const serverClosed = deferred();
  const port = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    // 永不主动结束,只有客户端断开才会触发 close。
    req.on("close", () => {
      serverClosed.resolve();
    });
  });

  const response = await proxyTo(port)(new Request("qingagent://app/api/v1/events?sessionId=s1"));
  const reader = response.body!.getReader();
  assert.equal(await readChunk(reader), "data: hello\n\n");

  // Electron 在渲染端关闭 EventSource 时,正是通过销毁响应体流触发这里的 cancel。
  await reader.cancel();
  await serverClosed.promise;
});

test("上游仅发 close 而没有 end/error 时也会终止 renderer 可观测流", async () => {
  const response = new PassThrough();
  const upstream = { destroy() { return upstream; } } as unknown as Pick<
    import("node:http").ClientRequest,
    "destroy"
  >;
  const reader = createUpstreamBodyStream(
    upstream,
    response as unknown as IncomingMessage,
  ).getReader();

  response.write(Buffer.from("event: frame\ndata: {}\n\n"));
  assert.equal(await readChunk(reader), "event: frame\ndata: {}\n\n");
  // Windows/Electron 真机的连接淘汰可能只落到 IncomingMessage close；旧适配器只监听
  // end/error，会让 Web 流永久保持 open，直到 renderer 的 45s 半开看门狗兜底。
  response.destroy();

  await assert.rejects(
    reader.read(),
    /premature close|aborted/i,
  );
});

test("并发长连接不受单主机 6 连接上限约束,全部到达服务端", async () => {
  const target = 10;
  const allArrived = deferred();
  const open = new Set<number>();
  let accepted = 0;
  const port = await startServer((req, res) => {
    accepted += 1;
    open.add(accepted);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: open\n\n");
    if (open.size === target) allArrived.resolve();
    req.on("close", () => open.delete(accepted));
  });

  const handler = proxyTo(port);
  const readers = await Promise.all(
    Array.from({ length: target }, async (_value, index) => {
      const response = await handler(
        new Request(`qingagent://app/api/v1/events?sessionId=s${index}`),
      );
      const reader = response.body!.getReader();
      await readChunk(reader);
      return reader;
    }),
  );

  await allArrived.promise;
  assert.equal(open.size, target);
  await Promise.all(readers.map((reader) => reader.cancel()));
});

test("转发方法、路径、请求体,并按逐跳头规则清洗请求头", async () => {
  const seen = deferred<{ url: string; method: string; headers: IncomingMessage["headers"]; body: string }>();
  const port = await startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.resolve({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const response = await proxyTo(port)(
    new Request("qingagent://app/api/v1/commands?source=desktop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "gzip, br",
        te: "trailers",
        upgrade: "websocket",
      },
      body: JSON.stringify({ command: "write" }),
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });

  const request = await seen.promise;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/v1/commands?source=desktop");
  assert.equal(request.body, JSON.stringify({ command: "write" }));
  assert.equal(request.headers.origin, `http://127.0.0.1:${port}`);
  assert.equal(request.headers.authorization, "Bearer test-command-token");
  assert.equal(request.headers.host, `127.0.0.1:${port}`);
  // Node http 不解压,Chromium 自定义协议也不解码,必须强制 identity。
  assert.equal(request.headers["accept-encoding"], "identity");
  assert.equal(request.headers.te, undefined);
  assert.equal(request.headers.upgrade, undefined);
});

test("204 等无体状态码不构造响应体,响应头按逐跳规则清洗", async () => {
  const port = await startServer((_req, res) => {
    res.writeHead(204, { "x-trace": "abc", connection: "keep-alive" });
    res.end();
  });

  const response = await proxyTo(port)(new Request("qingagent://app/api/v1/settings"));

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get("x-trace"), "abc");
  assert.equal(response.headers.get("connection"), null);
});

test("上游连接失败时以拒绝上报,不伪造成功响应", async () => {
  const port = await startServer((_req, res) => res.end());
  await closeServer(servers[servers.length - 1]!);

  await assert.rejects(() => proxyTo(port)(new Request("qingagent://app/api/v1/home")));
});
