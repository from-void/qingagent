import fs from "node:fs/promises";
import path from "node:path";

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

export function isValidUploadId(fileId: string): boolean {
  return UUID_RE.test(fileId);
}

/** Validate that a resolved path is within the UPLOAD_DIR (defense-in-depth). */
export function isWithinUploadDir(resolvedPath: string): boolean {
  const relative = path.relative(UPLOAD_DIR, resolvedPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
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

  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(
      "[uploadStorage] Failed to delete uploaded file",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
