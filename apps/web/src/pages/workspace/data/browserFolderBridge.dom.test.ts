import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import {
  browserBridgeFailureReasonCode,
  cleanupOrphanBrowserFolderHandles,
  forgetBrowserFolderSource,
  ensureBrowserFolderBridge,
  pickBrowserFolderSource,
  rememberAttachedBrowserFolderSource,
  requestBrowserFolderPermission,
  stopBrowserFolderBridge,
  type PickedBrowserFolderSource,
} from "./browserFolderBridge";

type StoreDump = Record<string, Map<string, unknown>>;

class FakeIDBRequest<T = unknown> {
  onsuccess: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  result!: T;
  error: Error | null = null;

  succeed(value: T): void {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }
}

class FakeIDBOpenRequest<T = unknown> extends FakeIDBRequest<T> {
  onupgradeneeded: ((event: unknown) => void) | null = null;
}

class FakeIDBTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private aborted = false;
  private completionQueued = false;
  private readonly stagedStores: StoreDump;

  constructor(
    private readonly stores: StoreDump,
    storeNames: readonly string[],
    private readonly failPutStore: string | null,
  ) {
    this.stagedStores = Object.fromEntries(
      storeNames.map((name) => [name, new Map(stores[name] ?? [])]),
    );
  }

  objectStore(name: string) {
    const store = this.stagedStores[name] ?? new Map<string, unknown>();
    this.stagedStores[name] = store;
    return {
      get: (key: string) => {
        const request = new FakeIDBRequest<unknown>();
        request.succeed(store.get(key));
        return request;
      },
      getAll: () => {
        const request = new FakeIDBRequest<unknown[]>();
        request.succeed([...store.values()]);
        return request;
      },
      getAllKeys: () => {
        const request = new FakeIDBRequest<IDBValidKey[]>();
        request.succeed([...store.keys()]);
        return request;
      },
      put: (value: unknown, key: string) => {
        if (name === this.failPutStore) {
          throw new DOMException("handle clone failed", "DataCloneError");
        }
        const request = new FakeIDBRequest<undefined>();
        store.set(key, value);
        request.succeed(undefined);
        this.queueCompletion();
        return request;
      },
      delete: (key: string) => {
        const request = new FakeIDBRequest<undefined>();
        store.delete(key);
        request.succeed(undefined);
        this.queueCompletion();
        return request;
      },
    };
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.());
  }

  private queueCompletion(): void {
    if (this.completionQueued) return;
    this.completionQueued = true;
    queueMicrotask(() => {
      if (this.aborted) return;
      for (const [name, store] of Object.entries(this.stagedStores)) {
        this.stores[name] = new Map(store);
      }
      this.oncomplete?.();
    });
  }
}

class FakeIDBDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores[name] !== undefined,
  };

  constructor(
    private readonly stores: StoreDump,
    private readonly failPutStore: () => string | null,
  ) {}

  createObjectStore(name: string): void {
    this.stores[name] ??= new Map<string, unknown>();
  }

  transaction(storeNames: string | string[]): FakeIDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) this.stores[name] ??= new Map<string, unknown>();
    return new FakeIDBTransaction(this.stores, names, this.failPutStore());
  }

  close(): void {}
}

class FakeEventSource {
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    fakeEventSources.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = typeof listener === "function"
      ? listener as (event: MessageEvent) => void
      : (event: MessageEvent) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

const fakeEventSources: FakeEventSource[] = [];
let failedPutStore: string | null = null;

function installFakeIndexedDb(stores: StoreDump): void {
  let upgraded = false;
  const indexedDB = {
    open: (_name: string, _version?: number) => {
      const request = new FakeIDBOpenRequest<FakeIDBDatabase>();
      const db = new FakeIDBDatabase(stores, () => failedPutStore);
      queueMicrotask(() => {
        request.result = db;
        if (!upgraded) {
          upgraded = true;
          request.onupgradeneeded?.({ target: request });
        }
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
  Object.defineProperty(window, "indexedDB", { configurable: true, writable: true, value: indexedDB });
  vi.stubGlobal("indexedDB", indexedDB);
}

function makeDirectoryHandle(name: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    entries: async function* entries() {},
    getDirectoryHandle: async (childName: string) => makeDirectoryHandle(childName),
    getFileHandle: async () => {
      throw new Error("not used by this test");
    },
  } as unknown as FileSystemDirectoryHandle;
}

async function flushBridgeTasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function handleStore(stores: StoreDump): Map<string, unknown> {
  return stores.handles ?? new Map<string, unknown>();
}

function sourceStore(stores: StoreDump): Map<string, unknown> {
  return stores.sources ?? new Map<string, unknown>();
}

describe("browser folder handle persistence", () => {
  let stores: StoreDump;
  let uuidSeq = 0;

  beforeEach(() => {
    stores = {};
    uuidSeq = 0;
    failedPutStore = null;
    fakeEventSources.length = 0;
    installFakeIndexedDb(stores);
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: {
        randomUUID: () => `00000000-0000-4000-8000-${(++uuidSeq).toString().padStart(12, "0")}`,
      },
    });
    vi.stubGlobal("crypto", window.crypto);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["NotFoundError", "not_found"],
    ["NotAllowedError", "permission_denied"],
    ["SecurityError", "permission_denied"],
    ["AbortError", "unknown"],
  ] as const)("浏览器异常 %s 只映射为安全 reasonCode %s", (name, expected) => {
    const error = new DOMException("/Users/alice/Private/leak.md", name);
    expect(browserBridgeFailureReasonCode(error)).toBe(expected);
  });

  it("选择阶段不持久化 handle，取消或重选不会留下 orphan", async () => {
    const handles = [makeDirectoryHandle("first-folder"), makeDirectoryHandle("second-folder")];
    let pickerCalls = 0;
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => handles[pickerCalls++]!,
    });

    const first = await pickBrowserFolderSource("new-session");
    const second = await pickBrowserFolderSource("new-session");

    expect(first.name).toBe("first-folder");
    expect(second.name).toBe("second-folder");
    expect(pickerCalls).toBe(2);
    expect(handleStore(stores).size).toBe(0);
    expect(sourceStore(stores).size).toBe(0);
  });

  it("attach 成功后才写入 handle，并清理不属于任何 source index 的 orphan handle", async () => {
    const picked: PickedBrowserFolderSource = {
      handle: makeDirectoryHandle("attached-folder"),
      name: "attached-folder",
      browserHandleKey: `${window.location.origin}:sess:handle:attached`,
      clientSourceId: "browser_client_attached",
    };
    stores.handles = new Map([
      [`${window.location.origin}:old:handle:orphan`, makeDirectoryHandle("orphan-folder")],
    ]);

    await rememberAttachedBrowserFolderSource({
      sessionId: "sess",
      folderId: "fld",
      picked,
    });

    expect([...handleStore(stores).keys()]).toEqual([picked.browserHandleKey]);
    expect(sourceStore(stores).size).toBe(1);
    expect(await cleanupOrphanBrowserFolderHandles()).toBe(0);

    await forgetBrowserFolderSource("sess", "fld");
    expect(handleStore(stores).size).toBe(0);
    expect(sourceStore(stores).size).toBe(0);
  });

  it("handle 写入失败时与 source index 一起回滚，不留下半状态", async () => {
    const picked: PickedBrowserFolderSource = {
      handle: makeDirectoryHandle("unclonable-folder"),
      name: "unclonable-folder",
      browserHandleKey: `${window.location.origin}:sess-atomic:handle:root`,
      clientSourceId: "browser_client_atomic",
    };
    failedPutStore = "handles";

    await expect(rememberAttachedBrowserFolderSource({
      sessionId: "sess-atomic",
      folderId: "fld-atomic",
      picked,
    })).rejects.toMatchObject({ name: "DataCloneError" });

    expect(sourceStore(stores).size).toBe(0);
    expect(handleStore(stores).size).toBe(0);
  });

  it("权限 API 拒绝时 ensure 与 request 都返回错误状态，不逃逸 rejected Promise", async () => {
    const source: FolderSource = {
      id: "fld-permission-error",
      sessionId: "sess-permission-error",
      provider: "browser-fs-access",
      name: "permission-error-folder",
      pathLabel: "permission-error-folder",
      mountName: "source_permission_error",
      mountPath: "/sources/source_permission_error",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const handleKey = `${window.location.origin}:sess-permission-error:handle:root`;
    stores.sources = new Map([[
      `${window.location.origin}:${source.sessionId}:${source.id}`,
      {
        key: `${window.location.origin}:${source.sessionId}:${source.id}`,
        sessionId: source.sessionId,
        folderId: source.id,
        handleKey,
        clientId: "browser_client_permission_error",
        name: source.name,
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ]]);
    stores.handles = new Map([[handleKey, {
      ...makeDirectoryHandle(source.name),
      queryPermission: async () => { throw new Error("query permission failed"); },
      requestPermission: async () => { throw new Error("request permission failed"); },
    }]]);

    await expect(ensureBrowserFolderBridge(source)).resolves.toEqual({
      status: "error",
      error: "query permission failed",
    });
    await expect(requestBrowserFolderPermission(source)).resolves.toEqual({
      status: "error",
      error: "request permission failed",
    });
  });

  it("同一文件夹并发启动只注册一次并只建立一个 SSE", async () => {
    const picked: PickedBrowserFolderSource = {
      handle: makeDirectoryHandle("single-flight-folder"),
      name: "single-flight-folder",
      browserHandleKey: `${window.location.origin}:sess-flight:handle:root`,
      clientSourceId: "browser_client_flight",
    };
    const source: FolderSource = {
      id: "fld-flight",
      sessionId: "sess-flight",
      provider: "browser-fs-access",
      name: picked.name,
      pathLabel: picked.name,
      mountName: "source_flight",
      mountPath: "/sources/source_flight",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    await rememberAttachedBrowserFolderSource({
      sessionId: source.sessionId,
      folderId: source.id,
      picked,
    });
    stopBrowserFolderBridge(source.sessionId, source.id);
    fakeEventSources.length = 0;
    vi.mocked(fetch).mockClear();

    let releaseRegister!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).endsWith("/folder-bridge/register")) {
        await registerGate;
      }
      return { ok: true, status: 200 } as Response;
    });

    const first = ensureBrowserFolderBridge(source);
    const second = ensureBrowserFolderBridge(source);
    await flushBridgeTasks();
    const registerCallsBeforeRelease = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) =>
        String(input).endsWith("/folder-bridge/register"),
      );
    expect(registerCallsBeforeRelease).toHaveLength(1);

    releaseRegister();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "connected", error: null },
      { status: "connected", error: null },
    ]);
    expect(fakeEventSources).toHaveLength(1);

    await forgetBrowserFolderSource(source.sessionId, source.id);
  });

  it("ensure 在权限查询期间被取消后不再注册 bridge 或建立 SSE", async () => {
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    const source: FolderSource = {
      id: "fld-abort",
      sessionId: "sess-abort",
      provider: "browser-fs-access",
      name: "abort-folder",
      pathLabel: "abort-folder",
      mountName: "source_abort",
      mountPath: "/sources/source_abort",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const handleKey = `${window.location.origin}:sess-abort:handle:root`;
    stores.sources = new Map([[
      `${window.location.origin}:${source.sessionId}:${source.id}`,
      {
        key: `${window.location.origin}:${source.sessionId}:${source.id}`,
        sessionId: source.sessionId,
        folderId: source.id,
        handleKey,
        clientId: "browser_client_abort",
        name: source.name,
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ]]);
    stores.handles = new Map([[handleKey, {
      ...makeDirectoryHandle(source.name),
      queryPermission: async () => {
        await permissionGate;
        return "granted";
      },
    }]]);

    const controller = new AbortController();
    const ensuring = ensureBrowserFolderBridge(source, controller.signal);
    await flushBridgeTasks();
    controller.abort();
    stopBrowserFolderBridge(source.sessionId, source.id);
    releasePermission();

    await expect(ensuring).resolves.toEqual({
      status: "connected",
      error: null,
    });
    expect(fakeEventSources).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      "/api/v1/folder-bridge/register",
      expect.anything(),
    );
  });

  it("启动注册在途时停止会注销旧连接，随后重启不会被旧竞争者覆盖", async () => {
    const picked: PickedBrowserFolderSource = {
      handle: makeDirectoryHandle("cancelled-folder"),
      name: "cancelled-folder",
      browserHandleKey: `${window.location.origin}:sess-cancel:handle:root`,
      clientSourceId: "browser_client_cancel",
    };
    const source: FolderSource = {
      id: "fld-cancel",
      sessionId: "sess-cancel",
      provider: "browser-fs-access",
      name: picked.name,
      pathLabel: picked.name,
      mountName: "source_cancel",
      mountPath: "/sources/source_cancel",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    await rememberAttachedBrowserFolderSource({
      sessionId: source.sessionId,
      folderId: source.id,
      picked,
    });
    stopBrowserFolderBridge(source.sessionId, source.id);
    fakeEventSources.length = 0;
    vi.mocked(fetch).mockClear();

    let releaseRegister!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).endsWith("/folder-bridge/register")) {
        await registerGate;
      }
      return { ok: true, status: 200 } as Response;
    });

    const starting = ensureBrowserFolderBridge(source);
    await flushBridgeTasks();
    stopBrowserFolderBridge(source.sessionId, source.id);
    const restarted = ensureBrowserFolderBridge(source);
    releaseRegister();
    await starting;
    await expect(restarted).resolves.toEqual({
      status: "connected",
      error: null,
    });
    await flushBridgeTasks();

    expect(fakeEventSources).toHaveLength(1);
    const registerCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).endsWith("/folder-bridge/register"),
    );
    expect(registerCalls).toHaveLength(2);
    const unregisterCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
      String(input).endsWith("/folder-bridge/unregister"),
    );
    expect(unregisterCalls).toHaveLength(1);

    await forgetBrowserFolderSource(source.sessionId, source.id);
  });

  it("readdir 不逐文件 getFile 读取 size，size 由 stat/readFile 懒加载", async () => {
    const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      fetchCalls.push({ input, init });
      return { ok: true, status: 200 } as Response;
    });

    let getFileCalls = 0;
    const fileHandle = {
      kind: "file",
      name: "slow.md",
      getFile: async () => {
        getFileCalls += 1;
        throw new Error("readdir must not read file metadata");
      },
    } as unknown as FileSystemFileHandle;
    const subdirHandle = makeDirectoryHandle("subdir");
    const rootHandle = {
      ...makeDirectoryHandle("root-folder"),
      entries: async function* entries() {
        yield ["slow.md", fileHandle] as const;
        yield ["subdir", subdirHandle] as const;
      },
    } as unknown as FileSystemDirectoryHandle;
    const picked: PickedBrowserFolderSource = {
      handle: rootHandle,
      name: "root-folder",
      browserHandleKey: `${window.location.origin}:sess-readdir:handle:root`,
      clientSourceId: "browser_client_readdir",
    };
    const source: FolderSource = {
      id: "fld-readdir",
      sessionId: "sess-readdir",
      provider: "browser-fs-access",
      name: "Root Folder",
      pathLabel: "Root Folder",
      mountName: "source_readdir",
      mountPath: "/sources/source_readdir",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    };

    await rememberAttachedBrowserFolderSource({
      sessionId: source.sessionId,
      folderId: source.id,
      picked,
    });
    await expect(ensureBrowserFolderBridge(source)).resolves.toEqual({ status: "connected", error: null });

    fakeEventSources.at(-1)?.emit("folder-request", {
      requestId: "req-readdir",
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: picked.clientSourceId,
      op: "readdir",
      relPath: "",
    });
    await flushBridgeTasks();

    const responseCall = fetchCalls.find((call) =>
      String(call.input).includes("/api/v1/folder-bridge/responses/req-readdir")
    );
    expect(responseCall).toBeDefined();
    const body = JSON.parse(String(responseCall?.init?.body ?? "{}")) as {
      ok: boolean;
      entries: Array<{ name: string; type: string; size?: number }>;
    };
    expect(body.ok).toBe(true);
    expect(body.entries).toContainEqual({ name: "slow.md", type: "file" });
    expect(body.entries).toContainEqual({ name: "subdir", type: "directory", size: 0 });
    expect(getFileCalls).toBe(0);

    await forgetBrowserFolderSource(source.sessionId, source.id);
  });

  it("二进制回传非 2xx 时立即上报失败响应，不静默等待服务端 30s 超时", async () => {
    const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      fetchCalls.push({ input, init });
      const matchingResponses = fetchCalls.filter((call) =>
        String(call.input).includes("/folder-bridge/responses/"),
      );
      if (matchingResponses.length === 1) {
        return { ok: false, status: 413 } as Response;
      }
      return { ok: true, status: 200 } as Response;
    });

    const fileHandle = {
      kind: "file",
      name: "large.bin",
      getFile: async () => ({
        name: "large.bin",
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    } as unknown as FileSystemFileHandle;
    const rootHandle = {
      ...makeDirectoryHandle("root-folder"),
      getFileHandle: async () => fileHandle,
    } as unknown as FileSystemDirectoryHandle;
    const picked: PickedBrowserFolderSource = {
      handle: rootHandle,
      name: "root-folder",
      browserHandleKey: `${window.location.origin}:sess-failed-post:handle:root`,
      clientSourceId: "browser_client_failed_post",
    };
    const source: FolderSource = {
      id: "fld-failed-post",
      sessionId: "sess-failed-post",
      provider: "browser-fs-access",
      name: "Root Folder",
      pathLabel: "Root Folder",
      mountName: "source_failed_post",
      mountPath: "/sources/source_failed_post",
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    };

    await rememberAttachedBrowserFolderSource({
      sessionId: source.sessionId,
      folderId: source.id,
      picked,
    });
    await ensureBrowserFolderBridge(source);
    fakeEventSources.at(-1)?.emit("folder-request", {
      requestId: "req-failed-post",
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: picked.clientSourceId,
      op: "readFile",
      relPath: "large.bin",
      maxBytes: 1024,
    });
    await flushBridgeTasks();

    const responseCalls = fetchCalls.filter((call) =>
      String(call.input).includes("/folder-bridge/responses/req-failed-post"),
    );
    expect(responseCalls).toHaveLength(2);
    expect(responseCalls[0]?.init?.body).toBeInstanceOf(ArrayBuffer);
    const failure = JSON.parse(String(responseCalls[1]?.init?.body)) as Record<string, unknown>;
    expect(failure).toMatchObject({
      ok: false,
      reasonCode: "too_large",
    });
    expect(failure).not.toHaveProperty("error");

    await forgetBrowserFolderSource(source.sessionId, source.id);
  });
});
