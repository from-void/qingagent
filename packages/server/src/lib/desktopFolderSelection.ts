import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

export interface DesktopFolderSelection {
  selectionToken: string;
  webContentsId: number;
  rootPath: string;
  name: string;
  pathLabel: string;
  fileCount: number | null;
  fileCountCapped: boolean;
  expiresAt: number;
}

export interface RegisterDesktopFolderSelectionInput {
  webContentsId: number;
  rootPath: string;
  name?: string;
  pathLabel?: string;
  fileCount?: number | null;
  fileCountCapped?: boolean;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_COUNT_LIMIT = 5_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const selections = new Map<string, DesktopFolderSelection>();

function normalizeCountLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_COUNT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function summarizePathLabel(value: string): string {
  const normalized = normalizeSeparators(value.trim());
  if (!normalized) return "";
  const home = normalizeSeparators(homedir());
  if (home && normalized === home) return "~";
  if (home && normalized.startsWith(`${home}/`)) {
    const parts = normalized.slice(home.length + 1).split("/").filter(Boolean);
    if (parts.length <= 2) return `~/${parts.join("/")}`;
    return `~/.../${parts.slice(-2).join("/")}`;
  }
  if (normalized.startsWith("~/")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    if (parts.length <= 2) return `~/${parts.join("/")}`;
    return `~/.../${parts.slice(-2).join("/")}`;
  }
  if (!normalized.startsWith("/") && !/^[a-zA-Z]:\//.test(normalized)) return normalized;
  const parts = normalized.replace(/^[a-zA-Z]:\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return normalized.startsWith("/") ? "/" : normalized;
  if (parts.length <= 2) return `.../${parts[parts.length - 1]}`;
  return `.../${parts.slice(-2).join("/")}`;
}

function cleanupExpired(now = Date.now()): void {
  for (const [token, selection] of selections) {
    if (selection.expiresAt <= now) selections.delete(token);
  }
}

export async function assertDirectory(path: string): Promise<string> {
  const resolved = await realpath(path);
  const st = await lstat(resolved);
  if (!st.isDirectory()) {
    throw new Error("invalid_path: selected path is not a directory");
  }
  return resolved;
}

export async function countFolderFiles(
  rootPath: string,
  limit = DEFAULT_COUNT_LIMIT,
): Promise<{ fileCount: number; fileCountCapped: boolean }> {
  const normalizedLimit = normalizeCountLimit(limit);
  let count = 0;
  let capped = false;

  async function walk(dir: string): Promise<void> {
    if (capped) return;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (capped) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
      } else if (entry.isFile()) {
        count += 1;
        if (count > normalizedLimit) {
          count = normalizedLimit;
          capped = true;
        }
      }
    }
  }

  await walk(rootPath);
  return { fileCount: count, fileCountCapped: capped };
}

export function registerDesktopFolderSelection(
  input: RegisterDesktopFolderSelectionInput,
): DesktopFolderSelection {
  cleanupExpired();
  const now = Date.now();
  const selectionToken = `dfs_${input.webContentsId}_${randomUUID()}`;
  const selection: DesktopFolderSelection = {
    selectionToken,
    webContentsId: input.webContentsId,
    rootPath: input.rootPath,
    name: input.name ?? basename(input.rootPath),
    pathLabel: summarizePathLabel(input.pathLabel ?? input.rootPath),
    fileCount: input.fileCount ?? null,
    fileCountCapped: input.fileCountCapped ?? false,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  selections.set(selectionToken, selection);
  return selection;
}

export function consumeDesktopFolderSelection(
  selectionToken: string,
  expectedWebContentsId?: number,
): DesktopFolderSelection | null {
  cleanupExpired();
  const selection = selections.get(selectionToken);
  if (!selection) return null;
  if (
    expectedWebContentsId !== undefined &&
    selection.webContentsId !== expectedWebContentsId
  ) {
    return null;
  }
  selections.delete(selectionToken);
  return selection.expiresAt > Date.now() ? selection : null;
}

export function peekDesktopFolderSelection(
  selectionToken: string,
  expectedWebContentsId?: number,
): DesktopFolderSelection | null {
  cleanupExpired();
  const selection = selections.get(selectionToken);
  if (!selection) return null;
  if (
    expectedWebContentsId !== undefined &&
    selection.webContentsId !== expectedWebContentsId
  ) {
    return null;
  }
  return selection.expiresAt > Date.now() ? selection : null;
}

export function __resetDesktopFolderSelectionsForTest(): void {
  selections.clear();
}
