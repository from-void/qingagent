import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getOrRestoreSessionReadOnly } from "../gateway/sessionLifecycle";
import {
  UPLOAD_DIR,
  findOrStoreUploadedFile,
  findUploadedFileRecord,
  isValidUploadId,
  isWithinUploadDir,
} from "../lib/uploadStorage";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { resolveUploadMaxBytes, uploadBodyMaxBytes } from "../lib/uploadLimits";
import { parseBody } from "../lib/validation";
import { decodeBase64 } from "../lib/base64";

export const uploadRoutes = new Hono();
const uploadMaxBytes = resolveUploadMaxBytes();
const uploadRequestMaxBytes = uploadBodyMaxBytes(uploadMaxBytes);

/** 上传请求体:filename/content 必填非空(base64),mimeType 可选;路径安全在下方业务校验。 */
const uploadBodySchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
  mimeType: z.string().optional(),
});

/** Validate that a filename does not contain path separators or traversal sequences. */
function isSafeFilename(filename: string): boolean {
  return !filename.includes("/") && !filename.includes("\\") && !filename.includes("..");
}

/** Sanitize a filename for use in Content-Disposition header. */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^\w.\-]/g, "_");
}

function encodeDispositionFilename(filename: string): string {
  const withoutControls = filename.replace(/[\u0000-\u001f\u007f]/g, "_");
  return encodeURIComponent(withoutControls).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 只保留单一 MIME 与可选 charset，拒绝控制字符及其它可注入参数。 */
function normalizeMimeType(raw: string | null | undefined): string | null {
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

/** Map file extension to MIME type for serving. */
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
  const persisted = normalizeMimeType(persistedMimeType);
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

/**
 * POST /api/v1/upload — receive a file as JSON { filename, mimeType, content (base64) }
 * and persist it to disk under ./uploads/<fileId>/<filename>.
 * Returns { fileId, filename, mimeType, size }.
 */
uploadRoutes.post(
  "/upload",
  bodyLimit({
    maxSize: uploadRequestMaxBytes,
    onError: (c) => c.json({ error: "file_too_large", maxBytes: uploadMaxBytes }, 413),
  }),
  async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    const parsed = await parseBody(c, uploadBodySchema);
    if (!parsed.ok) return parsed.response;
    const { filename, mimeType, content } = parsed.data;

    if (!isSafeFilename(filename)) {
      return c.json({ error: "filename must not contain path separators or '..'" }, 400);
    }

    const buffer = decodeBase64(content);
    if (!buffer) {
      return c.json({ error: "invalid_base64" }, 400);
    }
    if (buffer.byteLength > uploadMaxBytes) {
      return c.json({ error: "file_too_large", maxBytes: uploadMaxBytes }, 413);
    }
    const normalizedMimeType = normalizeMimeType(mimeType) ?? "application/octet-stream";
    let stored: Awaited<ReturnType<typeof findOrStoreUploadedFile>>;
    try {
      stored = await findOrStoreUploadedFile({
        filename,
        mimeType: normalizedMimeType,
        buffer,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid filename") {
        return c.json({ error: "invalid filename" }, 400);
      }
      throw error;
    }
    const { record, deduped } = stored;

    console.info("[upload] file stored", {
      fileId: record.fileId,
      filename: record.filename,
      size: record.size,
      deduped,
    });

    return c.json({
      fileId: record.fileId,
      filename: record.filename,
      mimeType: record.mimeType || normalizedMimeType,
      size: record.size,
    });
  },
);

/**
 * GET /api/v1/files/:fileId — 流式返回上传文件。只有少量安全 MIME 白名单允许
 * inline，其它类型一律 attachment 下载。
 */
async function handleFileRequest(c: Context) {
  const fileId = c.req.param("fileId");
  const requestedFilename = c.req.param("filename");
  if (!fileId || !isValidUploadId(fileId)) {
    return c.json({ error: "invalid fileId" }, 400);
  }
  if (requestedFilename && !isSafeFilename(requestedFilename)) {
    return c.json({ error: "invalid filename" }, 400);
  }

  const dir = path.resolve(UPLOAD_DIR, fileId);
  if (!isWithinUploadDir(dir)) {
    return c.json({ error: "invalid fileId" }, 400);
  }

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  if (files.length === 0) return c.json({ error: "not found" }, 404);

  const record = await findUploadedFileRecord(fileId);
  const filename = record?.filename ?? files.sort()[0]!;
  const filePath = path.resolve(dir, filename);
  if (!isWithinUploadDir(filePath)) {
    return c.json({ error: "not found" }, 404);
  }
  const contentType = contentTypeForUpload(filename, record?.mimeType);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  const safeName = sanitizeFilename(filename);
  const encodedName = encodeDispositionFilename(filename);
  const disposition = shouldServeInline(contentType) ? "inline" : "attachment";
  c.header("Content-Type", contentType);
  c.header("Content-Length", String(stat.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
  );

  return stream(c, async (s) => {
    const nodeStream = createReadStream(filePath);
    for await (const chunk of nodeStream) {
      await s.write(chunk as Uint8Array);
    }
  });
}

uploadRoutes.get("/files/:fileId", handleFileRequest);
uploadRoutes.get("/files/:fileId/:filename", handleFileRequest);

/**
 * GET /api/v1/materials/:materialId/text?sessionId=... — return the material
 * body text and summary. Scoped to a specific session to prevent cross-session
 * data leakage.
 */
uploadRoutes.get("/materials/:materialId/text", async (c) => {
  const materialId = c.req.param("materialId");
  const sessionId = c.req.query("sessionId");

  if (!sessionId) {
    return c.json({ error: "sessionId query parameter required" }, 400);
  }

  const session = await getOrRestoreSessionReadOnly(sessionId);
  const material = session?.materials.get(materialId);

  if (!material) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({
    text: material.text,
    summary: material.summary,
  });
});
