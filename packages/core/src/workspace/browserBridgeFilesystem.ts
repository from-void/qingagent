import type {
  CopyOptions,
  FileContent,
  FileEntry,
  FileStat,
  FilesystemInfo,
  ListOptions,
  ReadOptions,
  RemoveOptions,
  WorkspaceFilesystem,
  WriteOptions,
} from "@mastra/core/workspace";
import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";

export type BrowserFolderBridgeOperation = "stat" | "readdir" | "readFile";

export interface BrowserFolderBridgeRequest {
  requestId: string;
  sessionId: string;
  folderId: string;
  clientId: string;
  op: BrowserFolderBridgeOperation;
  relPath: string;
  maxBytes?: number;
}

export interface BrowserFolderBridgeStat {
  name: string;
  type: "file" | "directory";
  size: number;
  createdAt: string;
  modifiedAt: string;
  mimeType?: string;
}

export interface BrowserFolderBridgeEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

type BrowserFolderBridgeSuccessResponse =
  | { ok: true; op: "stat"; stat: BrowserFolderBridgeStat }
  | { ok: true; op: "readdir"; entries: BrowserFolderBridgeEntry[] }
  | { ok: true; op: "readFile"; bytes: Uint8Array };

export const BROWSER_FOLDER_BRIDGE_FAILURE_REASON_CODES = [
  "not_found",
  "permission_denied",
  "too_large",
  "unknown",
] as const;

export type BrowserFolderBridgeFailureReasonCode =
  typeof BROWSER_FOLDER_BRIDGE_FAILURE_REASON_CODES[number];

export type BrowserFolderBridgeResponse =
  | BrowserFolderBridgeSuccessResponse
  | {
      ok: false;
      reasonCode?: BrowserFolderBridgeFailureReasonCode;
      /** 兼容旧客户端；核心层始终丢弃该字段，不得向上透传。 */
      error?: string;
    };

export interface BrowserFolderBridgeBoundResponse {
  sessionId: string;
  folderId: string;
  clientId: string;
  response: BrowserFolderBridgeResponse;
}

export class BrowserFolderBridgeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "bridge_offline"
      | "timeout"
      | "protocol_error"
      | "read_only"
      | "not_found"
      | "permission_denied"
      | "too_large"
      | "client_error",
  ) {
    super(message);
    this.name = "BrowserFolderBridgeError";
  }
}

interface BrowserBridgeConnection {
  send(request: BrowserFolderBridgeRequest): Promise<void>;
  closed: boolean;
}

interface PendingRequest {
  request: BrowserFolderBridgeRequest;
  resolve: (response: BrowserFolderBridgeSuccessResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  firstConnectionGraceTimer?: ReturnType<typeof setTimeout>;
  deliveryConnection?: BrowserBridgeConnection;
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
const DEFAULT_FIRST_CONNECTION_GRACE_MS = 3_000;
const DEFAULT_READ_MAX_BYTES = 50 * 1024 * 1024 + 1;
const CLIENT_FAILURE_MESSAGE = "browser folder request failed";
const CLIENT_FAILURES: Record<
  BrowserFolderBridgeFailureReasonCode,
  { code: BrowserFolderBridgeError["code"]; message: string }
> = {
  not_found: {
    code: "not_found",
    message: "browser folder entry was not found",
  },
  permission_denied: {
    code: "permission_denied",
    message: "browser folder permission was denied",
  },
  too_large: {
    code: "too_large",
    message: "browser folder file exceeds the size limit",
  },
  unknown: {
    code: "client_error",
    message: CLIENT_FAILURE_MESSAGE,
  },
};

const sourceKeys = new Set<string>();
const detachedSourceKeys = new Set<string>();
const sourceClients = new Map<string, Map<string, number>>();
const clientSources = new Map<string, Set<string>>();
const connections = new Map<string, Set<BrowserBridgeConnection>>();
const clientsWithSeenConnection = new Set<string>();
const queuedRequests = new Map<string, BrowserFolderBridgeRequest[]>();
const pendingRequests = new Map<string, PendingRequest>();

function sourceKey(sessionId: string, folderId: string): string {
  return `${sessionId}\0${folderId}`;
}

function clientKey(sessionId: string, clientId: string): string {
  return `${sessionId}\0${clientId}`;
}

function sourceOfflineError(sessionId: string, folderId: string): BrowserFolderBridgeError {
  const message = detachedSourceKeys.has(sourceKey(sessionId, folderId))
    ? "browser folder source was detached"
    : "browser folder source is not registered";
  return new BrowserFolderBridgeError(message, "bridge_offline");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeRelPath(path: string, allowRoot: boolean): string {
  if (typeof path !== "string") throw new Error("invalid_path: path must be a string");
  if (path.includes("\0") || path.includes("\\")) {
    throw new Error("invalid_path: path must be a POSIX workspace path");
  }
  if (/^[a-zA-Z]:/.test(path) || path.startsWith("//")) {
    throw new Error("invalid_path: unsafe absolute path");
  }
  if (path === "" || path === "." || path === "/") {
    if (allowRoot) return "";
    throw new Error("invalid_path: path must point to a file");
  }
  const relativePath = path.startsWith("/") ? path.slice(1) : path;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid_path: unsafe path segment");
  }
  return parts.join("/");
}

function virtualPathFor(source: FolderSourceRecord, relPath: string): string {
  return relPath ? `${source.mountPath}/${relPath}` : source.mountPath;
}

function basenameOf(relPath: string, fallback: string): string {
  if (!relPath) return fallback;
  return relPath.split("/").filter(Boolean).pop() ?? fallback;
}

function validateStat(value: BrowserFolderBridgeStat): BrowserFolderBridgeStat {
  if (!nonEmptyString(value.name)) throw new Error("protocol_error: stat.name is invalid");
  if (value.type !== "file" && value.type !== "directory") {
    throw new Error("protocol_error: stat.type is invalid");
  }
  if (!Number.isFinite(value.size) || value.size < 0) {
    throw new Error("protocol_error: stat.size is invalid");
  }
  if (!nonEmptyString(value.createdAt) || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("protocol_error: stat.createdAt is invalid");
  }
  if (!nonEmptyString(value.modifiedAt) || Number.isNaN(Date.parse(value.modifiedAt))) {
    throw new Error("protocol_error: stat.modifiedAt is invalid");
  }
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") {
    throw new Error("protocol_error: stat.mimeType is invalid");
  }
  return value;
}

function validateEntries(entries: BrowserFolderBridgeEntry[]): BrowserFolderBridgeEntry[] {
  if (!Array.isArray(entries)) throw new Error("protocol_error: entries must be an array");
  return entries.map((entry) => {
    if (!nonEmptyString(entry.name)) throw new Error("protocol_error: entry.name is invalid");
    if (entry.name.includes("/") || entry.name.includes("\\") || entry.name === "." || entry.name === "..") {
      throw new Error("protocol_error: entry.name is unsafe");
    }
    if (entry.type !== "file" && entry.type !== "directory") {
      throw new Error("protocol_error: entry.type is invalid");
    }
    if (
      entry.size !== undefined &&
      (!Number.isFinite(entry.size) || entry.size < 0)
    ) {
      throw new Error("protocol_error: entry.size is invalid");
    }
    return entry;
  });
}

function mapBridgeError(error: unknown): BrowserFolderBridgeError {
  if (error instanceof BrowserFolderBridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("protocol_error:")) {
    return new BrowserFolderBridgeError(message, "protocol_error");
  }
  return new BrowserFolderBridgeError(message, "bridge_offline");
}

function sourceClientRefs(sessionId: string, folderId: string): Map<string, number> | undefined {
  return sourceClients.get(sourceKey(sessionId, folderId));
}

function addClientSource(sessionId: string, folderId: string, clientId: string): void {
  const key = clientKey(sessionId, clientId);
  const folderIds = clientSources.get(key) ?? new Set<string>();
  folderIds.add(folderId);
  clientSources.set(key, folderIds);
}

function connectionCountForClient(sessionId: string, clientId: string): number {
  return connections.get(clientKey(sessionId, clientId))?.size ?? 0;
}

function clientHadConnection(sessionId: string, clientId: string): boolean {
  return clientsWithSeenConnection.has(clientKey(sessionId, clientId));
}

function readFirstConnectionGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw =
    env.QINGAGENT_BROWSER_FOLDER_BRIDGE_ATTACH_GRACE_MS ??
    env.QINGAGENT_BROWSER_FOLDER_BRIDGE_FIRST_CONNECTION_GRACE_MS;
  if (raw === undefined) return DEFAULT_FIRST_CONNECTION_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FIRST_CONNECTION_GRACE_MS;
  return Math.floor(parsed);
}

function selectBrowserFolderClient(
  sessionId: string,
  folderId: string,
  preferredClientId?: string,
): string | null {
  const connectedClientId = selectConnectedBrowserFolderClient(
    sessionId,
    folderId,
    preferredClientId,
  );
  if (connectedClientId) return connectedClientId;
  if (detachedSourceKeys.has(sourceKey(sessionId, folderId))) return null;
  const clients = sourceClientRefs(sessionId, folderId);
  if (!clients || clients.size === 0) return null;
  const ordered = [...clients.keys()];
  if (preferredClientId && clients.has(preferredClientId) && clientHadConnection(sessionId, preferredClientId)) {
    return preferredClientId;
  }
  for (const clientId of ordered.slice().reverse()) {
    if (clientHadConnection(sessionId, clientId)) return clientId;
  }
  return null;
}

function selectConnectedBrowserFolderClient(
  sessionId: string,
  folderId: string,
  preferredClientId?: string,
): string | null {
  if (detachedSourceKeys.has(sourceKey(sessionId, folderId))) return null;
  const clients = sourceClientRefs(sessionId, folderId);
  if (!clients || clients.size === 0) return null;
  const ordered = [...clients.keys()];
  if (
    preferredClientId &&
    clients.has(preferredClientId) &&
    connectionCountForClient(sessionId, preferredClientId) > 0
  ) {
    return preferredClientId;
  }
  for (const clientId of ordered.slice().reverse()) {
    if (connectionCountForClient(sessionId, clientId) > 0) return clientId;
  }
  return null;
}

function selectRegisteredBrowserFolderClient(
  sessionId: string,
  folderId: string,
  preferredClientId?: string,
): string | null {
  if (detachedSourceKeys.has(sourceKey(sessionId, folderId))) return null;
  const clients = sourceClientRefs(sessionId, folderId);
  if (!clients || clients.size === 0) return null;
  if (preferredClientId && clients.has(preferredClientId)) return preferredClientId;
  return [...clients.keys()].at(-1) ?? null;
}

function queueRequest(request: BrowserFolderBridgeRequest): void {
  if (!isBrowserFolderSourceRegistered(request.sessionId, request.folderId, request.clientId)) return;
  const key = clientKey(request.sessionId, request.clientId);
  const queue = queuedRequests.get(key) ?? [];
  if (queue.some((queued) => queued.requestId === request.requestId)) return;
  queue.push(request);
  queuedRequests.set(key, queue);
}

async function deliverRequest(request: BrowserFolderBridgeRequest): Promise<boolean> {
  if (!isBrowserFolderSourceRegistered(request.sessionId, request.folderId, request.clientId)) return false;
  const key = clientKey(request.sessionId, request.clientId);
  const set = connections.get(key);
  if (!set || set.size === 0) return false;
  for (const connection of [...set]) {
    if (connection.closed) continue;
    const pending = pendingRequests.get(request.requestId);
    if (!pending) return false;
    if (pending.deliveryConnection) return true;
    pending.deliveryConnection = connection;
    try {
      await connection.send(request);
      return true;
    } catch {
      disconnectBrowserBridgeConnection(
        request.sessionId,
        request.clientId,
        connection,
      );
      return true;
    }
  }
  if (set.size === 0) connections.delete(key);
  return false;
}

function disconnectBrowserBridgeConnection(
  sessionId: string,
  clientId: string,
  connection: BrowserBridgeConnection,
): void {
  if (connection.closed) return;
  connection.closed = true;
  const key = clientKey(sessionId, clientId);
  const current = connections.get(key);
  current?.delete(connection);
  if (current?.size === 0) connections.delete(key);

  for (const [requestId, pending] of [...pendingRequests]) {
    if (pending.deliveryConnection !== connection) continue;
    pending.deliveryConnection = undefined;
    removeQueuedRequest(requestId);
    clearPendingFirstConnectionGraceTimer(requestId);
    const nextClientId = selectConnectedBrowserFolderClient(
      pending.request.sessionId,
      pending.request.folderId,
    );
    if (!nextClientId) {
      rejectPendingRequest(
        requestId,
        new BrowserFolderBridgeError("browser folder bridge disconnected", "bridge_offline"),
      );
      continue;
    }
    pending.request = { ...pending.request, clientId: nextClientId };
    queueRequest(pending.request);
    void flushClientQueue(pending.request.sessionId, nextClientId);
  }
}

async function flushClientQueue(sessionId: string, clientId: string): Promise<void> {
  const key = clientKey(sessionId, clientId);
  const queue = queuedRequests.get(key);
  if (!queue || queue.length === 0) return;
  queuedRequests.delete(key);
  const remaining: BrowserFolderBridgeRequest[] = [];
  for (const request of queue) {
    if (!pendingRequests.has(request.requestId)) continue;
    if (!isBrowserFolderSourceRegistered(request.sessionId, request.folderId, request.clientId)) {
      rejectPendingRequest(request.requestId, sourceOfflineError(request.sessionId, request.folderId));
      continue;
    }
    if (await deliverRequest(request)) {
      clearPendingFirstConnectionGraceTimer(request.requestId);
    } else {
      remaining.push(request);
    }
  }
  if (remaining.length > 0) {
    const existing = queuedRequests.get(key) ?? [];
    const seen = new Set(existing.map((request) => request.requestId));
    const merged = [
      ...remaining.filter((request) => {
        if (seen.has(request.requestId)) return false;
        seen.add(request.requestId);
        return true;
      }),
      ...existing,
    ];
    queuedRequests.set(key, merged);
    if ((connections.get(key)?.size ?? 0) > 0) {
      queueMicrotask(() => {
        void flushClientQueue(sessionId, clientId);
      });
    }
  }
}

function removeQueuedRequest(requestId: string): void {
  for (const [key, queue] of queuedRequests) {
    const next = queue.filter((request) => request.requestId !== requestId);
    if (next.length > 0) queuedRequests.set(key, next);
    else queuedRequests.delete(key);
  }
}

function clearPendingTimers(pending: PendingRequest): void {
  clearTimeout(pending.timer);
  if (pending.firstConnectionGraceTimer) clearTimeout(pending.firstConnectionGraceTimer);
}

function clearPendingFirstConnectionGraceTimer(requestId: string): void {
  const pending = pendingRequests.get(requestId);
  if (!pending?.firstConnectionGraceTimer) return;
  clearTimeout(pending.firstConnectionGraceTimer);
  pending.firstConnectionGraceTimer = undefined;
}

function rejectPendingRequest(requestId: string, error: Error): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  clearPendingTimers(pending);
  pendingRequests.delete(requestId);
  removeQueuedRequest(requestId);
  pending.reject(error);
  return true;
}

function rejectPendingRequestsForSource(sessionId: string, folderId: string, error: Error): void {
  for (const [requestId, pending] of [...pendingRequests]) {
    if (pending.request.sessionId === sessionId && pending.request.folderId === folderId) {
      rejectPendingRequest(requestId, error);
    }
  }
}

function removeClientSource(sessionId: string, folderId: string, clientId: string): void {
  const key = clientKey(sessionId, clientId);
  const folderIds = clientSources.get(key);
  if (!folderIds) return;
  folderIds.delete(folderId);
  if (folderIds.size === 0) clientSources.delete(key);
}

function requeuePendingRequestsForBinding(
  sessionId: string,
  folderId: string,
  oldClientId: string,
): void {
  for (const [requestId, pending] of [...pendingRequests]) {
    if (
      pending.request.sessionId !== sessionId ||
      pending.request.folderId !== folderId ||
      pending.request.clientId !== oldClientId
    ) {
      continue;
    }
    removeQueuedRequest(requestId);
    const nextClientId = selectBrowserFolderClient(sessionId, folderId);
    if (!nextClientId) {
      rejectPendingRequest(requestId, sourceOfflineError(sessionId, folderId));
      continue;
    }
    pending.request = { ...pending.request, clientId: nextClientId };
    queueRequest(pending.request);
    void flushClientQueue(sessionId, nextClientId);
  }
}

export function browserFolderSourcesEnabled(): boolean {
  return process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES === "1";
}

export function registerBrowserFolderSource(
  sessionId: string,
  folderId: string,
  clientId: string,
  options?: { reviveDetached?: boolean },
): boolean {
  if (!nonEmptyString(sessionId) || !nonEmptyString(folderId) || !nonEmptyString(clientId)) return false;
  const keyForSource = sourceKey(sessionId, folderId);
  if (detachedSourceKeys.has(keyForSource)) {
    if (!options?.reviveDetached) return false;
    detachedSourceKeys.delete(keyForSource);
  }
  sourceKeys.add(keyForSource);
  const clients = sourceClients.get(keyForSource) ?? new Map<string, number>();
  const nextRefCount = (clients.get(clientId) ?? 0) + 1;
  if (clients.has(clientId)) clients.delete(clientId);
  clients.set(clientId, nextRefCount);
  sourceClients.set(keyForSource, clients);
  addClientSource(sessionId, folderId, clientId);
  return true;
}

export function isBrowserFolderSourceRegistered(
  sessionId: string,
  folderId: string,
  clientId?: string,
): boolean {
  if (detachedSourceKeys.has(sourceKey(sessionId, folderId))) return false;
  const keyForSource = sourceKey(sessionId, folderId);
  if (!sourceKeys.has(keyForSource)) return false;
  if (clientId === undefined) return true;
  return sourceClients.get(keyForSource)?.has(clientId) === true;
}

export function isBrowserFolderBridgeClientRegistered(sessionId: string, clientId: string): boolean {
  const folderIds = clientSources.get(clientKey(sessionId, clientId));
  if (!folderIds || folderIds.size === 0) return false;
  for (const folderId of folderIds) {
    if (isBrowserFolderSourceRegistered(sessionId, folderId, clientId)) return true;
  }
  return false;
}

export function getBrowserFolderBridgeClientFolderIds(sessionId: string, clientId: string): string[] {
  const folderIds = clientSources.get(clientKey(sessionId, clientId));
  if (!folderIds || folderIds.size === 0) return [];
  return [...folderIds].filter((folderId) =>
    isBrowserFolderSourceRegistered(sessionId, folderId, clientId),
  );
}

export function unregisterBrowserFolderSource(
  sessionId: string,
  folderId: string,
  clientId?: string,
): boolean {
  if (!nonEmptyString(sessionId) || !nonEmptyString(folderId)) return false;
  if (clientId !== undefined && !nonEmptyString(clientId)) return false;
  const keyForSource = sourceKey(sessionId, folderId);
  const clients = sourceClients.get(keyForSource);
  if (clientId !== undefined) {
    if (!clients) return false;
    const refCount = clients.get(clientId);
    if (refCount === undefined) return false;
    if (refCount > 1) {
      clients.set(clientId, refCount - 1);
      return true;
    }
    if (connectionCountForClient(sessionId, clientId) > 0) {
      return true;
    }
    clients.delete(clientId);
    removeClientSource(sessionId, folderId, clientId);
    if (clients.size === 0) {
      sourceClients.delete(keyForSource);
      sourceKeys.delete(keyForSource);
      rejectPendingRequestsForSource(
        sessionId,
        folderId,
        sourceOfflineError(sessionId, folderId),
      );
    } else {
      requeuePendingRequestsForBinding(sessionId, folderId, clientId);
    }
    return true;
  }

  detachedSourceKeys.add(keyForSource);
  sourceKeys.delete(keyForSource);
  sourceClients.delete(keyForSource);
  if (clients) {
    for (const currentClientId of clients.keys()) {
      removeClientSource(sessionId, folderId, currentClientId);
    }
  } else {
    for (const [key, folderIds] of clientSources) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      folderIds.delete(folderId);
      if (folderIds.size === 0) clientSources.delete(key);
    }
  }
  rejectPendingRequestsForSource(
    sessionId,
    folderId,
    new BrowserFolderBridgeError("browser folder source was detached", "bridge_offline"),
  );
  return true;
}

export function unregisterBrowserFolderSession(sessionId: string): void {
  for (const key of [...sourceKeys]) {
    if (key.startsWith(`${sessionId}\0`)) sourceKeys.delete(key);
  }
  for (const key of [...detachedSourceKeys]) {
    if (key.startsWith(`${sessionId}\0`)) detachedSourceKeys.delete(key);
  }
  for (const key of [...sourceClients.keys()]) {
    if (key.startsWith(`${sessionId}\0`)) sourceClients.delete(key);
  }
  for (const key of [...clientSources.keys()]) {
    if (key.startsWith(`${sessionId}\0`)) clientSources.delete(key);
  }
  for (const key of [...connections.keys()]) {
    if (key.startsWith(`${sessionId}\0`)) connections.delete(key);
  }
  for (const key of [...clientsWithSeenConnection]) {
    if (key.startsWith(`${sessionId}\0`)) clientsWithSeenConnection.delete(key);
  }
  for (const key of [...queuedRequests.keys()]) {
    if (key.startsWith(`${sessionId}\0`)) queuedRequests.delete(key);
  }
  for (const [requestId, pending] of pendingRequests) {
    if (pending.request.sessionId === sessionId) {
      clearPendingTimers(pending);
      pendingRequests.delete(requestId);
      pending.reject(new BrowserFolderBridgeError("browser folder session was unregistered", "bridge_offline"));
    }
  }
}

export function getBrowserFolderBridgePendingRequest(requestId: string): BrowserFolderBridgeRequest | null {
  const pending = pendingRequests.get(requestId);
  return pending ? { ...pending.request } : null;
}

export function openBrowserFolderBridgeConnection(args: {
  sessionId: string;
  clientId: string;
  send: (request: BrowserFolderBridgeRequest) => Promise<void>;
}): () => void {
  const key = clientKey(args.sessionId, args.clientId);
  const connection: BrowserBridgeConnection = { send: args.send, closed: false };
  const set = connections.get(key) ?? new Set<BrowserBridgeConnection>();
  set.add(connection);
  connections.set(key, set);
  clientsWithSeenConnection.add(key);
  void flushClientQueue(args.sessionId, args.clientId);
  return () => {
    disconnectBrowserBridgeConnection(args.sessionId, args.clientId, connection);
  };
}

export async function requestBrowserFolderBridge(
  request: Omit<BrowserFolderBridgeRequest, "requestId">,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
  firstConnectionGraceMs = readFirstConnectionGraceMs(),
): Promise<BrowserFolderBridgeSuccessResponse> {
  const requestId = crypto.randomUUID();
  const targetClientId = selectBrowserFolderClient(request.sessionId, request.folderId, request.clientId);
  const registeredClientId =
    targetClientId ?? selectRegisteredBrowserFolderClient(request.sessionId, request.folderId, request.clientId);
  if (!registeredClientId) {
    throw sourceOfflineError(request.sessionId, request.folderId);
  }
  const fullRequest: BrowserFolderBridgeRequest = { ...request, clientId: registeredClientId, requestId };
  const promise = new Promise<BrowserFolderBridgeSuccessResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectPendingRequest(
        requestId,
        new BrowserFolderBridgeError("browser folder bridge request timed out", "timeout"),
      );
    }, timeoutMs);
    pendingRequests.set(requestId, {
      request: fullRequest,
      resolve,
      reject,
      timer,
    });
  });
  if (!targetClientId) {
    queueRequest(fullRequest);
    const pending = pendingRequests.get(requestId);
    if (pending) {
      pending.firstConnectionGraceTimer = setTimeout(() => {
        rejectPendingRequest(
          requestId,
          new BrowserFolderBridgeError("browser folder bridge is offline", "bridge_offline"),
        );
      }, firstConnectionGraceMs);
    }
    return promise;
  }

  if (!(await deliverRequest(fullRequest))) {
    if (isBrowserFolderSourceRegistered(fullRequest.sessionId, fullRequest.folderId, fullRequest.clientId)) {
      queueRequest(fullRequest);
    } else {
      rejectPendingRequest(requestId, sourceOfflineError(fullRequest.sessionId, fullRequest.folderId));
    }
  }
  return promise;
}

export function resolveBrowserFolderBridgeResponse(
  requestId: string,
  bound: BrowserFolderBridgeBoundResponse,
): boolean {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  const request = pending.request;
  if (
    bound.sessionId !== request.sessionId ||
    bound.folderId !== request.folderId ||
    bound.clientId !== request.clientId
  ) {
    return false;
  }
  if (!isBrowserFolderSourceRegistered(bound.sessionId, bound.folderId, bound.clientId)) {
    rejectPendingRequest(requestId, sourceOfflineError(bound.sessionId, bound.folderId));
    return false;
  }
  clearPendingTimers(pending);
  pendingRequests.delete(requestId);
  removeQueuedRequest(requestId);
  if (!bound.response.ok) {
    const failure = CLIENT_FAILURES[bound.response.reasonCode ?? "unknown"];
    pending.reject(new BrowserFolderBridgeError(failure.message, failure.code));
    return true;
  }
  try {
    if (bound.response.op !== request.op) {
      throw new Error("protocol_error: response operation does not match request");
    }
    if (bound.response.op === "stat") validateStat(bound.response.stat);
    if (bound.response.op === "readdir") validateEntries(bound.response.entries);
    if (
      bound.response.op === "readFile" &&
      typeof request.maxBytes === "number" &&
      bound.response.bytes.byteLength > request.maxBytes
    ) {
      throw new Error("protocol_error: readFile response exceeds maxBytes");
    }
    pending.resolve(bound.response);
  } catch (error) {
    pending.reject(mapBridgeError(error));
  }
  return true;
}

export function __resetBrowserFolderBridgeForTest(): void {
  sourceKeys.clear();
  detachedSourceKeys.clear();
  sourceClients.clear();
  clientSources.clear();
  connections.clear();
  clientsWithSeenConnection.clear();
  queuedRequests.clear();
  for (const pending of pendingRequests.values()) clearPendingTimers(pending);
  pendingRequests.clear();
}

export function __browserFolderBridgeStatsForTest(): {
  sources: number;
  clients: number;
  connections: number;
  queued: number;
  pending: number;
} {
  let connectionCount = 0;
  for (const set of connections.values()) connectionCount += set.size;
  let queued = 0;
  for (const queue of queuedRequests.values()) queued += queue.length;
  return {
    sources: sourceKeys.size,
    clients: clientSources.size,
    connections: connectionCount,
    queued,
    pending: pendingRequests.size,
  };
}

export class BrowserBridgeFilesystem implements WorkspaceFilesystem {
  readonly id: string;
  readonly name = "BrowserBridgeFilesystem";
  readonly provider = "browser-fs-access";
  readonly readOnly = true;
  status: WorkspaceFilesystem["status"] = "ready";
  error?: string;
  readonly basePath?: string;
  readonly displayName?: string;
  readonly description?: string;

  constructor(private readonly source: FolderSourceRecord) {
    this.id = source.id;
    this.basePath = source.mountPath;
    this.displayName = source.name;
    this.description = `只读资料库「${source.name}」`;
    if (source.browserClientSourceId) {
      registerBrowserFolderSource(source.sessionId, source.id, source.browserClientSourceId);
    }
  }

  getInstructions(): string {
    return `只读浏览器资料库「${this.source.name}」挂载在 ${this.source.mountPath}。只使用 workspace 路径，不要猜测或暴露用户本机路径。`;
  }

  getInfo(): FilesystemInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      readOnly: true,
      metadata: {
        mountPath: this.source.mountPath,
      },
    };
  }

  private clientId(): string {
    if (!this.source.browserClientSourceId) {
      throw new BrowserFolderBridgeError("browser folder client is missing", "protocol_error");
    }
    return this.source.browserClientSourceId;
  }

  private relPath(path: string, allowRoot: boolean): string {
    return normalizeRelPath(path, allowRoot);
  }

  private async bridge(
    op: "stat",
    relPath: string,
  ): Promise<Extract<BrowserFolderBridgeSuccessResponse, { op: "stat" }>>;
  private async bridge(
    op: "readdir",
    relPath: string,
  ): Promise<Extract<BrowserFolderBridgeSuccessResponse, { op: "readdir" }>>;
  private async bridge(
    op: "readFile",
    relPath: string,
  ): Promise<Extract<BrowserFolderBridgeSuccessResponse, { op: "readFile" }>>;
  private async bridge(
    op: BrowserFolderBridgeOperation,
    relPath: string,
  ): Promise<BrowserFolderBridgeSuccessResponse> {
    const response = await requestBrowserFolderBridge({
      sessionId: this.source.sessionId,
      folderId: this.source.id,
      clientId: this.clientId(),
      op,
      relPath,
      ...(op === "readFile" ? { maxBytes: DEFAULT_READ_MAX_BYTES } : {}),
    });
    return response;
  }

  private readOnlyError(): never {
    throw new BrowserFolderBridgeError("browser folder sources are read-only", "read_only");
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    const relPath = this.relPath(path, false);
    const response = await this.bridge("readFile", relPath);
    const buffer = Buffer.from(response.bytes);
    if (options?.encoding) return buffer.toString(options.encoding);
    return buffer;
  }

  async readdir(path: string, _options?: ListOptions): Promise<FileEntry[]> {
    const relPath = this.relPath(path, true);
    const response = await this.bridge("readdir", relPath);
    return validateEntries(response.entries).map((entry) => ({ ...entry }));
  }

  async stat(path: string): Promise<FileStat> {
    const relPath = this.relPath(path, true);
    const response = await this.bridge("stat", relPath);
    const stat = validateStat(response.stat);
    return {
      name: relPath ? basenameOf(relPath, stat.name) : this.source.name,
      path: virtualPathFor(this.source, relPath),
      type: stat.type,
      size: stat.type === "directory" ? 0 : stat.size,
      createdAt: new Date(stat.createdAt),
      modifiedAt: new Date(stat.modifiedAt),
      ...(stat.mimeType ? { mimeType: stat.mimeType } : {}),
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async realpath(path: string): Promise<string> {
    this.relPath(path, true);
    return path;
  }

  async writeFile(_path: string, _content: FileContent, _options?: WriteOptions): Promise<void> {
    this.readOnlyError();
  }

  async appendFile(_path: string, _content: FileContent): Promise<void> {
    this.readOnlyError();
  }

  async deleteFile(_path: string, _options?: RemoveOptions): Promise<void> {
    this.readOnlyError();
  }

  async copyFile(_src: string, _dest: string, _options?: CopyOptions): Promise<void> {
    this.readOnlyError();
  }

  async moveFile(_src: string, _dest: string, _options?: CopyOptions): Promise<void> {
    this.readOnlyError();
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.readOnlyError();
  }

  async rmdir(_path: string, _options?: RemoveOptions): Promise<void> {
    this.readOnlyError();
  }
}
