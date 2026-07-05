import type { FolderSource, FolderSourceRecord } from "@qingagent/contract-ts";
import { homedir } from "node:os";

const registry = new Map<string, FolderSourceRecord[]>();
const detachedFolderIds = new Map<string, Set<string>>();
const MAX_DETACHED_FOLDER_TOMBSTONES_PER_SESSION = 256;
const FOLDER_SOURCE_PROVIDERS = new Set(["desktop-local", "browser-fs-access"]);
const FOLDER_SOURCE_STATUSES = new Set([
  "connected",
  "offline",
  "missing",
  "permission_required",
  "error",
]);
const MOUNT_NAME_PATTERN = /^source_[a-z0-9_]+$/;

export function localFolderSourcesEnabled(): boolean {
  return (
    process.env.QINGAGENT_RUNTIME === "desktop" &&
    process.env.QINGAGENT_ENABLE_LOCAL_FOLDER_SOURCES === "1"
  );
}

export function browserFolderSourcesEnabled(): boolean {
  return process.env.QINGAGENT_ENABLE_BROWSER_FOLDER_SOURCES === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function hasAbsolutePathShape(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || /^[a-zA-Z]:\//.test(normalizeSeparators(value));
}

export function summarizeFolderPathLabel(value: string): string {
  const normalized = normalizeSeparators(value.trim());
  if (!normalized) return "";
  const home = normalizeSeparators(homedir());
  if (home && normalized === home) return "~";

  if (home && normalized.startsWith(`${home}/`)) {
    const parts = normalized.slice(home.length + 1).split("/").filter(Boolean);
    if (parts.length === 0) return "~";
    if (parts.length <= 2) return `~/${parts.join("/")}`;
    return `~/.../${parts.slice(-2).join("/")}`;
  }

  if (normalized.startsWith("~/")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    if (parts.length <= 2) return `~/${parts.join("/")}`;
    return `~/.../${parts.slice(-2).join("/")}`;
  }

  if (!hasAbsolutePathShape(normalized)) return normalized;
  const withoutDrive = normalized.replace(/^[a-zA-Z]:\//, "");
  const parts = withoutDrive.split("/").filter(Boolean);
  if (parts.length === 0) return normalized.startsWith("/") ? "/" : normalized;
  if (parts.length <= 2) return `.../${parts[parts.length - 1]}`;
  return `.../${parts.slice(-2).join("/")}`;
}

function sanitizePathLabelForWire(record: FolderSourceRecord): string | null {
  if (record.pathLabel === null) return null;
  // 上游正常会先摘要 pathLabel；这里保留兜底，防持久化旧数据或新入口误带真实路径。
  if (record.desktopRootPath && record.pathLabel.includes(record.desktopRootPath)) {
    return summarizeFolderPathLabel(record.desktopRootPath);
  }
  if (hasAbsolutePathShape(record.pathLabel)) {
    return summarizeFolderPathLabel(record.pathLabel);
  }
  return record.pathLabel;
}

export function normalizeFolderSourceRecord(value: unknown): FolderSourceRecord | null {
  if (!isRecord(value)) return null;
  const requiredFields = [
    "id",
    "sessionId",
    "provider",
    "name",
    "pathLabel",
    "mountName",
    "mountPath",
    "readOnly",
    "fileCount",
    "fileCountCapped",
    "status",
    "error",
    "createdAt",
    "updatedAt",
  ];
  if (!requiredFields.every((field) => Object.hasOwn(value, field))) return null;
  if (!nonEmptyString(value.id)) return null;
  if (!nonEmptyString(value.sessionId)) return null;
  if (!nonEmptyString(value.provider) || !FOLDER_SOURCE_PROVIDERS.has(value.provider)) return null;
  const provider = value.provider as FolderSourceRecord["provider"];
  if (!nonEmptyString(value.name)) return null;
  if (!nullableString(value.pathLabel)) return null;
  if (!nonEmptyString(value.mountName) || !MOUNT_NAME_PATTERN.test(value.mountName)) return null;
  if (!nonEmptyString(value.mountPath) || value.mountPath !== `/sources/${value.mountName}`) return null;
  if (value.readOnly !== true) return null;
  if (!nullableNonNegativeInteger(value.fileCount)) return null;
  if (typeof value.fileCountCapped !== "boolean") return null;
  if (!nonEmptyString(value.status) || !FOLDER_SOURCE_STATUSES.has(value.status)) return null;
  if (!nullableString(value.error)) return null;
  if (!nonEmptyString(value.createdAt)) return null;
  if (!nonEmptyString(value.updatedAt)) return null;
  if (
    provider === "desktop-local" &&
    (Object.hasOwn(value, "browserHandleKey") || Object.hasOwn(value, "browserClientSourceId"))
  ) {
    return null;
  }
  if (
    provider === "desktop-local" &&
    value.status === "connected" &&
    (!Object.hasOwn(value, "desktopRootPath") || !nonEmptyString(value.desktopRootPath))
  ) {
    return null;
  }
  if (provider === "browser-fs-access") {
    if (Object.hasOwn(value, "desktopRootPath")) return null;
    if (
      value.status === "connected" &&
      (
        !Object.hasOwn(value, "browserHandleKey") ||
        !nonEmptyString(value.browserHandleKey) ||
        !Object.hasOwn(value, "browserClientSourceId") ||
        !nonEmptyString(value.browserClientSourceId)
      )
    ) {
      return null;
    }
  }

  const record: FolderSourceRecord = {
    id: value.id,
    sessionId: value.sessionId,
    provider,
    name: value.name,
    pathLabel: value.pathLabel,
    mountName: value.mountName,
    mountPath: value.mountPath,
    readOnly: true,
    fileCount: value.fileCount,
    fileCountCapped: value.fileCountCapped,
    status: value.status as FolderSourceRecord["status"],
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (
    provider === "desktop-local" &&
    Object.hasOwn(value, "desktopRootPath") &&
    typeof value.desktopRootPath === "string" &&
    value.desktopRootPath.length > 0
  ) {
    record.desktopRootPath = value.desktopRootPath;
  }
  if (
    provider === "browser-fs-access" &&
    Object.hasOwn(value, "browserHandleKey") &&
    typeof value.browserHandleKey === "string" &&
    value.browserHandleKey.length > 0
  ) {
    record.browserHandleKey = value.browserHandleKey;
  }
  if (
    provider === "browser-fs-access" &&
    Object.hasOwn(value, "browserClientSourceId") &&
    typeof value.browserClientSourceId === "string" &&
    value.browserClientSourceId.length > 0
  ) {
    record.browserClientSourceId = value.browserClientSourceId;
  }
  return record;
}

export function normalizeFolderSourceRecords(sources: Iterable<unknown>): FolderSourceRecord[] {
  const normalized: FolderSourceRecord[] = [];
  const seenMountNames = new Set<string>();
  for (const source of sources) {
    const record = normalizeFolderSourceRecord(source);
    if (!record || seenMountNames.has(record.mountName)) continue;
    seenMountNames.add(record.mountName);
    normalized.push(record);
  }
  return normalized;
}

export function toFolderSourceWire(record: FolderSourceRecord): FolderSource {
  const {
    desktopRootPath: _desktopRootPath,
    browserHandleKey: _browserHandleKey,
    browserClientSourceId: _browserClientSourceId,
    ...wire
  } = record;
  return { ...wire, pathLabel: sanitizePathLabelForWire(record) };
}

export function getSessionFolderSources(sessionId: string): FolderSourceRecord[] {
  return registry.get(sessionId)?.map((source) => ({ ...source })) ?? [];
}

export function getRegisteredFolderSourceHostRoots(): string[] {
  const roots = new Set<string>();
  for (const sources of registry.values()) {
    for (const source of sources) {
      if (
        source.provider === "desktop-local" &&
        source.status === "connected" &&
        typeof source.desktopRootPath === "string" &&
        source.desktopRootPath.length > 0
      ) {
        roots.add(source.desktopRootPath);
      }
    }
  }
  return [...roots];
}

export function registerSessionFolderSources(
  sessionId: string,
  sources: Iterable<FolderSourceRecord>,
): void {
  const normalized = normalizeFolderSourceRecords(sources).filter((source) => {
    if (source.sessionId === sessionId) return true;
    console.warn("[folderSources/runtime] skip source with mismatched sessionId", {
      sessionId,
      sourceId: source.id,
      sourceSessionId: source.sessionId,
      provider: source.provider,
    });
    return false;
  });
  registry.set(sessionId, normalized);
  if (normalized.length === 0) {
    const detached = detachedFolderIds.get(sessionId);
    detached?.clear();
    detachedFolderIds.delete(sessionId);
    return;
  }
  const detached = detachedFolderIds.get(sessionId);
  if (detached) {
    for (const source of normalized) detached.delete(source.id);
    if (detached.size === 0) detachedFolderIds.delete(sessionId);
  }
}

export function unregisterSessionFolderSources(sessionId: string): void {
  registry.delete(sessionId);
  detachedFolderIds.delete(sessionId);
}

export function folderSourcesToWire(sources: Iterable<FolderSourceRecord>): FolderSource[] {
  return normalizeFolderSourceRecords(sources).map(toFolderSourceWire);
}

export function markFolderSourceDetached(sessionId: string, folderId: string): void {
  const detached = detachedFolderIds.get(sessionId) ?? new Set<string>();
  if (detached.has(folderId)) detached.delete(folderId);
  detached.add(folderId);
  while (detached.size > MAX_DETACHED_FOLDER_TOMBSTONES_PER_SESSION) {
    const oldest = detached.values().next().value as string | undefined;
    if (oldest === undefined) break;
    detached.delete(oldest);
  }
  detachedFolderIds.set(sessionId, detached);
}

export function isFolderSourceCacheActive(sessionId: string, folderId: string): boolean {
  if (detachedFolderIds.get(sessionId)?.has(folderId)) return false;
  const sources = registry.get(sessionId);
  if (sources === undefined) return true;
  return sources.some((source) => source.id === folderId && source.status === "connected");
}

export function __resetFolderSourceRuntimeForTest(): void {
  registry.clear();
  detachedFolderIds.clear();
}

export function __folderSourceRuntimeStatsForTest(): {
  sessions: number;
  detachedSessions: number;
  detachedSizes: Record<string, number>;
} {
  return {
    sessions: registry.size,
    detachedSessions: detachedFolderIds.size,
    detachedSizes: Object.fromEntries(
      [...detachedFolderIds.entries()].map(([sessionId, ids]) => [sessionId, ids.size]),
    ),
  };
}
