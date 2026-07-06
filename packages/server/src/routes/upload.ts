import { Hono } from "hono";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findMaterial } from "../bridge/bridgeHandler";
import { UPLOAD_DIR, findOrStoreUploadedFile, isValidUploadId, isWithinUploadDir } from "../lib/uploadStorage";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { parseBody } from "../lib/validation";

export const uploadRoutes = new Hono();

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
uploadRoutes.post("/upload", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  const parsed = await parseBody(c, uploadBodySchema);
  if (!parsed.ok) return parsed.response;
  const { filename, mimeType, content } = parsed.data;

  if (!isSafeFilename(filename)) {
    return c.json({ error: "filename must not contain path separators or '..'" }, 400);
  }

  const buffer = Buffer.from(content, "base64");
  const normalizedMimeType = mimeType || "application/octet-stream";
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
});

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

  const filename = files[0]!;
  const filePath = path.resolve(dir, filename);
  if (!isWithinUploadDir(filePath)) {
    return c.json({ error: "not found" }, 404);
  }
  const contentType = mimeFromExt(filename);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  const safeName = sanitizeFilename(filename);
  const disposition = shouldServeInline(contentType) ? "inline" : "attachment";
  c.header("Content-Type", contentType);
  c.header("Content-Length", String(stat.size));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Disposition", `${disposition}; filename="${safeName}"`);

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

  const material = findMaterial(sessionId, materialId);

  if (!material) {
    return c.json({ error: "not found" }, 404);
  }

  return c.json({
    text: material.text,
    summary: material.summary,
  });
});
