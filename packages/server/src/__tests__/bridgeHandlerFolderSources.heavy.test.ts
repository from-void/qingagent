import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeFrame, Command, FolderSourceRecord } from "@qingagent/contract-ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

async function collectFrames(gen: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const frames: BridgeFrame[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]);
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

async function loadBridge(overrides: {
  schedulePersist?: ReturnType<typeof vi.fn>;
  createSessionThread?: ReturnType<typeof vi.fn>;
  getQingagentSessionWorkspace?: ReturnType<typeof vi.fn>;
} = {}) {
  vi.resetModules();
  const schedulePersist = overrides.schedulePersist ?? vi.fn(async () => undefined);
  const createSessionThread = overrides.createSessionThread ?? vi.fn(async () => undefined);
  const getQingagentSessionWorkspace = overrides.getQingagentSessionWorkspace;
  const clearFolderSourceCache = vi.fn(async () => undefined);

  vi.doMock("@qingagent/core", async () => {
    const actual = await vi.importActual<typeof import("@qingagent/core")>("@qingagent/core");
    return {
      ...actual,
      schedulePersist,
      clearFolderSourceCache,
      createSessionThread,
      ...(getQingagentSessionWorkspace ? { getQingagentSessionWorkspace } : {}),
    };
  });
  vi.doMock("../lib/uploadStorage", () => ({
    UPLOAD_DIR: "/tmp/qingagent-test-uploads",
    isValidUploadId: vi.fn(() => true),
    isWithinUploadDir: vi.fn(() => true),
    deleteUploadedFile: vi.fn(async () => true),
  }));

  const bridge = await import("../gateway/bridgeHandler");
  return { bridge, schedulePersist, clearFolderSourceCache, createSessionThread };
}

async function createSession(bridge: typeof import("../gateway/bridgeHandler")) {
  const frames = await collectFrames(
    bridge.handleCommand({
      kind: "startSession",
      data: { mode: { kind: "new", data: { template: null } } },
    }),
  );
  const meta = frames.find((frame) => frame.kind === "sessionMeta");
  if (meta?.kind !== "sessionMeta") throw new Error("missing sessionMeta");
  const session = bridge.getSession(meta.data.sessionId);
  if (!session) throw new Error("missing session");
  return session;
}

function attachCommand(sessionId: string, token: string): Command {
  return {
    kind: "attachFolder",
    data: {
      sessionId,
      source: { provider: "desktop-local", selectionToken: token },
    },
  };
}

function browserAttachCommand(sessionId: string, clientId: string, name = "browser docs"): Command {
  return {
    kind: "attachFolder",
    data: {
      sessionId,
      source: {
        provider: "browser-fs-access",
        clientSourceId: clientId,
        name,
        browserHandleKey: `handle-${clientId}`,
      },
    },
  };
}

async function makeFolderBridgeApp(): Promise<Hono> {
  const { folderBridgeRoutes } = await import("../routes/folderBridge");
  const app = new Hono();
  app.route("/api/v1", folderBridgeRoutes);
  return app;
}

interface FolderRequestEvent {
  requestId: string;
  sessionId: string;
  folderId: string;
  clientId: string;
  op: "stat" | "readdir" | "readFile";
  relPath: string;
  maxBytes?: number;
}

async function openFolderBridgeEvents(app: Hono, sessionId: string, clientId: string): Promise<{
  readFolderRequest: () => Promise<FolderRequestEvent>;
  close: () => Promise<void>;
}> {
  const controller = new AbortController();
  const response = await app.request(
    `/api/v1/folder-bridge/events?sessionId=${encodeURIComponent(sessionId)}&clientId=${encodeURIComponent(clientId)}`,
    { method: "GET", signal: controller.signal },
  );
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing SSE body");
  const decoder = new TextDecoder();
  let buffer = "";

  const readEvent = async (eventName: string): Promise<string> => {
    while (true) {
      const { done, value } = await withTimeout(
        reader.read(),
        1_000,
        `timed out waiting for ${eventName}`,
      );
      if (done) throw new Error(`SSE closed before ${eventName}`);
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = raw.split("\n");
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        if (event === eventName) return data;
        boundary = buffer.indexOf("\n\n");
      }
    }
  };

  return {
    readFolderRequest: async () => JSON.parse(await readEvent("folder-request")) as FolderRequestEvent,
    close: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function respondReaddir(
  app: Hono,
  request: FolderRequestEvent,
  entries: Array<{ name: string; type: "file" | "directory"; size?: number }>,
): Promise<void> {
  const response = await app.request(`/api/v1/folder-bridge/responses/${encodeURIComponent(request.requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: request.sessionId,
      folderId: request.folderId,
      clientId: request.clientId,
      ok: true,
      op: "readdir",
      entries,
    }),
  });
  expect(response.status).toBe(200);
}

describe("handleCommand folder source commands", () => {
  const savedRuntime = process.env.QINGAGENT_RUNTIME;
  const savedFlag = process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
  const savedBrowserFlag = process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
  const savedAttachGrace = process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS;

  afterEach(async () => {
    if (savedRuntime === undefined) delete process.env.QINGAGENT_RUNTIME;
    else process.env.QINGAGENT_RUNTIME = savedRuntime;
    if (savedFlag === undefined) delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = savedFlag;
    if (savedBrowserFlag === undefined) delete process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES;
    else process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = savedBrowserFlag;
    if (savedAttachGrace === undefined) delete process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS;
    else process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS = savedAttachGrace;
    const registry = await import("../lib/desktopFolderSelection");
    registry.__resetDesktopFolderSelectionsForTest();
    const core = await import("@qingagent/core");
    core.__resetBrowserFolderBridgeForTest();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("flag 未开时 attach 返回 unsupported_environment 且不消费 token", async () => {
    delete process.env.QINGAGENT_RUNTIME;
    delete process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES;
    const { bridge } = await loadBridge();
    const session = await createSession(bridge);

    const frames = await collectFrames(bridge.handleCommand(attachCommand(session.sessionId, "token")));

    expect(frames).toEqual([
      {
        kind: "folderSourceOperationResult",
        data: { ok: false, op: "attach", reason: "unsupported_environment" },
      },
    ]);
  });

  it("attach/detach 持久化状态、失效 workspace，changed 帧不泄露真实路径", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge, schedulePersist, clearFolderSourceCache } = await loadBridge();
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-"));
    writeFileSync(join(root, "a.md"), "a");
    const registry = await import("../lib/desktopFolderSelection");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: root,
      name: "docs",
      pathLabel: root,
      fileCount: 1,
    });

    const attachFrames = await collectFrames(
      bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)),
    );
    const changed = attachFrames.find((frame) => frame.kind === "folderSourcesChanged");
    const ok = attachFrames.find((frame) => frame.kind === "folderSourceOperationResult");
    expect(ok?.kind === "folderSourceOperationResult" && ok.data.ok).toBe(true);
    expect(changed?.kind).toBe("folderSourcesChanged");
    expect(JSON.stringify(changed)).not.toContain("desktopRootPath");
    expect(JSON.stringify(changed)).not.toContain(root);
    expect(changed?.kind === "folderSourcesChanged" && changed.data.sources[0]?.pathLabel).toContain("bridge-folder-");
    expect(session.folderSources.size).toBe(1);
    const folderId = Array.from(session.folderSources.keys())[0]!;
    expect(session.folderSources.get(folderId)?.desktopRootPath).toBe(root);
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:attachFolder");

    const detachFrames = await collectFrames(
      bridge.handleCommand({
        kind: "detachFolder",
        data: { sessionId: session.sessionId, folderId },
      }),
    );

    expect(detachFrames).toContainEqual({
      kind: "folderSourceOperationResult",
      data: { ok: true, op: "detach", folderId },
    });
    expect(detachFrames).toContainEqual({
      kind: "folderSourcesChanged",
      data: { sessionId: session.sessionId, sources: [] },
    });
    expect(clearFolderSourceCache).toHaveBeenCalledWith(session.sessionId, folderId);
    expect(session.folderSources.size).toBe(0);
  });

  it("attach 后后台递归统计 fileCount，排除隐藏文件并推送 folderSourcesChanged", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-count-"));
    try {
      mkdirSync(join(root, "nested"));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "visible.md"), "a");
      writeFileSync(join(root, "nested", "visible.txt"), "b");
      writeFileSync(join(root, ".hidden.md"), "hidden");
      writeFileSync(join(root, "nested", ".hidden.txt"), "hidden");
      writeFileSync(join(root, ".git", "ignored"), "ignored");
      writeFileSync(join(root, "node_modules", "ignored.js"), "ignored");
      const registry = await import("../lib/desktopFolderSelection");
      const core = await import("@qingagent/core");
      const selection = registry.registerDesktopFolderSelection({
        webContentsId: 1,
        rootPath: root,
        name: "docs",
        pathLabel: root,
        fileCount: 99,
      });

      await collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)));
      const folderId = Array.from(session.folderSources.keys())[0]!;

      await waitForAssertion(() => {
        expect(session.folderSources.get(folderId)).toMatchObject({
          fileCount: 2,
          fileCountCapped: false,
        });
        expect(core.getSessionFolderSources(session.sessionId)[0]).toMatchObject({
          fileCount: 2,
          fileCountCapped: false,
        });
        const pushed = bridge.sessionManager.frameLog
          .readFrom(session.sessionId, 0)
          .frames
          .map((entry) => entry.frame)
          .filter((frame): frame is Extract<BridgeFrame, { kind: "folderSourcesChanged" }> =>
            frame.kind === "folderSourcesChanged",
          );
        expect(pushed.some((frame) => frame.data.sources[0]?.fileCount === 2)).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("browser bridge SSE 连接建立后自动触发 fileCount refresh", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    const { bridge } = await loadBridge();
    const app = await makeFolderBridgeApp();
    const session = await createSession(bridge);
    const clientId = "client_auto_count";
    const folderId = "fld_auto_count";
    const now = new Date().toISOString();
    const source: FolderSourceRecord = {
      id: folderId,
      sessionId: session.sessionId,
      provider: "browser-fs-access",
      name: "browser docs",
      pathLabel: "browser docs",
      mountName: "source_auto_count",
      mountPath: "/sources/source_auto_count",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      browserHandleKey: "handle-client_auto_count",
      browserClientSourceId: clientId,
    };
    session.folderSources.set(folderId, source);
    const core = await import("@qingagent/core");
    core.registerSessionFolderSources(session.sessionId, session.folderSources.values());
    core.registerBrowserFolderSource(session.sessionId, folderId, clientId);
    core.invalidateSessionWorkspace(session.sessionId);

    const events = await openFolderBridgeEvents(app, session.sessionId, clientId);
    try {
      const request = await events.readFolderRequest();
      expect(request).toMatchObject({
        sessionId: session.sessionId,
        folderId,
        clientId,
        op: "readdir",
        relPath: "",
      });

      await respondReaddir(app, request, [
        { name: "a.md", type: "file" },
        { name: "b.txt", type: "file" },
      ]);

      await waitForAssertion(() => {
        expect(session.folderSources.get(folderId)).toMatchObject({
          fileCount: 2,
          fileCountCapped: false,
        });
      });
    } finally {
      await events.close();
    }
  });

  it("browser fileCount 首次失败后，桥重连会走生产 SSE 入口重试并回填", async () => {
    process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES = "1";
    process.env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS = "1";
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bridge } = await loadBridge();
    const app = await makeFolderBridgeApp();
    const session = await createSession(bridge);
    const clientId = "client_retry_count";

    await collectFrames(bridge.handleCommand(browserAttachCommand(session.sessionId, clientId, "retry docs")));
    const folderId = Array.from(session.folderSources.keys())[0]!;

    await waitForAssertion(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        "[bridge] folder source file count refresh failed",
        expect.objectContaining({
          sessionId: session.sessionId,
          folderId,
          error: expect.stringContaining("offline"),
        }),
      );
    });
    expect(session.folderSources.get(folderId)).toMatchObject({ fileCount: null });

    const events = await openFolderBridgeEvents(app, session.sessionId, clientId);
    try {
      const request = await events.readFolderRequest();
      expect(request).toMatchObject({
        sessionId: session.sessionId,
        folderId,
        clientId,
        op: "readdir",
        relPath: "",
      });

      await respondReaddir(app, request, [{ name: "ready.md", type: "file" }]);

      await waitForAssertion(() => {
        expect(session.folderSources.get(folderId)).toMatchObject({
          fileCount: 1,
          fileCountCapped: false,
        });
      });
    } finally {
      consoleWarn.mockRestore();
      await events.close();
    }
  });

  it("初始 createSessionThread 未完成时 attachFolder 不与持久化等待互相卡死", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const createGate = deferred();
    const persistGate = deferred();
    const { bridge, schedulePersist } = await loadBridge({
      createSessionThread: vi.fn(() => createGate.promise),
      schedulePersist: vi.fn(() => persistGate.promise),
    });
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-create-race-"));
    writeFileSync(join(root, "a.md"), "a");
    const registry = await import("../lib/desktopFolderSelection");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: root,
      name: "docs",
      pathLabel: root,
      fileCount: 1,
    });

    const attachFrames = await withTimeout(
      collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken))),
      200,
      "attachFolder should not wait for pending initial thread create",
    );

    expect(attachFrames).toContainEqual(expect.objectContaining({
      kind: "folderSourceOperationResult",
      data: expect.objectContaining({ ok: true, op: "attach" }),
    }));
    expect(attachFrames.find((frame) => frame.kind === "folderSourcesChanged")).toBeDefined();
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:attachFolder");
    createGate.resolve();
    persistGate.resolve();
  });

  it("attach 路径断言失败不消费 selection token", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-token-"));
    const filePath = join(root, "not-dir.txt");
    writeFileSync(filePath, "not a directory");
    const registry = await import("../lib/desktopFolderSelection");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: filePath,
      name: "not-dir",
      pathLabel: filePath,
      fileCount: 1,
    });

    const frames = await collectFrames(
      bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)),
    );

    expect(frames).toEqual([
      {
        kind: "folderSourceOperationResult",
        data: { ok: false, op: "attach", reason: "invalid_path" },
      },
    ]);
    expect(registry.consumeDesktopFolderSelection(selection.selectionToken)?.rootPath).toBe(filePath);
  });

  it("detach 清缓存失败时仍完成状态变更并返回成功", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bridge, schedulePersist, clearFolderSourceCache } = await loadBridge();
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-clear-fail-"));
    writeFileSync(join(root, "a.md"), "a");
    const registry = await import("../lib/desktopFolderSelection");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: root,
      name: "docs",
      pathLabel: root,
      fileCount: 1,
    });
    await collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)));
    const folderId = Array.from(session.folderSources.keys())[0]!;
    clearFolderSourceCache.mockRejectedValueOnce(new Error("rm failed"));

    const detachFrames = await collectFrames(
      bridge.handleCommand({
        kind: "detachFolder",
        data: { sessionId: session.sessionId, folderId },
      }),
    );

    expect(detachFrames).toContainEqual({
      kind: "folderSourceOperationResult",
      data: { ok: true, op: "detach", folderId },
    });
    expect(detachFrames).toContainEqual({
      kind: "folderSourcesChanged",
      data: { sessionId: session.sessionId, sources: [] },
    });
    expect(session.folderSources.size).toBe(0);
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:detachFolder");
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("已有陈旧 error source 时 attach 新目录会替换旧 source 并复用 detach 清理", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge, schedulePersist, clearFolderSourceCache } = await loadBridge();
    const core = await import("@qingagent/core");
    const session = await createSession(bridge);
    const now = new Date().toISOString();
    const stale: FolderSourceRecord = {
      id: "fld_stale_error",
      sessionId: session.sessionId,
      provider: "desktop-local",
      name: "旧资料库",
      pathLabel: "~/missing/old",
      mountName: "source_stale_error",
      mountPath: "/sources/source_stale_error",
      readOnly: true,
      fileCount: 1,
      fileCountCapped: false,
      status: "error",
      error: "旧连接异常",
      createdAt: now,
      updatedAt: now,
    };
    session.folderSources.set(stale.id, stale);
    core.registerSessionFolderSources(session.sessionId, session.folderSources.values());

    const root = mkdtempSync(join(tmpdir(), "bridge-folder-replace-"));
    writeFileSync(join(root, "fresh.md"), "fresh");
    const registry = await import("../lib/desktopFolderSelection");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: root,
      name: "fresh",
      pathLabel: root,
      fileCount: 1,
    });

    const frames = await collectFrames(
      bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)),
    );
    const result = frames.find((frame) => frame.kind === "folderSourceOperationResult");
    const changed = frames.find((frame) => frame.kind === "folderSourcesChanged");

    expect(result?.kind === "folderSourceOperationResult" && result.data.ok).toBe(true);
    expect(changed?.kind).toBe("folderSourcesChanged");
    expect(changed?.kind === "folderSourcesChanged" ? changed.data.sources : []).toHaveLength(1);
    expect(changed?.kind === "folderSourcesChanged" ? changed.data.sources[0]?.status : null).toBe("connected");
    expect(changed?.kind === "folderSourcesChanged" ? changed.data.sources[0]?.id : null).not.toBe(stale.id);
    expect(session.folderSources.size).toBe(1);
    expect(session.folderSources.has(stale.id)).toBe(false);
    expect(core.getSessionFolderSources(session.sessionId)).toHaveLength(1);
    expect(clearFolderSourceCache).toHaveBeenCalledWith(session.sessionId, stale.id);
    expect(schedulePersist).toHaveBeenCalledWith(session, "command:attachFolder");
  });

  it("forgetSession 驱逐 bridge 内存 session 并注销 folder source registry", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const root = mkdtempSync(join(tmpdir(), "bridge-folder-forget-"));
    writeFileSync(join(root, "a.md"), "a");
    const registry = await import("../lib/desktopFolderSelection");
    const core = await import("@qingagent/core");
    const selection = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: root,
      name: "docs",
      pathLabel: root,
      fileCount: 1,
    });
    await collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selection.selectionToken)));
    const attachedSource = Array.from(session.folderSources.values())[0]!;

    expect(bridge.getSession(session.sessionId)).toBeDefined();
    expect(core.getSessionFolderSources(session.sessionId)).toHaveLength(1);

    expect(bridge.forgetSession(session.sessionId)).toBe(true);

    expect(bridge.getSession(session.sessionId)).toBeUndefined();
    expect(core.getSessionFolderSources(session.sessionId)).toEqual([]);
    const readAfterForget = await core.readDocumentForSession({
      sessionId: session.sessionId,
      sources: core.getSessionFolderSources(session.sessionId),
      workspace: {} as never,
      path: `${attachedSource.mountPath}/a.md`,
    });
    expect(readAfterForget.ok).toBe(false);
    expect(readAfterForget.error).toContain("not_found");

    const detachFrames = await collectFrames(
      bridge.handleCommand({
        kind: "detachFolder",
        data: { sessionId: session.sessionId, folderId: "fld_missing" },
      }),
    );
    expect(detachFrames).toEqual([
      {
        kind: "folderSourceOperationResult",
        data: { ok: false, op: "detach", reason: "not_found" },
      },
    ]);
  });

  it("并发 attachFolder 仍保持单资料库不变量", async () => {
    process.env.QINGAGENT_RUNTIME = "desktop";
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES = "1";
    const { bridge } = await loadBridge();
    const session = await createSession(bridge);
    const rootA = mkdtempSync(join(tmpdir(), "bridge-folder-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "bridge-folder-b-"));
    writeFileSync(join(rootA, "a.md"), "a");
    writeFileSync(join(rootB, "b.md"), "b");
    const registry = await import("../lib/desktopFolderSelection");
    const selectionA = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: rootA,
      name: "docs-a",
      pathLabel: rootA,
      fileCount: 1,
    });
    const selectionB = registry.registerDesktopFolderSelection({
      webContentsId: 1,
      rootPath: rootB,
      name: "docs-b",
      pathLabel: rootB,
      fileCount: 1,
    });

    const [framesA, framesB] = await Promise.all([
      collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selectionA.selectionToken))),
      collectFrames(bridge.handleCommand(attachCommand(session.sessionId, selectionB.selectionToken))),
    ]);
    const results = [...framesA, ...framesB].filter(
      (frame): frame is Extract<BridgeFrame, { kind: "folderSourceOperationResult" }> =>
        frame.kind === "folderSourceOperationResult",
    );

    expect(results.filter((frame) => frame.data.ok).length).toBe(1);
    expect(results.filter((frame) => !frame.data.ok && frame.data.reason === "too_many_sources").length).toBe(1);
    expect(Array.from(session.folderSources.values()).filter((source) => source.status === "connected")).toHaveLength(1);
  });
});
