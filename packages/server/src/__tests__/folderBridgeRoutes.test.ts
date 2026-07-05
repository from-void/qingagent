import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetBrowserFolderBridgeForTest,
  isBrowserFolderSourceRegistered,
  openBrowserFolderBridgeConnection,
  registerBrowserFolderSource,
  requestBrowserFolderBridge,
  unregisterBrowserFolderSource,
} from "@qingagent/core";
import { folderBridgeRoutes } from "../routes/folderBridge";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", folderBridgeRoutes);
  return app;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("folderBridgeRoutes", () => {
  afterEach(() => {
    delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
    __resetBrowserFolderBridgeForTest();
  });

  it("flag 关闭时拒绝 browser bridge 写入口", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/folder-bridge/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "sess", folderId: "fld", clientId: "client" }),
    });
    expect(res.status).toBe(403);
  });

  it("events 与 responses 都拒绝不受信 Origin", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    registerBrowserFolderSource("sess_origin", "fld_origin", "client_origin");

    const events = await app.request(
      "/api/v1/folder-bridge/events?sessionId=sess_origin&clientId=client_origin",
      {
        method: "GET",
        headers: {
          Origin: "https://evil.example",
          Host: "127.0.0.1:8080",
        },
      },
    );
    expect(events.status).toBe(403);

    const response = await app.request("/api/v1/folder-bridge/responses/req_origin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        Host: "127.0.0.1:8080",
      },
      body: JSON.stringify({
        sessionId: "sess_origin",
        folderId: "fld_origin",
        clientId: "client_origin",
        ok: false,
        error: "blocked",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("response 必须绑定 requestId/sessionId/folderId/clientId", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    const requests: Array<{ requestId: string }> = [];
    registerBrowserFolderSource("sess", "fld", "client");
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess",
      clientId: "client",
      send: async (request) => {
        requests.push(request);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess",
      folderId: "fld",
      clientId: "client",
      op: "stat",
      relPath: "a.md",
    });
    await flushPromises();
    const requestId = requests[0]!.requestId;

    const mismatch = await app.request(`/api/v1/folder-bridge/responses/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess",
        folderId: "fld",
        clientId: "other-client",
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(mismatch.status).toBe(404);

    const ok = await app.request(`/api/v1/folder-bridge/responses/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess",
        folderId: "fld",
        clientId: "client",
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    expect(ok.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    close();
  });

  it("response 必须来自仍注册在该 session/folder 下的 client", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    const requests: Array<{ requestId: string }> = [];
    registerBrowserFolderSource("sess", "fld", "client");
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess",
      clientId: "client",
      send: async (request) => {
        requests.push(request);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess",
      folderId: "fld",
      clientId: "client",
      op: "stat",
      relPath: "a.md",
    });
    const rejected = pending.catch((error) => error);
    await flushPromises();
    const requestId = requests[0]!.requestId;

    unregisterBrowserFolderSource("sess", "fld");
    const late = await app.request(`/api/v1/folder-bridge/responses/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess",
        folderId: "fld",
        clientId: "client",
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });

    expect(late.status).toBe(404);
    await expect(rejected).resolves.toMatchObject({ message: expect.stringContaining("detached") });
    close();
  });

  it("unregister 必须匹配当前 client 绑定，伪造 client 不会摘掉真实 source", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    registerBrowserFolderSource("sess_forged", "fld_forged", "client_good");

    const forged = await app.request("/api/v1/folder-bridge/unregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_forged",
        folderId: "fld_forged",
        clientId: "client_evil",
      }),
    });

    expect(forged.status).toBe(409);
    expect(isBrowserFolderSourceRegistered("sess_forged", "fld_forged", "client_good")).toBe(true);
  });

  it("多 client 并存时，旧 client unregister 只移除自身且不 tombstone 新 client", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();

    const oldRegister = await app.request("/api/v1/folder-bridge/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_late",
        folderId: "fld_late",
        clientId: "client_old",
      }),
    });
    const newRegister = await app.request("/api/v1/folder-bridge/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_late",
        folderId: "fld_late",
        clientId: "client_new",
      }),
    });

    expect(oldRegister.status).toBe(200);
    expect(newRegister.status).toBe(200);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_old")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_new")).toBe(true);

    const oldUnregister = await app.request("/api/v1/folder-bridge/unregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_late",
        folderId: "fld_late",
        clientId: "client_old",
      }),
    });

    expect(oldUnregister.status).toBe(200);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_old")).toBe(false);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_new")).toBe(true);

    const staleOldUnregister = await app.request("/api/v1/folder-bridge/unregister", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess_late",
        folderId: "fld_late",
        clientId: "client_old",
      }),
    });

    expect(staleOldUnregister.status).toBe(409);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_new")).toBe(true);
  });

  it("readFile 支持二进制响应体且仍校验绑定 header", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    const requests: Array<{ requestId: string }> = [];
    registerBrowserFolderSource("sess", "fld", "client");
    openBrowserFolderBridgeConnection({
      sessionId: "sess",
      clientId: "client",
      send: async (request) => {
        requests.push(request);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess",
      folderId: "fld",
      clientId: "client",
      op: "readFile",
      relPath: "a.md",
    });
    await flushPromises();
    const requestId = requests[0]!.requestId;

    const bad = await app.request(`/api/v1/folder-bridge/responses/${requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-qingagent-session-id": "sess",
        "x-qingagent-folder-id": "fld",
        "x-qingagent-client-id": "other-client",
        "x-qingagent-folder-op": "readFile",
      },
      body: new TextEncoder().encode("abc"),
    });
    expect(bad.status).toBe(404);

    const ok = await app.request(`/api/v1/folder-bridge/responses/${requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-qingagent-session-id": "sess",
        "x-qingagent-folder-id": "fld",
        "x-qingagent-client-id": "client",
        "x-qingagent-folder-op": "readFile",
      },
      body: new TextEncoder().encode("abc"),
    });
    expect(ok.status).toBe(200);
    const resolved = await pending;
    expect(resolved).toMatchObject({ ok: true, op: "readFile" });
    if (resolved.op === "readFile") {
      expect(new TextDecoder().decode(resolved.bytes)).toBe("abc");
    }
  });

  it("readFile 二进制响应超过 request.maxBytes 时返回 413 并拒绝 pending", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const app = makeApp();
    const requests: Array<{ requestId: string }> = [];
    registerBrowserFolderSource("sess_bytes", "fld_bytes", "client_bytes");
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_bytes",
      clientId: "client_bytes",
      send: async (request) => {
        requests.push(request);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_bytes",
      folderId: "fld_bytes",
      clientId: "client_bytes",
      op: "readFile",
      relPath: "oversize.bin",
      maxBytes: 4,
    });
    await flushPromises();

    const oversize = await app.request(`/api/v1/folder-bridge/responses/${requests[0]!.requestId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-qingagent-session-id": "sess_bytes",
        "x-qingagent-folder-id": "fld_bytes",
        "x-qingagent-client-id": "client_bytes",
        "x-qingagent-folder-op": "readFile",
      },
      body: new TextEncoder().encode("12345678"),
    });

    expect(oversize.status).toBe(413);
    await expect(oversize.json()).resolves.toMatchObject({
      error: expect.stringContaining("maxBytes"),
    });
    await expect(pending).rejects.toThrow("browser folder request failed");
    close();
  });
});
