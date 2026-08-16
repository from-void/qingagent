import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import {
  ATTACH_MODEL_OVERRIDE_HEADERS,
  DESKTOP_ATTACH_CAPABILITIES,
  type AttachHandshakeResponse,
} from "@qingagent/contract-ts";
import type { DiscoveredInstance } from "./attachDiscoveryTypes.js";
import {
  AttachConnectionError,
  AttachBackendConnection,
  EmbeddedBackendConnection,
  handshakeAttachInstance,
  resolveQingjianDeepLink,
  type BackendConnection,
} from "./backendConnection.js";
import { createDesktopDataProtocolHandler, DESKTOP_DATA_ORIGIN } from "./desktopDataProtocol.js";

const servers: Server[] = [];

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

after(async () => {
  await Promise.all(servers.map(closeServer));
});

const instance: DiscoveredInstance = {
  schemaVersion: 2,
  port: 52341,
  pid: 3210,
  version: "0.1.4",
  attachProtocolVersion: 1,
  instanceId: "00000000-0000-4000-8000-000000000011",
  libraryId: "00000000-0000-4000-8000-000000000012",
  token: `qa_instance_${"a".repeat(64)}`,
  startedAt: "2026-01-01T00:00:00.000Z",
  endpoint: "http://127.0.0.1:52341",
  source: "local",
};

function handshake(): AttachHandshakeResponse {
  const now = Date.now();
  return {
    ...instance,
    attachSessionToken: `qa_attach_${"b".repeat(64)}`,
    absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1_000).toISOString(),
    idleExpiresAt: new Date(now + 2 * 60 * 60 * 1_000).toISOString(),
    serverCapabilities: { ...DESKTOP_ATTACH_CAPABILITIES },
    effectiveCapabilities: { ...DESKTOP_ATTACH_CAPABILITIES },
  };
}

test("握手只在主进程携带 instance token，并校验完整身份/能力", async () => {
  let captured: RequestInit | undefined;
  const result = await handshakeAttachInstance(instance, (async (input, init) => {
    assert.equal(String(input), `${instance.endpoint}/api/v1/attach/handshake`);
    captured = init;
    return Response.json(handshake());
  }) as typeof fetch);

  assert.equal(new Headers(captured?.headers).get("authorization"), `Bearer ${instance.token}`);
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    desktopCapabilities: DESKTOP_ATTACH_CAPABILITIES,
  });
  assert.equal(result.libraryId, instance.libraryId);
});

test("renderer 请求经 data 代理后剥除全部凭据头，attach token 仅由主进程注入", async () => {
  let capturedHeaders: IncomingMessage["headers"] | undefined;
  const { port } = await startServer((request, response) => {
    capturedHeaders = request.headers;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  const target = { ...instance, port, endpoint: `http://127.0.0.1:${port}` };
  const connection = new AttachBackendConnection(target, { ...handshake(), port });
  const handler = createDesktopDataProtocolHandler(connection);
  const headers = new Headers({
    Origin: "qingagent://app",
    Authorization: "Bearer renderer-must-not-pass",
    Cookie: "renderer-secret=1",
    "X-Safe-Header": "preserved",
  });
  for (const [index, name] of ATTACH_MODEL_OVERRIDE_HEADERS.entries()) {
    headers.set(name, `renderer-model-secret-${index}`);
  }

  const response = await handler(new Request(`${DESKTOP_DATA_ORIGIN}/api/v1/home`, { headers }));
  assert.equal(response.status, 200);
  assert.equal(capturedHeaders?.authorization, `Bearer ${handshake().attachSessionToken}`);
  assert.equal(capturedHeaders?.cookie, undefined);
  for (const name of ATTACH_MODEL_OVERRIDE_HEADERS) {
    assert.equal(capturedHeaders?.[name], undefined, name);
  }
  assert.equal(capturedHeaders?.["x-safe-header"], "preserved");
  assert.equal(capturedHeaders?.origin, target.endpoint);
  assert.doesNotMatch(JSON.stringify(connection.snapshot()), /qa_(?:attach|instance)_/);
  connection.dispose();
});

test("embedded 代理保持原请求等价，仅在 command/external 路径覆写既有认证", async () => {
  const seen: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage["headers"];
    body: string;
  }> = [];
  const { port } = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const embedded = new EmbeddedBackendConnection({
    ...instance,
    port,
    commandAuthToken: "command-secret",
    externalAuthToken: "external-secret",
  });
  const commonHeaders = {
    Authorization: "Bearer renderer-global",
    Cookie: "renderer-cookie=1",
    "X-Model-Key": "renderer-model-key",
    "X-Custom": "preserved",
  };
  await (await embedded.forwardDataRequest(new Request(
    "qingagent-data://library/api/v1/settings/model?view=full",
    { method: "POST", headers: commonHeaders, body: "payload" },
  ))).arrayBuffer();
  await (await embedded.forwardDataRequest(new Request(
    "qingagent-data://library/api/v1/commands",
    { method: "POST", headers: commonHeaders, body: "{}" },
  ))).arrayBuffer();
  await (await embedded.forwardDataRequest(new Request(
    "qingagent-data://library/api/v1/external/health",
    { headers: commonHeaders },
  ))).arrayBuffer();

  assert.deepEqual(seen.map(({ method, url, body }) => ({ method, url, body })), [
    { method: "POST", url: "/api/v1/settings/model?view=full", body: "payload" },
    { method: "POST", url: "/api/v1/commands", body: "{}" },
    { method: "GET", url: "/api/v1/external/health", body: "" },
  ]);
  assert.equal(seen[0]?.headers.authorization, "Bearer renderer-global");
  assert.equal(seen[0]?.headers.cookie, "renderer-cookie=1");
  assert.equal(seen[0]?.headers["x-model-key"], "renderer-model-key");
  assert.equal(seen[0]?.headers["x-custom"], "preserved");
  assert.equal(seen[1]?.headers.authorization, "Bearer command-secret");
  assert.equal(seen[2]?.headers.authorization, "Bearer external-secret");
  embedded.dispose();
});

test("业务 5xx 原样透传且不触发连接状态机", async () => {
  const { port } = await startServer((_request, response) => {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "BUSINESS_BUSY" } }));
  });
  const target = { ...instance, port, endpoint: `http://127.0.0.1:${port}` };
  const connection = new AttachBackendConnection(target, { ...handshake(), port });
  const response = await connection.forwardDataRequest(
    new Request("qingagent-data://library/api/v1/home"),
  );
  assert.equal(response.status, 503);
  assert.equal(connection.snapshot().status, "attached");
  connection.dispose();
});

test("并发 ATTACH_SESSION_EXPIRED 只单飞重握手", async () => {
  let handshakeCount = 0;
  let target!: DiscoveredInstance;
  const { port } = await startServer((request, response) => {
    if (request.url === "/api/v1/attach/handshake") {
      handshakeCount += 1;
      request.resume();
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ...handshake(), port }));
      }, 25);
      return;
    }
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "ATTACH_SESSION_EXPIRED" } }));
  });
  target = { ...instance, port, endpoint: `http://127.0.0.1:${port}` };
  const connection = new AttachBackendConnection(target, { ...handshake(), port });
  const [first, second] = await Promise.all([
    connection.forwardDataRequest(new Request("qingagent-data://library/api/v1/home")),
    connection.forwardDataRequest(new Request("qingagent-data://library/api/v1/history")),
  ]);
  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(handshakeCount, 1);
  assert.equal(connection.snapshot().status, "attached");
  assert.equal(connection.snapshot().generation, 0);
  connection.dispose();
});

test("dead 后旧续期 timer 不能复活连接或发起握手", async () => {
  let handshakeCount = 0;
  const { port } = await startServer((request, response) => {
    if (request.url === "/api/v1/attach/handshake") handshakeCount += 1;
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "INSTANCE_AUTH_FAILED" } }));
  });
  const target = { ...instance, port, endpoint: `http://127.0.0.1:${port}` };
  const expiring = {
    ...handshake(),
    port,
    absoluteExpiresAt: new Date(Date.now() + 5 * 60 * 1_000 + 10).toISOString(),
  };
  const connection = new AttachBackendConnection(target, expiring);
  const response = await connection.forwardDataRequest(
    new Request("qingagent-data://library/api/v1/home"),
  );
  assert.equal(response.status, 401);
  assert.equal(connection.snapshot().status, "dead");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(connection.snapshot().status, "dead");
  assert.equal(handshakeCount, 0);
  connection.dispose();
});

test("绝对 TTL 预续期静默完成，不把活跃写请求暴露为 reauthenticating", async () => {
  let handshakeCount = 0;
  const { port } = await startServer((request, response) => {
    if (request.url !== "/api/v1/attach/handshake") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    handshakeCount += 1;
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ...handshake(),
        port,
        absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
      }));
    }, 40);
  });
  const target = { ...instance, port, endpoint: `http://127.0.0.1:${port}` };
  const expiring = {
    ...handshake(),
    port,
    absoluteExpiresAt: new Date(Date.now() + 5 * 60 * 1_000 + 10).toISOString(),
  };
  const connection = new AttachBackendConnection(target, expiring);
  const statuses: string[] = [];
  const detach = connection.subscribe((snapshot) => statuses.push(snapshot.status));
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.equal(handshakeCount, 1);
  assert.equal(connection.snapshot().status, "attached");
  assert.equal(statuses.includes("reauthenticating"), false);
  detach();
  connection.dispose();
});

test("must-enable 任一关闭都进入 INCOMPATIBLE", async () => {
  const payload = handshake();
  payload.effectiveCapabilities = { ...payload.effectiveCapabilities, assets: false };
  await assert.rejects(
    handshakeAttachInstance(instance, (async () => Response.json(payload)) as typeof fetch),
    (error: unknown) => error instanceof AttachConnectionError && error.code === "INCOMPATIBLE",
  );
});

test("深链在 embedded/attach 均由最终 BackendConnection 解析", async () => {
  const modes = ["embedded", "attach"] as const;
  for (const mode of modes) {
    const seen: string[] = [];
    const backend = {
      mode,
      resolveQingjianSession: async (engineSessionId: string) => {
        seen.push(engineSessionId);
        return mode === "embedded" ? "found" as const : "not-found" as const;
      },
    } satisfies Pick<BackendConnection, "mode" | "resolveQingjianSession">;
    const result = await resolveQingjianDeepLink(
      backend,
      "00000000-0000-4000-8000-000000000099",
    );
    assert.equal(result.mode, mode);
    assert.deepEqual(seen, ["00000000-0000-4000-8000-000000000099"]);
    assert.equal(result.result, mode === "embedded" ? "found" : "not-found");
  }
});
