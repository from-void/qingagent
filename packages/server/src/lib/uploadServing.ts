import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { removeUnpairedSurrogates } from "@qingagent/contract-ts";
import {
  UPLOAD_DIR,
  findUploadedFileRecord,
  isValidUploadId,
  isWithinUploadDir,
} from "./uploadStorage";

export type UploadedFileReadError = "invalid_file_id" | "invalid_filename" | "not_found";

export type ResolvedUploadedFile = {
  filePath: string;
  filename: string;
  contentType: string;
  size: number;
};

export function isSafeUploadFilename(filename: string): boolean {
  return !filename.includes("/") && !filename.includes("\\") && !filename.includes("..");
}

/** 只保留单一 MIME 与可选 charset，拒绝控制字符及其它可注入参数。 */
export function normalizeUploadMimeType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const matched = /^([a-z0-9!#$&^_.+-]+)\/([a-z0-9!#$&^_.+-]+)(?:\s*;\s*charset=([a-z0-9._-]+))?$/i.exec(
    raw.trim(),
  );
  if (!matched) return null;
  const baseType = `${matched[1]!.toLowerCase()}/${matched[2]!.toLowerCase()}`;
  return matched[3]
    ? `${baseType}; charset=${matched[3].toLowerCase()}`
    : baseType;
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^\w.\-]/g, "_");
}

function encodeDispositionFilename(filename: string): string {
  const withoutControls = removeUnpairedSurrogates(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "_");
  return encodeURIComponent(withoutControls).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function mimeFromExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

function contentTypeForUpload(filename: string, persistedMimeType: string | null | undefined): string {
  const persisted = normalizeUploadMimeType(persistedMimeType);
  return persisted && persisted !== "application/octet-stream"
    ? persisted
    : mimeFromExt(filename);
}

const INLINE_SAFE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

function shouldServeInline(contentType: string): boolean {
  const baseType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return INLINE_SAFE_CONTENT_TYPES.has(baseType);
}

export async function resolveUploadedFileForRead(
  fileId: string,
  requestedFilename?: string,
): Promise<
  | { ok: true; file: ResolvedUploadedFile }
  | { ok: false; error: UploadedFileReadError }
> {
  if (!fileId || !isValidUploadId(fileId)) {
    return { ok: false, error: "invalid_file_id" };
  }
  if (requestedFilename && !isSafeUploadFilename(requestedFilename)) {
    return { ok: false, error: "invalid_filename" };
  }

  const dir = path.resolve(UPLOAD_DIR, fileId);
  if (!isWithinUploadDir(dir)) return { ok: false, error: "invalid_file_id" };

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (files.length === 0) return { ok: false, error: "not_found" };

  const record = await findUploadedFileRecord(fileId);
  const filename = record?.filename ?? files.sort()[0]!;
  const filePath = path.resolve(dir, filename);
  if (!isWithinUploadDir(filePath)) return { ok: false, error: "not_found" };

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, error: "not_found" };

  return {
    ok: true,
    file: {
      filePath,
      filename,
      contentType: contentTypeForUpload(filename, record?.mimeType),
      size: stat.size,
    },
  };
}

export function streamResolvedUploadedFile(c: Context, file: ResolvedUploadedFile) {
  const safeName = sanitizeFilename(file.filename);
  const encodedName = encodeDispositionFilename(file.filename);
  const disposition = shouldServeInline(file.contentType) ? "inline" : "attachment";
  c.header("Content-Type", file.contentType);
  c.header("Content-Length", String(file.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
  );

  return stream(c, async (s) => {
    const nodeStream = createReadStream(file.filePath);
    for await (const chunk of nodeStream) {
      await s.write(chunk as Uint8Array);
    }
  });
}
