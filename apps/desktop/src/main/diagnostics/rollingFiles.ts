import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

export interface RollingBudgetOptions {
  maxDays: number;
  maxBytes: number;
  now?: () => Date;
}

export interface RollingAppendOptions extends RollingBudgetOptions {
  extension: string;
}

interface RollingFileInfo {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  dateMs: number;
}

export async function appendRollingChunk(
  dir: string,
  prefix: string,
  chunk: string,
  opts: RollingAppendOptions,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}-${formatLocalDay(opts.now?.() ?? new Date())}.${opts.extension}`);
  await appendFile(filePath, chunk, "utf8");
  await pruneRollingLogs(dir, prefix, opts);
}

export async function pruneRollingLogs(
  dir: string,
  prefix: string,
  opts: RollingBudgetOptions,
): Promise<{ deleted: number; freedBytes: number }> {
  const now = opts.now?.() ?? new Date();
  let files = await readRollingFiles(dir, prefix);
  let deleted = 0;
  let freedBytes = 0;

  const cutoff = startOfLocalDay(now);
  cutoff.setDate(cutoff.getDate() - Math.max(0, opts.maxDays - 1));
  const keepAfterMs = cutoff.getTime();

  for (const file of files) {
    if (file.dateMs >= keepAfterMs) continue;
    if (await removeFile(file.path)) {
      deleted += 1;
      freedBytes += file.bytes;
    }
  }

  files = (await readRollingFiles(dir, prefix)).sort(compareOldestFirst);
  let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of files) {
    if (totalBytes <= opts.maxBytes) break;
    if (await removeFile(file.path)) {
      deleted += 1;
      freedBytes += file.bytes;
      totalBytes -= file.bytes;
    }
  }

  return { deleted, freedBytes };
}

export function createRollingConsoleTransport(
  dir: string,
  opts: RollingBudgetOptions & {
    prefix?: string;
    extension?: string;
    flushIntervalMs?: number;
    maxBufferBytes?: number;
  },
): { write(method: string, args: unknown[]): void; flush(): Promise<void> } {
  const prefix = opts.prefix ?? "main";
  const extension = opts.extension ?? "log";
  const flushIntervalMs = opts.flushIntervalMs ?? 1000;
  const maxBufferBytes = opts.maxBufferBytes ?? 64 * 1024;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer) return;
    const chunk = buffer;
    buffer = "";
    try {
      await appendRollingChunk(dir, prefix, chunk, {
        extension,
        maxDays: opts.maxDays,
        maxBytes: opts.maxBytes,
        now: opts.now,
      });
    } catch {
      // 日志落盘是诊断旁路，失败不能影响主进程。
    }
  };

  const scheduleFlush = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  };

  return {
    write(method, args) {
      try {
        buffer += formatConsoleLine(method, args);
        if (new TextEncoder().encode(buffer).byteLength >= maxBufferBytes) {
          void flush();
        } else {
          scheduleFlush();
        }
      } catch {
        // console transport 必须全程静默失败。
      }
    },
    flush,
  };
}

export function formatLocalDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function readRollingFiles(dir: string, prefix: string): Promise<RollingFileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files: RollingFileInfo[] = [];
  for (const name of names) {
    const dateMs = dateFromRollingName(name, prefix);
    if (dateMs === null) continue;
    const filePath = path.join(dir, name);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      files.push({
        name,
        path: filePath,
        bytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        dateMs,
      });
    } catch {
      // 文件可能被别的清理流程删掉，跳过即可。
    }
  }
  return files;
}

function dateFromRollingName(name: string, prefix: string): number | null {
  const match = new RegExp(`^${escapeRegExp(prefix)}-(\\d{4})-(\\d{2})-(\\d{2})\\.`).exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function compareOldestFirst(a: RollingFileInfo, b: RollingFileInfo): number {
  return a.dateMs - b.dateMs || a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name);
}

async function removeFile(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatConsoleLine(method: string, args: unknown[]): string {
  const rendered = args
    .map((arg) => typeof arg === "string" ? arg : inspect(arg, { depth: 6, breakLength: 120 }))
    .join(" ");
  return `[${new Date().toISOString()}] [${method.toUpperCase()}] ${rendered}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
