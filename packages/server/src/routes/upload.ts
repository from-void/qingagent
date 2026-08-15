import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  UPLOAD_FILENAME_HEADER,
  UPLOAD_PURPOSE_HEADER,
  UPLOAD_SESSION_HEADER,
  type UploadPurpose,
} from "@qingagent/contract-ts";
import {
  hasActiveSessionResource,
  registerSessionResource,
} from "@qingagent/db";
import { preflightMaterialFileBuffer } from "@qingagent/core/material-preflight";
import { getOrRestoreSessionReadOnly } from "../gateway/sessionLifecycle";
import {
  findOrStoreUploadedFile,
  isValidUploadId,
  deleteUploadedFile,
} from "../lib/uploadStorage";
import { requireTrustedOrigin } from "../lib/trustedOrigin";
import { resolveUploadMaxBytes } from "../lib/uploadLimits";
import {
  isSafeUploadFilename,
  normalizeUploadMimeType,
  resolveUploadedFileForRead,
  streamResolvedUploadedFile,
} from "../lib/uploadServing";

export const uploadRoutes = new Hono();
const uploadMaxBytes = resolveUploadMaxBytes();
function decodeUploadFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return null;
  }
}

/**
 * POST /api/v1/upload — receive raw file bytes, with encoded filename/purpose in headers,
 * and persist them to disk under ./uploads/<fileId>/<filename>.
 * Returns { fileId, filename, mimeType, size }.
 */
uploadRoutes.post(
  "/upload",
  bodyLimit({
    maxSize: uploadMaxBytes,
    onError: (c) => c.json({ error: "file_too_large", maxBytes: uploadMaxBytes }, 413),
  }),
  async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    const filename = decodeUploadFilename(c.req.header(UPLOAD_FILENAME_HEADER));
    if (!filename) {
      return c.json({ error: "filename required" }, 400);
    }

    if (!isSafeUploadFilename(filename)) {
      return c.json({ error: "filename must not contain path separators or '..'" }, 400);
    }

    const purposeHeader = c.req.header(UPLOAD_PURPOSE_HEADER);
    if (purposeHeader && purposeHeader !== "material") {
      return c.json({ error: "invalid purpose" }, 400);
    }
    const purpose: UploadPurpose | undefined = purposeHeader === "material"
      ? "material"
      : undefined;
    const sessionId = c.req.header(UPLOAD_SESSION_HEADER)?.trim();
    if (!sessionId) {
      return c.json({ error: "session required" }, 400);
    }
    const buffer = Buffer.from(await c.req.arrayBuffer());
    if (buffer.byteLength === 0) {
      return c.json({ error: "empty file" }, 400);
    }
    if (buffer.byteLength > uploadMaxBytes) {
      return c.json({ error: "file_too_large", maxBytes: uploadMaxBytes }, 413);
    }
    const normalizedMimeType = normalizeUploadMimeType(c.req.header("content-type"))
      ?? "application/octet-stream";
    if (purpose === "material") {
      const preflight = await preflightMaterialFileBuffer({
        buffer,
        filename,
        mimeType: normalizedMimeType,
      });
      if (!preflight.ok) {
        return c.json({ error: preflight.error }, 422);
      }
    }
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
    try {
      await registerSessionResource({
        sessionId,
        resourceId: record.fileId,
        kind: "upload",
      });
    } catch (error) {
      await deleteUploadedFile(record.fileId);
      throw error;
    }

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
  if (requestedFilename && !isSafeUploadFilename(requestedFilename)) {
    return c.json({ error: "invalid filename" }, 400);
  }
  if (!(await hasActiveSessionResource(fileId))) {
    return c.json({ error: "not found" }, 404);
  }
  const resolved = await resolveUploadedFileForRead(fileId, requestedFilename);
  if (!resolved.ok) {
    if (resolved.error === "invalid_filename") {
      return c.json({ error: "invalid filename" }, 400);
    }
    if (resolved.error === "invalid_file_id") {
      return c.json({ error: "invalid fileId" }, 400);
    }
    return c.json({ error: "not found" }, 404);
  }
  return streamResolvedUploadedFile(c, resolved.file);
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
