import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderSource } from "@qingagent/contract-ts";
import {
  cleanupOrphanBrowserFolderHandles,
  forgetBrowserFolderSource,
  ensureBrowserFolderBridge,
  pickBrowserFolderSource,
  rememberAttachedBrowserFolderSource,
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

  constructor(private readonly stores: StoreDump) {}

  objectStore(name: string) {
    const store = this.stores[name] ?? new Map<string, unknown>();
    this.stores[name] = store;
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
        const request = new FakeIDBRequest<undefined>();
        store.set(key, value);
        request.succeed(undefined);
        queueMicrotask(() => this.oncomplete?.());
        return request;
      },
      delete: (key: string) => {
        const request = new FakeIDBRequest<undefined>();
        store.delete(key);
        request.succeed(undefined);
        queueMicrotask(() => this.oncomplete?.());
        return request;
      },
    };
  }
}

class FakeIDBDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores[name] !== undefined,
  };

  constructor(private readonly stores: StoreDump) {}

  createObjectStore(name: string): void {
    this.stores[name] ??= new Map<string, unknown>();
  }

  transaction(storeName: string): FakeIDBTransaction {
    this.stores[storeName] ??= new Map<string, unknown>();
    return new FakeIDBTransaction(this.stores);
  }

  close(): void {}
}

class FakeEventSource {
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

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

  close(): void {}
}

const fakeEventSources: FakeEventSource[] = [];

function installFakeIndexedDb(stores: StoreDump): void {
  let upgraded = false;
  const indexedDB = {
    open: (_name: string, _version?: number) => {
      const request = new FakeIDBOpenRequest<FakeIDBDatabase>();
      const db = new FakeIDBDatabase(stores);
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
});
