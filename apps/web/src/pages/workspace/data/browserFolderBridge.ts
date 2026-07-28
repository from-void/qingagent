import type { FolderSource } from "@qingagent/contract-ts";

type PermissionStateLike = "granted" | "denied" | "prompt";

interface BrowserFolderSourceIndex {
  key: string;
  sessionId: string;
  folderId: string;
  handleKey: string;
  clientId: string;
  name: string;
  updatedAt: string;
}

export interface PickedBrowserFolderSource {
  handle: FileSystemDirectoryHandle;
  name: string;
  browserHandleKey: string;
  clientSourceId: string;
}

interface ActiveBrowserBridge {
  sessionId: string;
  folderId: string;
  clientId: string;
  handle: FileSystemDirectoryHandle;
  eventSource: EventSource;
  closed: boolean;
}

interface PendingBrowserBridgeStart {
  cancelled: boolean;
  promise: Promise<void>;
}

interface BrowserBridgeRequest {
  requestId: string;
  sessionId: string;
  folderId: string;
  clientId: string;
  op: "stat" | "readdir" | "readFile";
  relPath: string;
  maxBytes?: number;
}

export type BrowserBridgeFailureReasonCode =
  | "not_found"
  | "permission_denied"
  | "too_large"
  | "unknown";

type BrowserBridgeStatus =
  | { status: "connected"; error: null }
  | { status: "permission_required"; error: string }
  | { status: "missing"; error: string }
  | { status: "error"; error: string };

const DB_NAME = "qingagent-folder-handles";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const SOURCE_STORE = "sources";
const activeBridges = new Map<string, ActiveBrowserBridge>();
const pendingBridgeStarts = new Map<string, PendingBrowserBridgeStart>();

class BrowserBridgeTooLargeError extends Error {
  constructor() {
    super("browser folder file exceeds the size limit");
    this.name = "BrowserBridgeTooLargeError";
  }
}

export function browserBridgeFailureReasonCode(
  error: unknown,
): BrowserBridgeFailureReasonCode {
  const name = error !== null && typeof error === "object" &&
      typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  if (name === "NotFoundError") return "not_found";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "BrowserBridgeTooLargeError") return "too_large";
  return "unknown";
}

function browserBridgeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bridgeKey(sessionId: string, folderId: string): string {
  return `${sessionId}\0${folderId}`;
}

function originPrefix(): string {
  return typeof window === "undefined" ? "unknown-origin" : window.location.origin;
}

function sourceIndexKey(sessionId: string, folderId: string): string {
  return `${originPrefix()}:${sessionId}:${folderId}`;
}

function newHandleKey(sessionId: string): string {
  return `${originPrefix()}:${sessionId}:handle:${crypto.randomUUID()}`;
}

function newClientSourceId(): string {
  return `browser_${crypto.randomUUID().replace(/-/g, "")}`;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openFolderDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(SOURCE_STORE)) db.createObjectStore(SOURCE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openFolderDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    return await idbRequest<T | undefined>(tx.objectStore(storeName).get(key));
  } finally {
    db.close();
  }
}

async function idbPut<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openFolderDb();
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openFolderDb();
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete aborted"));
    });
  } finally {
    db.close();
  }
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openFolderDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    return await idbRequest<T[]>(tx.objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

async function idbGetAllKeys(storeName: string): Promise<IDBValidKey[]> {
  const db = await openFolderDb();
  try {
    const tx = db.transaction(storeName, "readonly");
    return await idbRequest<IDBValidKey[]>(tx.objectStore(storeName).getAllKeys());
  } finally {
    db.close();
  }
}

function sourceIndexHandleKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const handleKey = (value as { handleKey?: unknown }).handleKey;
  return typeof handleKey === "string" && handleKey.length > 0 ? handleKey : null;
}

async function queryReadPermission(handle: FileSystemDirectoryHandle): Promise<PermissionStateLike> {
  if (typeof handle.queryPermission !== "function") return "granted";
  return await handle.queryPermission({ mode: "read" });
}

async function requestReadPermission(handle: FileSystemDirectoryHandle): Promise<PermissionStateLike> {
  if (typeof handle.requestPermission !== "function") return "granted";
  return await handle.requestPermission({ mode: "read" });
}

export function splitBrowserBridgeRelPath(relPath: string, allowRoot: boolean): string[] {
  if (typeof relPath !== "string") throw new Error("invalid_path: path must be a string");
  if (relPath === "") {
    if (allowRoot) return [];
    throw new Error("invalid_path: path must point to a file");
  }
  if (
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    relPath.startsWith("/") ||
    /^[a-zA-Z]:/.test(relPath)
  ) {
    throw new Error("invalid_path: unsafe path");
  }
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid_path: unsafe path segment");
  }
  return parts;
}

async function directoryAt(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

async function parentAndName(
  root: FileSystemDirectoryHandle,
  relPath: string,
): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
  const parts = splitBrowserBridgeRelPath(relPath, false);
  const name = parts[parts.length - 1];
  if (!name) throw new Error("invalid_path: path must point to a file");
  return {
    parent: await directoryAt(root, parts.slice(0, -1)),
    name,
  };
}

function isoFromLastModified(value: number): string {
  const date = Number.isFinite(value) && value > 0 ? new Date(value) : new Date();
  return date.toISOString();
}

function mimeTypeForFile(file: File): string | undefined {
  return file.type || undefined;
}

async function statEntry(root: FileSystemDirectoryHandle, relPath: string): Promise<{
  name: string;
  type: "file" | "directory";
  size: number;
  createdAt: string;
  modifiedAt: string;
  mimeType?: string;
}> {
  if (relPath === "") {
    const now = new Date().toISOString();
    return { name: root.name, type: "directory", size: 0, createdAt: now, modifiedAt: now };
  }
  const { parent, name } = await parentAndName(root, relPath);
  try {
    const dir = await parent.getDirectoryHandle(name);
    const now = new Date().toISOString();
    return { name: dir.name, type: "directory", size: 0, createdAt: now, modifiedAt: now };
  } catch {
    const fileHandle = await parent.getFileHandle(name);
    const file = await fileHandle.getFile();
    const modifiedAt = isoFromLastModified(file.lastModified);
    return {
      name: file.name,
      type: "file",
      size: file.size,
      createdAt: modifiedAt,
      modifiedAt,
      ...(mimeTypeForFile(file) ? { mimeType: mimeTypeForFile(file) } : {}),
    };
  }
}

async function readdirEntry(root: FileSystemDirectoryHandle, relPath: string): Promise<Array<{
  name: string;
  type: "file" | "directory";
  size?: number;
}>> {
  const dir = await directoryAt(root, splitBrowserBridgeRelPath(relPath, true));
  const entries: Array<{ name: string; type: "file" | "directory"; size?: number }> = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") {
      entries.push({ name, type: "file" });
    } else {
      entries.push({ name, type: "directory", size: 0 });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function readFileEntry(
  root: FileSystemDirectoryHandle,
  relPath: string,
  maxBytes?: number,
): Promise<ArrayBuffer> {
  const { parent, name } = await parentAndName(root, relPath);
  const file = await (await parent.getFileHandle(name)).getFile();
  if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && file.size > maxBytes) {
    throw new BrowserBridgeTooLargeError();
  }
  const buffer = await file.arrayBuffer();
  if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && buffer.byteLength > maxBytes) {
    throw new BrowserBridgeTooLargeError();
  }
  return buffer;
}

function parseBridgeRequest(value: unknown): BrowserBridgeRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protocol_error: request must be an object");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.requestId !== "string" || !data.requestId) throw new Error("protocol_error: requestId");
  if (typeof data.sessionId !== "string" || !data.sessionId) throw new Error("protocol_error: sessionId");
  if (typeof data.folderId !== "string" || !data.folderId) throw new Error("protocol_error: folderId");
  if (typeof data.clientId !== "string" || !data.clientId) throw new Error("protocol_error: clientId");
  if (data.op !== "stat" && data.op !== "readdir" && data.op !== "readFile") {
    throw new Error("protocol_error: op");
  }
  if (typeof data.relPath !== "string") throw new Error("protocol_error: relPath");
  if (
    data.maxBytes !== undefined &&
    (typeof data.maxBytes !== "number" || !Number.isFinite(data.maxBytes) || data.maxBytes <= 0)
  ) {
    throw new Error("protocol_error: maxBytes");
  }
  return {
    requestId: data.requestId,
    sessionId: data.sessionId,
    folderId: data.folderId,
    clientId: data.clientId,
    op: data.op,
    relPath: data.relPath,
    ...(typeof data.maxBytes === "number" ? { maxBytes: data.maxBytes } : {}),
  };
}

async function postJsonResponse(request: BrowserBridgeRequest, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/v1/folder-bridge/responses/${encodeURIComponent(request.requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: request.sessionId,
      folderId: request.folderId,
      clientId: request.clientId,
      ...body,
    }),
  });
  if (!response.ok) throw new Error(`folder bridge response failed: ${response.status}`);
}

async function postBinaryResponse(request: BrowserBridgeRequest, bytes: ArrayBuffer): Promise<void> {
  const response = await fetch(`/api/v1/folder-bridge/responses/${encodeURIComponent(request.requestId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-qingagent-session-id": request.sessionId,
      "x-qingagent-folder-id": request.folderId,
      "x-qingagent-client-id": request.clientId,
      "x-qingagent-folder-op": "readFile",
    },
    body: bytes,
  });
  if (!response.ok) {
    if (response.status === 413) throw new BrowserBridgeTooLargeError();
    throw new Error(`folder bridge binary response failed: ${response.status}`);
  }
}

async function handleBridgeRequest(bridge: ActiveBrowserBridge, raw: unknown): Promise<void> {
  if (bridge.closed) return;
  let request: BrowserBridgeRequest | null = null;
  try {
    request = parseBridgeRequest(raw);
    if (
      request.sessionId !== bridge.sessionId ||
      request.folderId !== bridge.folderId ||
      request.clientId !== bridge.clientId
    ) {
      throw new Error("protocol_error: request binding mismatch");
    }
    if (request.op === "stat") {
      splitBrowserBridgeRelPath(request.relPath, true);
      const stat = await statEntry(bridge.handle, request.relPath);
      if (bridge.closed) return;
      await postJsonResponse(request, { ok: true, op: "stat", stat });
      return;
    }
    if (request.op === "readdir") {
      splitBrowserBridgeRelPath(request.relPath, true);
      const entries = await readdirEntry(bridge.handle, request.relPath);
      if (bridge.closed) return;
      await postJsonResponse(request, { ok: true, op: "readdir", entries });
      return;
    }
    splitBrowserBridgeRelPath(request.relPath, false);
    const bytes = await readFileEntry(bridge.handle, request.relPath, request.maxBytes);
    if (bridge.closed) return;
    await postBinaryResponse(request, bytes);
  } catch (error) {
    if (request && !bridge.closed) {
      try {
        await postJsonResponse(request, {
          ok: false,
          reasonCode: browserBridgeFailureReasonCode(error),
        });
      } catch (postError) {
        console.error("[browserFolderBridge] failed to report bridge error", postError);
      }
      return;
    }
    console.error("[browserFolderBridge] invalid bridge request", error);
  }
}

async function registerBridge(sessionId: string, folderId: string, clientId: string): Promise<void> {
  const response = await fetch("/api/v1/folder-bridge/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, folderId, clientId }),
  });
  if (!response.ok) throw new Error(`folder bridge register failed: ${response.status}`);
}

async function unregisterBridge(sessionId: string, folderId: string, clientId: string): Promise<void> {
  await fetch("/api/v1/folder-bridge/unregister", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, folderId, clientId }),
    keepalive: true,
  }).catch(() => undefined);
}

async function closeActiveBridge(
  key: string,
  bridge: ActiveBrowserBridge,
): Promise<void> {
  bridge.closed = true;
  bridge.eventSource.close();
  if (activeBridges.get(key) === bridge) activeBridges.delete(key);
  await unregisterBridge(bridge.sessionId, bridge.folderId, bridge.clientId);
}

async function startBridgeOnce(
  args: {
    sessionId: string;
    folderId: string;
    clientId: string;
    handle: FileSystemDirectoryHandle;
  },
  pending: PendingBrowserBridgeStart,
): Promise<void> {
  const key = bridgeKey(args.sessionId, args.folderId);
  const existing = activeBridges.get(key);
  if (existing) await closeActiveBridge(key, existing);
  if (pending.cancelled) return;

  let registered = false;
  let adopted = false;
  let eventSource: EventSource | null = null;
  try {
    await registerBridge(args.sessionId, args.folderId, args.clientId);
    registered = true;
    if (pending.cancelled) return;

    const url = `/api/v1/folder-bridge/events?sessionId=${encodeURIComponent(args.sessionId)}&clientId=${encodeURIComponent(args.clientId)}`;
    eventSource = new EventSource(url);
    const bridge: ActiveBrowserBridge = {
      sessionId: args.sessionId,
      folderId: args.folderId,
      clientId: args.clientId,
      handle: args.handle,
      eventSource,
      closed: false,
    };
    eventSource.addEventListener("folder-request", (event) => {
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent).data);
      } catch (error) {
        console.error("[browserFolderBridge] request JSON parse failed", error);
        return;
      }
      void handleBridgeRequest(bridge, data);
    });
    eventSource.onerror = () => {
      // EventSource 会自动重连；这里只记录，不主动关闭，避免短暂网络抖动中断资料库。
      console.warn("[browserFolderBridge] SSE connection error", {
        sessionId: args.sessionId,
        folderId: args.folderId,
      });
    };
    activeBridges.set(key, bridge);
    adopted = true;
  } finally {
    if (!adopted) {
      eventSource?.close();
      if (registered) {
        await unregisterBridge(args.sessionId, args.folderId, args.clientId);
      }
    }
  }
}

async function startBridge(args: {
  sessionId: string;
  folderId: string;
  clientId: string;
  handle: FileSystemDirectoryHandle;
}): Promise<void> {
  const key = bridgeKey(args.sessionId, args.folderId);
  const existing = activeBridges.get(key);
  if (
    existing &&
    existing.clientId === args.clientId &&
    existing.handle === args.handle &&
    !existing.closed
  ) {
    return;
  }

  const inFlight = pendingBridgeStarts.get(key);
  if (inFlight) {
    await inFlight.promise;
    if (inFlight.cancelled) return startBridge(args);
    const started = activeBridges.get(key);
    if (
      started &&
      started.clientId === args.clientId &&
      started.handle === args.handle &&
      !started.closed
    ) {
      return;
    }
    return startBridge(args);
  }

  const pending: PendingBrowserBridgeStart = {
    cancelled: false,
    promise: Promise.resolve(),
  };
  const promise = startBridgeOnce(args, pending).finally(() => {
    if (pendingBridgeStarts.get(key) === pending) {
      pendingBridgeStarts.delete(key);
    }
  });
  pending.promise = promise;
  pendingBridgeStarts.set(key, pending);
  return promise;
}

async function getSourceIndex(sessionId: string, folderId: string): Promise<BrowserFolderSourceIndex | undefined> {
  return await idbGet<BrowserFolderSourceIndex>(SOURCE_STORE, sourceIndexKey(sessionId, folderId));
}

async function getStoredHandle(handleKey: string): Promise<FileSystemDirectoryHandle | undefined> {
  return await idbGet<FileSystemDirectoryHandle>(HANDLE_STORE, handleKey);
}

export async function cleanupOrphanBrowserFolderHandles(): Promise<number> {
  const [handleKeys, sourceIndexes] = await Promise.all([
    idbGetAllKeys(HANDLE_STORE),
    idbGetAll<unknown>(SOURCE_STORE),
  ]);
  const currentOriginPrefix = `${originPrefix()}:`;
  const referencedHandleKeys = new Set(
    sourceIndexes.map(sourceIndexHandleKey).filter((key): key is string => key !== null),
  );
  let deleted = 0;
  for (const key of handleKeys) {
    if (typeof key !== "string") continue;
    if (!key.startsWith(currentOriginPrefix)) continue;
    if (referencedHandleKeys.has(key)) continue;
    await idbDelete(HANDLE_STORE, key);
    deleted += 1;
  }
  return deleted;
}

export async function pickBrowserFolderSource(sessionId: string): Promise<PickedBrowserFolderSource> {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前浏览器不支持本地文件夹访问");
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
  const permission = await requestReadPermission(handle);
  if (permission !== "granted") throw new Error("未获得文件夹读取权限");
  const browserHandleKey = newHandleKey(sessionId);
  const clientSourceId = newClientSourceId();
  await cleanupOrphanBrowserFolderHandles();
  return { handle, name: handle.name, browserHandleKey, clientSourceId };
}

export async function rememberAttachedBrowserFolderSource(args: {
  sessionId: string;
  folderId: string;
  picked: PickedBrowserFolderSource;
}): Promise<void> {
  const index: BrowserFolderSourceIndex = {
    key: sourceIndexKey(args.sessionId, args.folderId),
    sessionId: args.sessionId,
    folderId: args.folderId,
    handleKey: args.picked.browserHandleKey,
    clientId: args.picked.clientSourceId,
    name: args.picked.name,
    updatedAt: new Date().toISOString(),
  };
  await idbPut(SOURCE_STORE, index.key, index);
  await idbPut(HANDLE_STORE, args.picked.browserHandleKey, args.picked.handle);
  await cleanupOrphanBrowserFolderHandles();
  await startBridge({
    sessionId: args.sessionId,
    folderId: args.folderId,
    clientId: args.picked.clientSourceId,
    handle: args.picked.handle,
  });
}

export async function ensureBrowserFolderBridge(source: FolderSource): Promise<BrowserBridgeStatus> {
  if (source.provider !== "browser-fs-access") return { status: "connected", error: null };
  const index = await getSourceIndex(source.sessionId, source.id);
  if (!index) {
    return { status: "permission_required", error: "此浏览器缺少文件夹授权记录，请断开后重新连接" };
  }
  const handle = await getStoredHandle(index.handleKey);
  if (!handle) {
    return { status: "permission_required", error: "此浏览器缺少文件夹授权记录，请断开后重新连接" };
  }
  const permission = await queryReadPermission(handle);
  if (permission !== "granted") {
    return { status: "permission_required", error: "需要重新授权浏览器读取这个文件夹" };
  }
  try {
    await startBridge({
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: index.clientId,
      handle,
    });
    return { status: "connected", error: null };
  } catch (error) {
    return { status: "error", error: browserBridgeErrorMessage(error) };
  }
}

export async function requestBrowserFolderPermission(source: FolderSource): Promise<BrowserBridgeStatus> {
  if (source.provider !== "browser-fs-access") return { status: "connected", error: null };
  const index = await getSourceIndex(source.sessionId, source.id);
  if (!index) {
    return { status: "missing", error: "此浏览器缺少文件夹授权记录，请断开后重新连接" };
  }
  const handle = await getStoredHandle(index.handleKey);
  if (!handle) {
    return { status: "missing", error: "此浏览器缺少文件夹授权记录，请断开后重新连接" };
  }
  const permission = await requestReadPermission(handle);
  if (permission !== "granted") {
    return { status: "permission_required", error: "未获得文件夹读取权限" };
  }
  try {
    await startBridge({
      sessionId: source.sessionId,
      folderId: source.id,
      clientId: index.clientId,
      handle,
    });
    return { status: "connected", error: null };
  } catch (error) {
    return { status: "error", error: browserBridgeErrorMessage(error) };
  }
}

export function stopBrowserFolderBridge(sessionId: string, folderId: string): void {
  const key = bridgeKey(sessionId, folderId);
  const pending = pendingBridgeStarts.get(key);
  if (pending) pending.cancelled = true;
  const bridge = activeBridges.get(key);
  if (!bridge) return;
  void closeActiveBridge(key, bridge);
}

export async function forgetBrowserFolderSource(sessionId: string, folderId: string): Promise<void> {
  stopBrowserFolderBridge(sessionId, folderId);
  const index = await getSourceIndex(sessionId, folderId);
  if (index) {
    await idbDelete(SOURCE_STORE, index.key);
    await idbDelete(HANDLE_STORE, index.handleKey);
  }
  await cleanupOrphanBrowserFolderHandles();
}
