import type { FolderSourceRecord } from "@qingagent/contract-ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QINGAGENT_DATA_DIR, sessionWorkspaceDirName } from "../workspace/sessionWorkspace.js";
import { isFolderSourceCacheActive } from "./runtime.js";

export const FOLDER_SOURCE_PARSER_VERSION = "parseFileBuffer:v3";

export interface ParsedDocumentMetadata {
  pages: number | null;
  wordCount: number;
  title: string | null;
  indexable?: boolean;
}

export interface FolderSourceCacheEntry {
  folderId: string;
  relPath: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  contentSha256: string;
  parserVersion: string;
  metadata: ParsedDocumentMetadata;
  parsedFile: string;
  lastAccessAt: string;
}

interface FolderSourceManifest {
  version: 1;
  sessionId: string;
  folderId: string;
  entries: Record<string, FolderSourceCacheEntry>;
}

export interface CacheLookupHit {
  kind: "hit";
  manifest: FolderSourceManifest;
  entry: FolderSourceCacheEntry;
  text: string;
}

export interface CacheLookupMiss {
  kind: "miss";
  manifest: FolderSourceManifest;
  entry?: FolderSourceCacheEntry;
}

const DEFAULT_TOTAL_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_SESSION_CACHE_BYTES = 64 * 1024 * 1024;
const manifestLocks = new Map<string, Promise<void>>();
const manifestCache = new Map<string, FolderSourceManifest>();
const dirtyManifestKeys = new Set<string>();

function positiveBytesEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function folderCacheRoot(sessionId: string, folderId?: string): string {
  const base = join(QINGAGENT_DATA_DIR, "folder-source-cache", sessionWorkspaceDirName(sessionId));
  return folderId ? join(base, safePathSegment(folderId)) : base;
}

function manifestPath(sessionId: string, folderId: string): string {
  return join(folderCacheRoot(sessionId, folderId), "manifest.json");
}

function parsedDir(sessionId: string, folderId: string): string {
  return join(folderCacheRoot(sessionId, folderId), "parsed");
}

function safePathSegment(value: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(value) && value.length > 0) return value;
  return createHash("sha256").update(value).digest("hex");
}

function manifestLockKey(sessionId: string, folderId: string): string {
  return `${safePathSegment(sessionId)}:${safePathSegment(folderId)}`;
}

function cacheKey(sessionId: string, folderId: string): string {
  return manifestLockKey(sessionId, folderId);
}

async function withManifestLock<T>(
  sessionId: string,
  folderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = manifestLockKey(sessionId, folderId);
  const previous = manifestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  manifestLocks.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (manifestLocks.get(key) === next) {
      manifestLocks.delete(key);
    }
  }
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readManifest(sessionId: string, folderId: string): Promise<FolderSourceManifest> {
  const key = cacheKey(sessionId, folderId);
  const cached = manifestCache.get(key);
  if (dirtyManifestKeys.has(key) && cached) return cached;
  try {
    const raw = await readFile(manifestPath(sessionId, folderId), "utf8");
    const parsed = JSON.parse(raw) as Partial<FolderSourceManifest>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return {
        version: 1,
        sessionId,
        folderId,
        entries: parsed.entries as Record<string, FolderSourceCacheEntry>,
      };
    }
  } catch {
    // 缓存是派生数据，损坏或缺失时直接重建。
  }
  return { version: 1, sessionId, folderId, entries: {} };
}

async function writeManifest(manifest: FolderSourceManifest): Promise<void> {
  const file = manifestPath(manifest.sessionId, manifest.folderId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2), "utf8");
  const key = cacheKey(manifest.sessionId, manifest.folderId);
  manifestCache.delete(key);
  dirtyManifestKeys.delete(key);
}

function markManifestDirty(manifest: FolderSourceManifest): void {
  const key = cacheKey(manifest.sessionId, manifest.folderId);
  manifestCache.set(key, manifest);
  dirtyManifestKeys.add(key);
}

async function readParsedText(sessionId: string, folderId: string, parsedFile: string): Promise<string> {
  return readFile(join(parsedDir(sessionId, folderId), parsedFile), "utf8");
}

export async function getCachedParsedDocument(args: {
  sessionId: string;
  folderId: string;
  relPath: string;
  size: number;
  modifiedAtMs: number;
  contentSha256?: string;
}): Promise<CacheLookupHit | CacheLookupMiss> {
  return withManifestLock(args.sessionId, args.folderId, async () => {
    if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) {
      return { kind: "miss", manifest: { version: 1, sessionId: args.sessionId, folderId: args.folderId, entries: {} } };
    }
    const manifest = await readManifest(args.sessionId, args.folderId);
    const entry = manifest.entries[args.relPath];
    if (
      entry &&
      entry.parserVersion === FOLDER_SOURCE_PARSER_VERSION &&
      entry.size === args.size &&
      entry.modifiedAtMs === args.modifiedAtMs &&
      (args.contentSha256 === undefined || entry.contentSha256 === args.contentSha256)
    ) {
      try {
        const text = await readParsedText(args.sessionId, args.folderId, entry.parsedFile);
        const nextEntry = { ...entry, lastAccessAt: new Date().toISOString() };
        manifest.entries[args.relPath] = nextEntry;
        if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) {
          return { kind: "hit", manifest, entry, text };
        }
        try {
          await writeManifest(manifest);
        } catch (error) {
          console.warn("[folderSources/cache] 更新缓存访问时间失败，继续使用已命中的解析缓存", {
            sessionId: args.sessionId,
            folderId: args.folderId,
            relPath: args.relPath,
            error,
          });
          return { kind: "hit", manifest, entry, text };
        }
        return { kind: "hit", manifest, entry: nextEntry, text };
      } catch {
        if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) {
          return { kind: "miss", manifest, entry };
        }
        delete manifest.entries[args.relPath];
        try {
          await writeManifest(manifest);
        } catch (error) {
          console.warn("[folderSources/cache] 清理损坏解析缓存 manifest 失败，按缓存未命中继续", {
            sessionId: args.sessionId,
            folderId: args.folderId,
            relPath: args.relPath,
            error,
          });
        }
      }
    }
    return { kind: "miss", manifest, entry };
  });
}

export async function putParsedDocument(args: {
  sessionId: string;
  folderId: string;
  relPath: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  contentSha256: string;
  text: string;
  metadata: ParsedDocumentMetadata;
  enforceLimits?: boolean;
  flushManifest?: boolean;
}): Promise<FolderSourceCacheEntry> {
  const result = await withManifestLock(args.sessionId, args.folderId, async () => {
    const parsedFile = `${args.contentSha256}.txt`;
    const nextEntry: FolderSourceCacheEntry = {
      folderId: args.folderId,
      relPath: args.relPath,
      path: args.path,
      size: args.size,
      modifiedAtMs: args.modifiedAtMs,
      contentSha256: args.contentSha256,
      parserVersion: FOLDER_SOURCE_PARSER_VERSION,
      metadata: args.metadata,
      parsedFile,
      lastAccessAt: new Date().toISOString(),
    };
    if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) {
      return { entry: nextEntry, wrote: false };
    }
    const manifest = await readManifest(args.sessionId, args.folderId);
    const dir = parsedDir(args.sessionId, args.folderId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, parsedFile), args.text, "utf8");
    manifest.entries[args.relPath] = nextEntry;
    if (args.flushManifest === false) {
      markManifestDirty(manifest);
    } else {
      await writeManifest(manifest);
    }
    return { entry: nextEntry, wrote: true };
  });
  if (result.wrote && args.enforceLimits !== false) await enforceFolderSourceCacheLimits(args.sessionId);
  return result.entry;
}

export async function flushFolderSourceCacheManifest(sessionId: string, folderId: string): Promise<void> {
  await withManifestLock(sessionId, folderId, async () => {
    const key = cacheKey(sessionId, folderId);
    if (!dirtyManifestKeys.has(key)) return;
    if (!isFolderSourceCacheActive(sessionId, folderId)) {
      manifestCache.delete(key);
      dirtyManifestKeys.delete(key);
      return;
    }
    await writeManifest(await readManifest(sessionId, folderId));
  });
}

export async function reuseParsedDocumentWithNewStat(args: {
  sessionId: string;
  folderId: string;
  relPath: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  contentSha256: string;
  metadata: ParsedDocumentMetadata;
  previousParsedFile: string;
}): Promise<FolderSourceCacheEntry> {
  return withManifestLock(args.sessionId, args.folderId, async () => {
    const entry: FolderSourceCacheEntry = {
      folderId: args.folderId,
      relPath: args.relPath,
      path: args.path,
      size: args.size,
      modifiedAtMs: args.modifiedAtMs,
      contentSha256: args.contentSha256,
      parserVersion: FOLDER_SOURCE_PARSER_VERSION,
      metadata: args.metadata,
      parsedFile: args.previousParsedFile,
      lastAccessAt: new Date().toISOString(),
    };
    if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) return entry;
    const manifest = await readManifest(args.sessionId, args.folderId);
    manifest.entries[args.relPath] = entry;
    await writeManifest(manifest);
    return entry;
  });
}

export async function loadFolderSourceManifestEntries(
  sessionId: string,
  folderId: string,
): Promise<FolderSourceCacheEntry[]> {
  return withManifestLock(sessionId, folderId, async () => {
    if (!isFolderSourceCacheActive(sessionId, folderId)) return [];
    const manifest = await readManifest(sessionId, folderId);
    return Object.values(manifest.entries).sort((left, right) => left.relPath.localeCompare(right.relPath));
  });
}

export async function removeParsedDocumentCacheEntry(args: {
  sessionId: string;
  folderId: string;
  relPath: string;
}): Promise<void> {
  await withManifestLock(args.sessionId, args.folderId, async () => {
    if (!isFolderSourceCacheActive(args.sessionId, args.folderId)) return;
    const manifest = await readManifest(args.sessionId, args.folderId);
    if (!(args.relPath in manifest.entries)) return;
    delete manifest.entries[args.relPath];
    await writeManifest(manifest);
  });
}

export async function loadFolderSourceCachedText(
  sessionId: string,
  folderId: string,
  entry: FolderSourceCacheEntry,
): Promise<string> {
  return readParsedText(sessionId, folderId, entry.parsedFile);
}

export async function clearFolderSourceCache(sessionId: string, folderId: string): Promise<void> {
  await withManifestLock(sessionId, folderId, async () => {
    const key = cacheKey(sessionId, folderId);
    manifestCache.delete(key);
    dirtyManifestKeys.delete(key);
    await rm(folderCacheRoot(sessionId, folderId), { recursive: true, force: true });
  });
}

export async function clearSessionFolderSourceCache(sessionId: string): Promise<void> {
  const prefix = `${safePathSegment(sessionId)}:`;
  for (const key of [...manifestCache.keys()]) {
    if (key.startsWith(prefix)) manifestCache.delete(key);
  }
  for (const key of [...dirtyManifestKeys]) {
    if (key.startsWith(prefix)) dirtyManifestKeys.delete(key);
  }
  await rm(folderCacheRoot(sessionId), { recursive: true, force: true });
}

export async function cleanupOldFolderSourceCaches(now = Date.now()): Promise<void> {
  const root = join(QINGAGENT_DATA_DIR, "folder-source-cache");
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  let sessions: string[];
  try {
    sessions = await readdir(root);
  } catch {
    return;
  }
  for (const sessionDir of sessions) {
    const abs = join(root, sessionDir);
    try {
      const lastAccessMs = await latestSessionCacheAccessMs(abs);
      if (lastAccessMs < cutoff) {
        await rm(abs, { recursive: true, force: true });
      }
    } catch {
      // 清理失败不影响主链路。
    }
  }
}

async function latestSessionCacheAccessMs(sessionCacheDir: string): Promise<number> {
  const sessionStat = await stat(sessionCacheDir);
  let latest = sessionStat.mtimeMs;
  let folderDirs: string[];
  try {
    folderDirs = await readdir(sessionCacheDir);
  } catch {
    return latest;
  }

  for (const folderDir of folderDirs) {
    const file = join(sessionCacheDir, folderDir, "manifest.json");
    try {
      const manifestStat = await stat(file);
      latest = Math.max(latest, manifestStat.mtimeMs);
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<FolderSourceManifest>;
      if (!parsed.entries || typeof parsed.entries !== "object") continue;
      for (const entry of Object.values(parsed.entries as Record<string, Partial<FolderSourceCacheEntry>>)) {
        const accessMs = Date.parse(String(entry.lastAccessAt ?? ""));
        if (Number.isFinite(accessMs)) latest = Math.max(latest, accessMs);
      }
    } catch {
      // 单个 manifest 损坏时退回目录/文件 mtime，不让清理流程失败。
    }
  }
  return latest;
}

async function collectCacheFiles(root: string): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      try {
        const st = await stat(abs);
        if (st.isDirectory()) await walk(abs);
        else files.push({ path: abs, size: st.size });
      } catch {
        // 缓存文件被并发删除时忽略。
      }
    }
  }
  await walk(root);
  return files;
}

async function collectManifestFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      try {
        const st = await stat(abs);
        if (st.isDirectory()) await walk(abs);
        else if (name === "manifest.json") files.push(abs);
      } catch {
        // 缓存文件被并发删除时忽略。
      }
    }
  }
  await walk(root);
  return files;
}

function accessTimeMs(entry: FolderSourceCacheEntry): number {
  const parsed = Date.parse(entry.lastAccessAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function parsedFileSize(sessionId: string, folderId: string, parsedFile: string): Promise<number | null> {
  try {
    return (await stat(join(parsedDir(sessionId, folderId), parsedFile))).size;
  } catch {
    return null;
  }
}

async function parsedFiles(sessionId: string, folderId: string): Promise<string[]> {
  try {
    return await readdir(parsedDir(sessionId, folderId));
  } catch {
    return [];
  }
}

interface ParsedCacheCandidate {
  sessionId: string;
  folderId: string;
  parsedFile: string;
  at: number;
  size: number;
}

async function collectParsedCacheCandidates(root: string): Promise<ParsedCacheCandidate[]> {
  const manifestFiles = await collectManifestFiles(root);
  const candidates: ParsedCacheCandidate[] = [];
  for (const file of manifestFiles) {
    let rawManifest: Partial<FolderSourceManifest>;
    try {
      rawManifest = JSON.parse(await readFile(file, "utf8")) as Partial<FolderSourceManifest>;
    } catch {
      continue;
    }
    if (
      rawManifest.version !== 1 ||
      typeof rawManifest.sessionId !== "string" ||
      typeof rawManifest.folderId !== "string"
    ) {
      continue;
    }
    await withManifestLock(rawManifest.sessionId, rawManifest.folderId, async () => {
      const manifest = await readManifest(rawManifest.sessionId!, rawManifest.folderId!);
      const entries = Object.entries(manifest.entries);
      const existingParsed = new Set(await parsedFiles(manifest.sessionId, manifest.folderId));
      let changed = false;
      const byParsedFile = new Map<string, { at: number }>();
      for (const [relPath, entry] of entries) {
        if (!entry.parsedFile || !existingParsed.has(entry.parsedFile)) {
          delete manifest.entries[relPath];
          changed = true;
          continue;
        }
        const group = byParsedFile.get(entry.parsedFile);
        const at = accessTimeMs(entry);
        if (!group || at > group.at) byParsedFile.set(entry.parsedFile, { at });
      }
      if (changed) await writeManifest(manifest);

      for (const parsedFile of existingParsed) {
        const size = await parsedFileSize(manifest.sessionId, manifest.folderId, parsedFile);
        if (size === null) continue;
        const group = byParsedFile.get(parsedFile);
        candidates.push({
          sessionId: manifest.sessionId,
          folderId: manifest.folderId,
          parsedFile,
          at: group?.at ?? 0,
          size,
        });
      }
    });
  }
  return candidates;
}

async function removeParsedCacheCandidate(candidate: ParsedCacheCandidate): Promise<number> {
  return withManifestLock(candidate.sessionId, candidate.folderId, async () => {
    const manifest = await readManifest(candidate.sessionId, candidate.folderId);
    const refs = Object.entries(manifest.entries).filter(([, entry]) => entry.parsedFile === candidate.parsedFile);
    const latestRefAccess = refs.reduce((max, [, entry]) => Math.max(max, accessTimeMs(entry)), 0);
    if (latestRefAccess > candidate.at) return 0;

    const file = join(parsedDir(candidate.sessionId, candidate.folderId), candidate.parsedFile);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0;
    }

    for (const [relPath] of refs) delete manifest.entries[relPath];
    if (refs.length > 0) await writeManifest(manifest);
    try {
      await rm(file, { force: true });
    } catch {
      return 0;
    }
    return size;
  });
}

async function enforceLimit(root: string, maxBytes: number): Promise<void> {
  const files = await collectCacheFiles(root);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxBytes) return;
  const candidates = await collectParsedCacheCandidates(root);
  candidates.sort((a, b) => a.at - b.at);
  for (const candidate of candidates) {
    if (total <= maxBytes) break;
    total -= await removeParsedCacheCandidate(candidate);
  }
}

export async function enforceFolderSourceCacheLimits(sessionId: string): Promise<void> {
  const totalLimit = positiveBytesEnv(process.env.QINGAGENT_FOLDER_CACHE_MAX_BYTES, DEFAULT_TOTAL_CACHE_BYTES);
  const sessionLimit = positiveBytesEnv(
    process.env.QINGAGENT_FOLDER_CACHE_SESSION_MAX_BYTES,
    DEFAULT_SESSION_CACHE_BYTES,
  );
  await enforceLimit(folderCacheRoot(sessionId), sessionLimit);
  await enforceLimit(join(QINGAGENT_DATA_DIR, "folder-source-cache"), totalLimit);
}

export function activeFolderSources(sources: Iterable<FolderSourceRecord>): FolderSourceRecord[] {
  return Array.from(sources).filter((source) => source.status === "connected");
}
