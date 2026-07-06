import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Base directory for uploaded files.
 *
 * 默认 cwd 下 ./uploads(web/VPS 不变);桌面端打包后 cwd 常不可写,由
 * QINGAGENT_UPLOADS_DIR 覆盖指向 userData。canonical 解析见 core 的 uploadsBaseDir();
 * 此处内联同一行逻辑以避免引入 core 整桶 import 边(有副作用、有顺序风险)。两处须同步。
 */
export const UPLOAD_DIR = process.env.QINGAGENT_UPLOADS_DIR?.trim()
  ? path.resolve(process.env.QINGAGENT_UPLOADS_DIR.trim())
  : path.resolve("./uploads");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_INDEX_FILENAME = ".content-index.json";

export type UploadedFileRecord = {
  fileId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  contentHash: string;
};

type UploadContentIndex = {
  version: 1;
  complete: boolean;
  records: Record<string, UploadedFileRecord>;
};

const emptyContentIndex = (): UploadContentIndex => ({
  version: 1,
  complete: false,
  records: {},
});

let uploadIndexQueue: Promise<void> = Promise.resolve();

export function isValidUploadId(fileId: string): boolean {
  return UUID_RE.test(fileId);
}

/** Validate that a resolved path is within the UPLOAD_DIR (defense-in-depth). */
export function isWithinUploadDir(resolvedPath: string): boolean {
  const relative = path.relative(UPLOAD_DIR, resolvedPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function contentHashOf(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function contentIndexPath(): string {
  return path.join(UPLOAD_DIR, CONTENT_INDEX_FILENAME);
}

function uploadRecordKey(contentHash: string, filename: string, mimeType: string | null): string {
  const metadataHash = crypto
    .createHash("sha256")
    .update(filename)
    .update("\0")
    .update(mimeType ?? "")
    .digest("hex");
  return `${contentHash}:${metadataHash}`;
}

function uploadRecordMatches(
  record: UploadedFileRecord,
  input: { contentHash: string; filename: string; mimeType: string },
): boolean {
  return (
    record.contentHash === input.contentHash &&
    record.filename === input.filename &&
    (record.mimeType === null || record.mimeType === input.mimeType)
  );
}

function findUploadRecordEntry(
  index: UploadContentIndex,
  input: { contentHash: string; filename: string; mimeType: string },
): { key: string; record: UploadedFileRecord } | null {
  for (const [key, record] of Object.entries(index.records)) {
    if (uploadRecordMatches(record, input)) return { key, record };
  }
  return null;
}

async function readContentIndex(): Promise<UploadContentIndex> {
  try {
    const raw = await fs.readFile(contentIndexPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UploadContentIndex>;
    if (parsed.version !== 1 || typeof parsed.records !== "object" || parsed.records === null) {
      return emptyContentIndex();
    }
    const records: Record<string, UploadedFileRecord> = {};
    for (const [key, record] of Object.entries(parsed.records)) {
      const keyMatch = /^([0-9a-f]{64})(?::[0-9a-f]{64})?$/i.exec(key);
      if (
        keyMatch &&
        record &&
        isValidUploadId(record.fileId) &&
        typeof record.filename === "string" &&
        typeof record.size === "number" &&
        record.contentHash === keyMatch[1]
      ) {
        records[key] = {
          fileId: record.fileId,
          filename: record.filename,
          mimeType: typeof record.mimeType === "string" ? record.mimeType : null,
          size: record.size,
          contentHash: record.contentHash,
        };
      }
    }
    return { version: 1, complete: Boolean(parsed.complete), records };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[uploadStorage] Failed to read upload content index; rebuilding", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return emptyContentIndex();
  }
}

async function writeContentIndex(index: UploadContentIndex): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(contentIndexPath(), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

async function uploadedRecordExists(record: UploadedFileRecord): Promise<boolean> {
  if (!isValidUploadId(record.fileId) || !record.filename) return false;
  const filePath = path.resolve(UPLOAD_DIR, record.fileId, record.filename);
  if (!isWithinUploadDir(filePath)) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size === record.size;
  } catch {
    return false;
  }
}

async function rebuildContentIndex(): Promise<UploadContentIndex> {
  const index = emptyContentIndex();
  let entries: string[];
  try {
    entries = await fs.readdir(UPLOAD_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      index.complete = true;
      return index;
    }
    throw error;
  }

  for (const fileId of entries.sort()) {
    if (!isValidUploadId(fileId)) continue;
    const dir = path.resolve(UPLOAD_DIR, fileId);
    if (!isWithinUploadDir(dir)) continue;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    const filename = files.sort().find((name) => name && !name.includes("/") && !name.includes("\\"));
    if (!filename) continue;
    const filePath = path.resolve(dir, filename);
    if (!isWithinUploadDir(filePath)) continue;
    try {
      const buffer = await fs.readFile(filePath);
      const contentHash = contentHashOf(buffer);
      const key = uploadRecordKey(contentHash, filename, null);
      index.records[key] ??= {
        fileId,
        filename,
        mimeType: null,
        size: buffer.length,
        contentHash,
      };
    } catch {
      continue;
    }
  }

  index.complete = true;
  return index;
}

async function withUploadIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = uploadIndexQueue;
  let release!: () => void;
  uploadIndexQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function findOrStoreUploadedFile(input: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<{ record: UploadedFileRecord; deduped: boolean }> {
  return withUploadIndexLock(async () => {
    const contentHash = contentHashOf(input.buffer);
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    let index = await readContentIndex();
    if (!index.complete) {
      index = await rebuildContentIndex();
    }

    const existing = findUploadRecordEntry(index, {
      contentHash,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    if (existing && await uploadedRecordExists(existing.record)) {
      return { record: existing.record, deduped: true };
    }
    if (existing) delete index.records[existing.key];

    const fileId = crypto.randomUUID();
    const dir = path.join(UPLOAD_DIR, fileId);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.resolve(dir, input.filename);
    if (!isWithinUploadDir(filePath)) {
      throw new Error("invalid filename");
    }
    await fs.writeFile(filePath, input.buffer);

    const record: UploadedFileRecord = {
      fileId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.buffer.length,
      contentHash,
    };
    index.records[uploadRecordKey(contentHash, input.filename, input.mimeType)] = record;
    index.complete = true;
    await writeContentIndex(index);
    return { record, deduped: false };
  });
}

export async function deleteUploadedFile(fileId: string): Promise<boolean> {
  if (!isValidUploadId(fileId)) {
    console.warn("[uploadStorage] Refusing to delete invalid upload id", { fileId });
    return false;
  }

  const dir = path.resolve(UPLOAD_DIR, fileId);
  if (dir === UPLOAD_DIR || !isWithinUploadDir(dir)) {
    console.error("[uploadStorage] Refusing to delete unsafe upload path", { fileId, dir });
    return false;
  }

  return withUploadIndexLock(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      const index = await readContentIndex();
      let changed = false;
      for (const [hash, record] of Object.entries(index.records)) {
        if (record.fileId !== fileId) continue;
        delete index.records[hash];
        changed = true;
      }
      if (changed) await writeContentIndex(index);
      return true;
    } catch (err) {
      console.error(
        "[uploadStorage] Failed to delete uploaded file",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  });
}
