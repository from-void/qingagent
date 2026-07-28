import { Hono } from "hono";
import {
  getQingagentSessionWorkspace,
  getSessionFolderSources,
} from "@qingagent/core";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import {
  folderSourceErrorStatus,
  jsonError,
  normalizeRelPath,
  publicFolderSourceErrorMessage,
  shouldHideEntry,
  targetPath,
} from "../lib/folderSourceRoutes";

export const folderEntriesRoutes = new Hono();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const CHILD_COUNT_TIMEOUT_MS = 1_000;
const ENTRY_STAT_TIMEOUT_MS = 1_000;
const ENTRY_CONCURRENCY = 8;
const DEFAULT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILE_MAX_BYTES = 50 * 1024 * 1024;

type FolderEntryKind = "dir" | "file";

interface FolderEntryResponseItem {
  name: string;
  kind: FolderEntryKind;
  childCount: number | null;
  byteLen: number | null;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseCursor(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function fileSize(stat: { size?: unknown }): number | null {
  return typeof stat.size === "number" && Number.isFinite(stat.size) && stat.size >= 0
    ? stat.size
    : null;
}

function childCountTimeoutMs(): number {
  const raw = process.env.QINGAGENT_FOLDER_CHILD_COUNT_TIMEOUT_MS;
  if (!raw) return CHILD_COUNT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CHILD_COUNT_TIMEOUT_MS;
}

function entryStatTimeoutMs(): number {
  const raw = process.env.QINGAGENT_FOLDER_ENTRY_STAT_TIMEOUT_MS;
  if (!raw) return ENTRY_STAT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : ENTRY_STAT_TIMEOUT_MS;
}

async function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return await promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T);
    }
  }));
  return results;
}

function parseMaxBytes(raw: string | undefined): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === "") return { ok: true, value: DEFAULT_FILE_MAX_BYTES };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, error: "Invalid maxBytes" };
  }
  if (parsed > MAX_FILE_MAX_BYTES) {
    return { ok: false, error: `maxBytes must be at most ${MAX_FILE_MAX_BYTES}` };
  }
  return { ok: true, value: parsed };
}

function contentTypeForPath(path: string): string {
  const ext = posix.extname(path).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc":
      return "application/msword";
    case ".txt":
    case ".md":
    case ".markdown":
    case ".csv":
    case ".tsv":
    case ".json":
    case ".log":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function toBytes(content: string | Buffer): Uint8Array<ArrayBuffer> {
  return (typeof content === "string" ? Buffer.from(content) : content) as Uint8Array<ArrayBuffer>;
}

folderEntriesRoutes.get("/sessions/:sessionId/folder-sources/:folderId/entries", async (c) => {
  const sessionId = c.req.param("sessionId");
  const folderId = c.req.param("folderId");
  const relPath = normalizeRelPath(c.req.query("path"));
  if (relPath === null) return jsonError(c, "Invalid path", 400);

  const source = getSessionFolderSources(sessionId).find((item) => item.id === folderId) ?? null;
  if (!source) return jsonError(c, "Session or folder source not found", 404);

  const limit = parseLimit(c.req.query("limit"));
  const offset = parseCursor(c.req.query("cursor"));
  if (offset === null) return jsonError(c, "Invalid cursor", 400);
  const workspace = await getQingagentSessionWorkspace(sessionId);
  const filesystem = workspace.filesystem;
  if (!filesystem) return jsonError(c, "Workspace filesystem is unavailable", 502);
  const dirPath = targetPath(source.mountPath, relPath);

  let rawEntries: Awaited<ReturnType<typeof filesystem.readdir>>;
  try {
    rawEntries = await filesystem.readdir(dirPath);
  } catch (error) {
    return jsonError(
      c,
      publicFolderSourceErrorMessage(error),
      folderSourceErrorStatus(error),
    );
  }

  const visibleEntries = rawEntries
    .filter((entry) => !shouldHideEntry(entry.name))
    .sort((a, b) => {
      const typeOrder = Number(a.type !== "directory") - Number(b.type !== "directory");
      if (typeOrder !== 0) return typeOrder;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  const slice = visibleEntries.slice(offset, offset + limit);
  const truncated = offset + slice.length < visibleEntries.length;
  const nextCursor = truncated ? String(offset + slice.length) : null;

  const entries = await mapWithConcurrency(slice, ENTRY_CONCURRENCY, async (entry): Promise<FolderEntryResponseItem> => {
    const entryPath = targetPath(dirPath, entry.name);
    let kind: FolderEntryKind = entry.type === "directory" ? "dir" : "file";
    let byteLen: number | null = entry.type === "directory" ? null : fileSize(entry);
    try {
      const stat = await withSoftTimeout(filesystem.stat(entryPath), entryStatTimeoutMs());
      if (stat) {
        kind = stat.type === "directory" ? "dir" : "file";
        byteLen = kind === "file" ? fileSize(stat) : null;
      }
    } catch {
      // 子项在 readdir 和 stat 之间消失时不让整层失败；保留 readdir 能给出的廉价事实。
    }

    let childCount: number | null = null;
    if (kind === "dir") {
      try {
        const children = await withSoftTimeout(filesystem.readdir(entryPath), childCountTimeoutMs());
        childCount = children
          ? children.filter((child) => !shouldHideEntry(child.name)).length
          : null;
      } catch {
        childCount = null;
      }
    }

    return {
      name: entry.name,
      kind,
      childCount,
      byteLen,
    };
  });

  return c.json({ entries, truncated, nextCursor });
});

folderEntriesRoutes.get("/sessions/:sessionId/folder-sources/:folderId/file", async (c) => {
  const sessionId = c.req.param("sessionId");
  const folderId = c.req.param("folderId");
  const relPath = normalizeRelPath(c.req.query("path"));
  if (relPath === null || relPath.length === 0) return jsonError(c, "Invalid path", 400);

  const maxBytes = parseMaxBytes(c.req.query("maxBytes"));
  if (!maxBytes.ok) return jsonError(c, maxBytes.error, 400);

  const source = getSessionFolderSources(sessionId).find((item) => item.id === folderId) ?? null;
  if (!source) return jsonError(c, "Session or folder source not found", 404);

  const workspace = await getQingagentSessionWorkspace(sessionId);
  const filesystem = workspace.filesystem;
  if (!filesystem) return jsonError(c, "Workspace filesystem is unavailable", 502);
  const filePath = targetPath(source.mountPath, relPath);

  try {
    const stat = await filesystem.stat(filePath);
    if (stat.type !== "file") return jsonError(c, "Path is not a file", 400);
    const byteLen = fileSize(stat);
    if (byteLen !== null && byteLen > maxBytes.value) {
      return jsonError(c, "File exceeds maxBytes", 413);
    }
  } catch (error) {
    return jsonError(
      c,
      publicFolderSourceErrorMessage(error),
      folderSourceErrorStatus(error),
    );
  }

  try {
    const bytes = toBytes(await filesystem.readFile(filePath));
    if (bytes.byteLength > maxBytes.value) return jsonError(c, "File exceeds maxBytes", 413);
    return c.body(bytes, 200, {
      "Content-Type": contentTypeForPath(relPath),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    });
  } catch (error) {
    return jsonError(
      c,
      publicFolderSourceErrorMessage(error),
      folderSourceErrorStatus(error),
    );
  }
});
