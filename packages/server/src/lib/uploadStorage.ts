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
  /** 旧索引可能没有该字段；缺失表示历史引用数未知。 */
  refCount?: number;
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
          ...(typeof record.refCount === "number" &&
          Number.isSafeInteger(record.refCount) &&
          record.refCount > 0
            ? { refCount: record.refCount }
            : {}),
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
        // 扫描得到的历史文件没有可靠的引用数，保持未知以避免后续误删物理文件。
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
      if (existing.record.refCount !== undefined) {
        existing.record.refCount += 1;
      }
      // 去重返回也是一次新的会话级引用；已知计数必须在返回前持久化。
      // 历史记录的基数未知，不能擅自假定为 1；新增引用后仍保持未知并走保守清理。
      await writeContentIndex(index);
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
      refCount: 1,
    };
    index.records[uploadRecordKey(contentHash, input.filename, input.mimeType)] = record;
    index.complete = true;
    await writeContentIndex(index);
    return { record, deduped: false };
  });
}

/** 按 fileId 读取与物理文件一致的规范化索引记录；历史未索引文件会先安全重建索引。 */
export async function findUploadedFileRecord(fileId: string): Promise<UploadedFileRecord | null> {
  if (!isValidUploadId(fileId)) return null;
  return withUploadIndexLock(async () => {
    let index = await readContentIndex();
    if (!index.complete) {
      index = await rebuildContentIndex();
      await writeContentIndex(index);
    }
    const record = Object.values(index.records).find(
      (candidate) => candidate.fileId === fileId,
    );
    if (!record || !(await uploadedRecordExists(record))) return null;
    return { ...record };
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
      let index = await readContentIndex();
      if (!index.complete) {
        index = await rebuildContentIndex();
      }

      const indexedEntry = Object.entries(index.records).find(
        ([, record]) => record.fileId === fileId,
      );
      if (!indexedEntry) {
        console.warn("[uploadStorage] Upload is not indexed; keeping physical file", {
          fileId,
        });
        return false;
      }

      const [recordKey, record] = indexedEntry;
      if (record.refCount === undefined) {
        // 历史索引无法推断全局引用数。这里只移除去重索引，保留物理文件交给人工或后续 GC，
        // 宁可产生孤儿文件，也不能误删仍被旧会话引用的原始字节。
        delete index.records[recordKey];
        await writeContentIndex(index);
        console.warn(
          "[uploadStorage] Upload refCount is unknown; removed index record but kept physical file for manual or GC cleanup",
          { fileId },
        );
        return true;
      }

      const nextRefCount = record.refCount - 1;
      if (nextRefCount > 0) {
        record.refCount = nextRefCount;
        await writeContentIndex(index);
        return true;
      }

      await fs.rm(dir, { recursive: true, force: true });
      for (const [key, candidate] of Object.entries(index.records)) {
        if (candidate.fileId === fileId) delete index.records[key];
      }
      await writeContentIndex(index);
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

/**
 * 归属清单已证明没有其它活跃会话引用时，物理删除完整目录并同步移除索引。
 * 与 deleteUploadedFile 的历史 refCount 保守语义分开，调用方必须先做归属判定。
 */
export async function purgeStoredFile(fileId: string): Promise<boolean> {
  if (!isValidUploadId(fileId)) return false;
  const dir = path.resolve(UPLOAD_DIR, fileId);
  if (dir === UPLOAD_DIR || !isWithinUploadDir(dir)) return false;

  return withUploadIndexLock(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      let index = await readContentIndex();
      if (!index.complete) index = await rebuildContentIndex();
      for (const [key, candidate] of Object.entries(index.records)) {
        if (candidate.fileId === fileId) delete index.records[key];
      }
      index.complete = true;
      await writeContentIndex(index);
      return true;
    } catch (error) {
      console.error("[uploadStorage] Failed to purge stored file", {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
}

export async function listStoredFileIds(): Promise<string[]> {
  const entries = await fs.readdir(UPLOAD_DIR).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter(isValidUploadId).sort();
}
