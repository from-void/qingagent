import { describe, expect, it, afterEach, vi } from "vitest";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import {
  BrowserBridgeFilesystem,
  __browserFolderBridgeStatsForTest,
  __resetBrowserFolderBridgeForTest,
  isBrowserFolderSourceRegistered,
  openBrowserFolderBridgeConnection,
  registerBrowserFolderSource,
  requestBrowserFolderBridge,
  resolveBrowserFolderBridgeResponse,
  unregisterBrowserFolderSource,
} from "../workspace/browserBridgeFilesystem.js";

function makeSource(overrides: Partial<FolderSourceRecord> = {}): FolderSourceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "fld_browser",
    sessionId: "sess_browser",
    provider: "browser-fs-access",
    name: "Browser Docs",
    pathLabel: "Browser Docs",
    mountName: "source_browser",
    mountPath: "/sources/source_browser",
    readOnly: true,
    fileCount: null,
    fileCountCapped: false,
    status: "connected",
    error: null,
    createdAt: now,
    updatedAt: now,
    browserHandleKey: "handle-secret-ish",
    browserClientSourceId: "client-1",
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const savedAttachGrace = process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS;

describe("BrowserBridgeFilesystem", () => {
  afterEach(() => {
    if (savedAttachGrace === undefined) delete process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS;
    else process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS = savedAttachGrace;
    vi.useRealTimers();
    __resetBrowserFolderBridgeForTest();
  });

  it("通过桥发起 stat/readdir/readFile，并校验响应绑定", async () => {
    const source = makeSource();
    const filesystem = new BrowserBridgeFilesystem(source);
    const requests: Array<{
      requestId: string;
      sessionId: string;
      folderId: string;
      clientId: string;
      op: "stat" | "readdir" | "readFile";
      relPath: string;
    }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: source.sessionId,
      clientId: source.browserClientSourceId!,
      send: async (request) => {
        requests.push(request);
      },
    });

    const statPromise = filesystem.stat("/docs/a.md");
    await flushPromises();
    expect(requests[0]).toMatchObject({
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: source.browserClientSourceId,
      op: "stat",
      relPath: "docs/a.md",
    });
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "other-session",
      folderId: source.id,
      clientId: source.browserClientSourceId!,
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(false);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: source.browserClientSourceId!,
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(statPromise).resolves.toMatchObject({
      name: "a.md",
      path: "/sources/source_browser/docs/a.md",
      type: "file",
      size: 3,
    });

    const readPromise = filesystem.readFile("/docs/a.md");
    await flushPromises();
    expect(requests[1]).toMatchObject({ op: "readFile", relPath: "docs/a.md" });
    expect(resolveBrowserFolderBridgeResponse(requests[1]!.requestId, {
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: source.browserClientSourceId!,
      response: { ok: true, op: "readFile", bytes: new TextEncoder().encode("abc") },
    })).toBe(true);
    await expect(readPromise).resolves.toEqual(Buffer.from("abc"));

    close();
  });

  it("拒绝脏路径与写操作", async () => {
    const filesystem = new BrowserBridgeFilesystem(makeSource());
    const dirtyPaths = [
      "../secret.md",
      "/../secret.md",
      "/safe/../secret.md",
      "/safe//secret.md",
      "/safe\\secret.md",
      "/safe/\0secret.md",
      "C:/secret.md",
      "//server/share.md",
      "./safe.md",
    ];
    for (const path of dirtyPaths) {
      await expect(filesystem.stat(path)).rejects.toThrow(/invalid_path/);
    }
    for (const rootPath of ["", ".", "/"]) {
      await expect(filesystem.readFile(rootPath)).rejects.toThrow(/invalid_path/);
    }
    await expect(filesystem.writeFile("/a.md", "x")).rejects.toThrow(/read-only/);
    await expect(filesystem.deleteFile("/a.md")).rejects.toThrow(/read-only/);
    await expect(filesystem.mkdir("/new")).rejects.toThrow(/read-only/);
  });

  it("接受 CompositeFilesystem 委托的相对路径和根路径", async () => {
    const source = makeSource();
    const filesystem = new BrowserBridgeFilesystem(source);
    const requests: Array<{ requestId: string; op: string; relPath: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: source.sessionId,
      clientId: source.browserClientSourceId!,
      send: async (request) => {
        requests.push({ requestId: request.requestId, op: request.op, relPath: request.relPath });
      },
    });

    const statPromise = filesystem.stat("docs/a.md");
    await flushPromises();
    expect(requests[0]).toMatchObject({ op: "stat", relPath: "docs/a.md" });
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: source.browserClientSourceId!,
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "a.md",
          type: "file",
          size: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(statPromise).resolves.toMatchObject({ path: "/sources/source_browser/docs/a.md" });

    const rootPromise = filesystem.readdir("");
    await flushPromises();
    expect(requests[1]).toMatchObject({ op: "readdir", relPath: "" });
    expect(resolveBrowserFolderBridgeResponse(requests[1]!.requestId, {
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: source.browserClientSourceId!,
      response: { ok: true, op: "readdir", entries: [{ name: "docs", type: "directory" }] },
    })).toBe(true);
    await expect(rootPromise).resolves.toEqual([{ name: "docs", type: "directory" }]);
    close();
  });

  it("getInfo/getInstructions 不暴露 browser handle 或 client id", () => {
    const source = makeSource();
    const filesystem = new BrowserBridgeFilesystem(source);
    const text = JSON.stringify([filesystem.getInfo(), filesystem.getInstructions()]);
    expect(text).toContain(source.mountPath);
    expect(text).not.toContain(source.browserHandleKey);
    expect(text).not.toContain(source.browserClientSourceId);
  });

  it.each([
    ["not_found", "not_found"],
    ["permission_denied", "permission_denied"],
    ["too_large", "too_large"],
    ["unknown", "client_error"],
  ] as const)("客户端 reasonCode=%s 映射为安全类别 %s", async (reasonCode, expectedCode) => {
    const source = makeSource();
    const filesystem = new BrowserBridgeFilesystem(source);
    const requests: Array<{ requestId: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: source.sessionId,
      clientId: source.browserClientSourceId!,
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });
    try {
      const statPromise = filesystem.stat("/missing.md");
      await flushPromises();
      expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
        sessionId: source.sessionId,
        folderId: source.id,
        clientId: source.browserClientSourceId!,
        response: { ok: false, reasonCode },
      })).toBe(true);
      const error = await statPromise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "BrowserFolderBridgeError",
        code: expectedCode,
      });
    } finally {
      close();
    }
  });

  it("请求超时后同步清理 queuedRequests，晚到连接不接收过期请求", async () => {
    registerBrowserFolderSource("sess_timeout", "fld_timeout", "client_timeout");
    const closeSeen = openBrowserFolderBridgeConnection({
      sessionId: "sess_timeout",
      clientId: "client_timeout",
      send: async () => undefined,
    });
    closeSeen();
    const pending = requestBrowserFolderBridge(
      {
        sessionId: "sess_timeout",
        folderId: "fld_timeout",
        clientId: "client_timeout",
        op: "stat",
        relPath: "a.md",
      },
      5,
    );

    await expect(pending).rejects.toThrow(/timed out/);
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0 });

    const delivered: unknown[] = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_timeout",
      clientId: "client_timeout",
      send: async (request) => {
        delivered.push(request);
      },
    });
    await flushPromises();
    close();
    expect(delivered).toHaveLength(0);
  });

  it("调用方中止后同步清理 queuedRequests 与 pendingRequests", async () => {
    registerBrowserFolderSource("sess_abort", "fld_abort", "client_abort");
    const closeSeen = openBrowserFolderBridgeConnection({
      sessionId: "sess_abort",
      clientId: "client_abort",
      send: async () => undefined,
    });
    closeSeen();
    const controller = new AbortController();
    const pending = requestBrowserFolderBridge(
      {
        sessionId: "sess_abort",
        folderId: "fld_abort",
        clientId: "client_abort",
        op: "stat",
        relPath: "a.md",
      },
      30_000,
      3_000,
      controller.signal,
    );
    const rejected = pending.catch((error) => error);
    await flushPromises();
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 1, pending: 1 });

    controller.abort(new DOMException("caller aborted", "AbortError"));

    await expect(rejected).resolves.toMatchObject({ name: "AbortError" });
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0 });
  });

  it("从未建立 SSE 连接的 browser source 在短宽限到期后 bridge_offline，不排队等 30 秒", async () => {
    registerBrowserFolderSource("sess_never_connected", "fld_never_connected", "client_never_connected");

    const startedAt = Date.now();
    const error = await requestBrowserFolderBridge(
      {
        sessionId: "sess_never_connected",
        folderId: "fld_never_connected",
        clientId: "client_never_connected",
        op: "readdir",
        relPath: "",
      },
      30_000,
      50,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(500);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "BrowserFolderBridgeError", code: "bridge_offline" });
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0 });
  });

  it("未显式传第三参时默认首连宽限为 3 秒", async () => {
    delete process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS;
    vi.useFakeTimers();
    registerBrowserFolderSource("sess_default_grace", "fld_default_grace", "client_default_grace");

    const pending = requestBrowserFolderBridge({
      sessionId: "sess_default_grace",
      folderId: "fld_default_grace",
      clientId: "client_default_grace",
      op: "readdir",
      relPath: "",
    }, 30_000);
    const rejected = pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    await vi.advanceTimersByTimeAsync(2_999);
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 1, pending: 1 });

    await vi.advanceTimersByTimeAsync(1);
    await expect(rejected).resolves.toMatchObject({
      name: "BrowserFolderBridgeError",
      code: "bridge_offline",
    });
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0 });
  });

  it("从未建立 SSE 连接的 browser source 在宽限内连接后成功投递请求", async () => {
    registerBrowserFolderSource("sess_attach_race", "fld_attach_race", "client_attach_race");
    const requests: Array<{ requestId: string; op: string; relPath: string }> = [];

    const pending = requestBrowserFolderBridge(
      {
        sessionId: "sess_attach_race",
        folderId: "fld_attach_race",
        clientId: "client_attach_race",
        op: "readdir",
        relPath: "",
      },
      30_000,
      200,
    );
    await flushPromises();
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 1, pending: 1 });

    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_attach_race",
      clientId: "client_attach_race",
      send: async (request) => {
        requests.push({ requestId: request.requestId, op: request.op, relPath: request.relPath });
      },
    });
    await flushPromises();

    expect(requests).toEqual([{ requestId: expect.any(String), op: "readdir", relPath: "" }]);
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 1 });
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_attach_race",
      folderId: "fld_attach_race",
      clientId: "client_attach_race",
      response: { ok: true, op: "readdir", entries: [{ name: "ready.md", type: "file" }] },
    })).toBe(true);
    await expect(pending).resolves.toEqual({
      ok: true,
      op: "readdir",
      entries: [{ name: "ready.md", type: "file" }],
    });
    close();
  });

  it("unregister 后写入 tombstone，旧 source 不会被自动重注册或继续读", async () => {
    registerBrowserFolderSource("sess_detach", "fld_detach", "client_detach");
    const delivered: unknown[] = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_detach",
      clientId: "client_detach",
      send: async (request) => {
        delivered.push(request);
      },
    });

    unregisterBrowserFolderSource("sess_detach", "fld_detach");
    await expect(requestBrowserFolderBridge({
      sessionId: "sess_detach",
      folderId: "fld_detach",
      clientId: "client_detach",
      op: "stat",
      relPath: "leaked.md",
    })).rejects.toThrow(/detached/);
    await flushPromises();
    close();

    expect(delivered).toHaveLength(0);
    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0, sources: 0 });
  });

  it("伪造 clientId 的 unregister 不会摘掉当前 browser source", async () => {
    registerBrowserFolderSource("sess_forged", "fld_forged", "client_good");

    expect(unregisterBrowserFolderSource("sess_forged", "fld_forged", "client_evil")).toBe(false);
    expect(isBrowserFolderSourceRegistered("sess_forged", "fld_forged", "client_good")).toBe(true);

    const requests: Array<{ requestId: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_forged",
      clientId: "client_good",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_forged",
      folderId: "fld_forged",
      clientId: "client_good",
      op: "stat",
      relPath: "still-mounted.md",
    });
    await flushPromises();

    expect(requests).toHaveLength(1);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_forged",
      folderId: "fld_forged",
      clientId: "client_good",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "still-mounted.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    close();
  });

  it("source 可同时注册多个 client，旧 client 断开不会 tombstone 新绑定", async () => {
    registerBrowserFolderSource("sess_late", "fld_late", "client_old");
    registerBrowserFolderSource("sess_late", "fld_late", "client_new");

    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_old")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_new")).toBe(true);
    expect(unregisterBrowserFolderSource("sess_late", "fld_late", "client_old")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_old")).toBe(false);
    expect(isBrowserFolderSourceRegistered("sess_late", "fld_late", "client_new")).toBe(true);
    expect(unregisterBrowserFolderSource("sess_late", "fld_late", "client_old")).toBe(false);

    const requests: Array<{ requestId: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_late",
      clientId: "client_new",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_late",
      folderId: "fld_late",
      clientId: "client_new",
      op: "stat",
      relPath: "still-mounted.md",
    });
    await flushPromises();

    expect(requests).toHaveLength(1);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_late",
      folderId: "fld_late",
      clientId: "client_new",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "still-mounted.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    close();
  });

  it("同 source 一个 client unregister 后，旧 preferred 请求会路由到仍存活 client", async () => {
    registerBrowserFolderSource("sess_tabs", "fld_tabs", "client_a");
    registerBrowserFolderSource("sess_tabs", "fld_tabs", "client_b");
    const requests: Array<{ requestId: string; clientId: string }> = [];
    const closeB = openBrowserFolderBridgeConnection({
      sessionId: "sess_tabs",
      clientId: "client_b",
      send: async (request) => {
        requests.push({ requestId: request.requestId, clientId: request.clientId });
      },
    });

    expect(unregisterBrowserFolderSource("sess_tabs", "fld_tabs", "client_a")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_tabs", "fld_tabs", "client_b")).toBe(true);
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_tabs",
      folderId: "fld_tabs",
      clientId: "client_a",
      op: "stat",
      relPath: "still-mounted.md",
    });
    await flushPromises();

    expect(requests).toEqual([{ requestId: expect.any(String), clientId: "client_b" }]);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_tabs",
      folderId: "fld_tabs",
      clientId: "client_b",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "still-mounted.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    closeB();
  });

  it("同 source 同 clientId 的多标签 unregister 一次后仍保持注册", async () => {
    registerBrowserFolderSource("sess_same_client", "fld_same_client", "client_shared");
    registerBrowserFolderSource("sess_same_client", "fld_same_client", "client_shared");
    expect(isBrowserFolderSourceRegistered("sess_same_client", "fld_same_client", "client_shared")).toBe(true);

    expect(unregisterBrowserFolderSource("sess_same_client", "fld_same_client", "client_shared")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_same_client", "fld_same_client", "client_shared")).toBe(true);

    const requests: Array<{ requestId: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_same_client",
      clientId: "client_shared",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_same_client",
      folderId: "fld_same_client",
      clientId: "client_shared",
      op: "stat",
      relPath: "still-mounted.md",
    });
    await flushPromises();

    expect(requests).toHaveLength(1);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_same_client",
      folderId: "fld_same_client",
      clientId: "client_shared",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "still-mounted.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    close();

    expect(unregisterBrowserFolderSource("sess_same_client", "fld_same_client", "client_shared")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_same_client", "fld_same_client", "client_shared")).toBe(false);
  });

  it("同 clientId 仍有其他 SSE 连接时 unregister 不移除 source 绑定", async () => {
    registerBrowserFolderSource("sess_same_conn", "fld_same_conn", "client_shared");
    const requests: Array<{ requestId: string }> = [];
    const closeA = openBrowserFolderBridgeConnection({
      sessionId: "sess_same_conn",
      clientId: "client_shared",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });
    const closeB = openBrowserFolderBridgeConnection({
      sessionId: "sess_same_conn",
      clientId: "client_shared",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
      },
    });

    expect(unregisterBrowserFolderSource("sess_same_conn", "fld_same_conn", "client_shared")).toBe(true);
    expect(isBrowserFolderSourceRegistered("sess_same_conn", "fld_same_conn", "client_shared")).toBe(true);
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_same_conn",
      folderId: "fld_same_conn",
      clientId: "client_shared",
      op: "stat",
      relPath: "still-open.md",
    });
    await flushPromises();

    expect(requests).toHaveLength(1);
    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_same_conn",
      folderId: "fld_same_conn",
      clientId: "client_shared",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "still-open.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    closeA();
    closeB();
  });

  it("承载请求的 SSE 断开后由同 clientId 的可用连接幂等接管", async () => {
    registerBrowserFolderSource("sess_handoff", "fld_handoff", "client_handoff");
    const firstDeliveries: string[] = [];
    const secondDeliveries: string[] = [];
    const closeFirst = openBrowserFolderBridgeConnection({
      sessionId: "sess_handoff",
      clientId: "client_handoff",
      send: async (request) => {
        firstDeliveries.push(request.requestId);
      },
    });
    const closeSecond = openBrowserFolderBridgeConnection({
      sessionId: "sess_handoff",
      clientId: "client_handoff",
      send: async (request) => {
        secondDeliveries.push(request.requestId);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_handoff",
      folderId: "fld_handoff",
      clientId: "client_handoff",
      op: "stat",
      relPath: "handoff.md",
    });
    await flushPromises();

    expect(firstDeliveries).toHaveLength(1);
    expect(secondDeliveries).toHaveLength(0);
    closeFirst();
    await flushPromises();

    expect(secondDeliveries).toEqual(firstDeliveries);
    expect(resolveBrowserFolderBridgeResponse(secondDeliveries[0]!, {
      sessionId: "sess_handoff",
      folderId: "fld_handoff",
      clientId: "client_handoff",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "handoff.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    closeSecond();
  });

  it("已投递请求的最后一条 SSE 断开时立即按离线结算", async () => {
    registerBrowserFolderSource("sess_disconnect", "fld_disconnect", "client_disconnect");
    const deliveries: string[] = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_disconnect",
      clientId: "client_disconnect",
      send: async (request) => {
        deliveries.push(request.requestId);
      },
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_disconnect",
      folderId: "fld_disconnect",
      clientId: "client_disconnect",
      op: "readFile",
      relPath: "disconnect.md",
    });
    const settled = pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    await flushPromises();
    expect(deliveries).toHaveLength(1);

    close();

    expect(__browserFolderBridgeStatsForTest()).toMatchObject({ queued: 0, pending: 0 });
    await expect(settled).resolves.toMatchObject({
      name: "BrowserFolderBridgeError",
      code: "bridge_offline",
    });
  });

  it("慢 flush 与快速重连不会重复投递同一 requestId", async () => {
    registerBrowserFolderSource("sess_flush", "fld_flush", "client_flush");
    const closeSeen = openBrowserFolderBridgeConnection({
      sessionId: "sess_flush",
      clientId: "client_flush",
      send: async () => undefined,
    });
    closeSeen();
    const deliveries: string[] = [];
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const pending = requestBrowserFolderBridge({
      sessionId: "sess_flush",
      folderId: "fld_flush",
      clientId: "client_flush",
      op: "stat",
      relPath: "queued.md",
    });
    await flushPromises();

    const closeSlow = openBrowserFolderBridgeConnection({
      sessionId: "sess_flush",
      clientId: "client_flush",
      send: async (request) => {
        deliveries.push(request.requestId);
        await sendGate;
      },
    });
    await flushPromises();
    const closeReconnect = openBrowserFolderBridgeConnection({
      sessionId: "sess_flush",
      clientId: "client_flush",
      send: async (request) => {
        deliveries.push(request.requestId);
      },
    });
    await flushPromises();

    expect(deliveries).toHaveLength(1);
    releaseSend();
    await flushPromises();
    expect(resolveBrowserFolderBridgeResponse(deliveries[0]!, {
      sessionId: "sess_flush",
      folderId: "fld_flush",
      clientId: "client_flush",
      response: {
        ok: true,
        op: "stat",
        stat: {
          name: "queued.md",
          type: "file",
          size: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          modifiedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, op: "stat" });
    closeSlow();
    closeReconnect();
  });

  it("readFile 响应超过 request.maxBytes 时拒绝 pending", async () => {
    registerBrowserFolderSource("sess_bytes", "fld_bytes", "client_bytes");
    const requests: Array<{ requestId: string }> = [];
    const close = openBrowserFolderBridgeConnection({
      sessionId: "sess_bytes",
      clientId: "client_bytes",
      send: async (request) => {
        requests.push({ requestId: request.requestId });
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

    expect(resolveBrowserFolderBridgeResponse(requests[0]!.requestId, {
      sessionId: "sess_bytes",
      folderId: "fld_bytes",
      clientId: "client_bytes",
      response: { ok: true, op: "readFile", bytes: new TextEncoder().encode("12345678") },
    })).toBe(true);
    await expect(pending).rejects.toThrow(/maxBytes/);
    close();
  });
});
