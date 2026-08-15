import path from "node:path";
import { isSafeUploadFilename, normalizeUploadMimeType } from "./uploadServing";

export type ExternalAssetUploadInput = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
};

export type ExternalAssetUploadInputError =
  | "invalid_body"
  | "invalid_filename"
  | "invalid_base64"
  | "empty_file"
  | "unsupported_media"
  | "file_too_large";

export type ExternalAssetUploadInputResult =
  | { ok: true; input: ExternalAssetUploadInput }
  | { ok: false; error: ExternalAssetUploadInputError };

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** 严格 RFC 4648 base64；拒绝 Buffer.from 会静默吞掉的脏字符与错误 padding。 */
export function decodeExternalAssetBase64(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    return null;
  }
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && firstPadding < value.length - 2) return null;
  const unpadded = value.replace(/=+$/, "");
  if (!unpadded) return null;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const buffer = Buffer.from(padded, "base64");
  return buffer.toString("base64").replace(/=+$/, "") === unpadded
    ? buffer
    : null;
}

function imageMimeType(filename: string, rawMimeType: string | null | undefined): string | null {
  const normalized = normalizeUploadMimeType(rawMimeType);
  if (normalized?.startsWith("image/")) return normalized;
  if (normalized && normalized !== "application/octet-stream") return null;
  return IMAGE_MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] ?? null;
}

export function validateExternalAssetUploadInput(
  input: { filename: unknown; mimeType: unknown; buffer: Buffer },
  maxBytes: number,
): ExternalAssetUploadInputResult {
  if (typeof input.filename !== "string" || !input.filename) {
    return { ok: false, error: "invalid_filename" };
  }
  if (!isSafeUploadFilename(input.filename)) {
    return { ok: false, error: "invalid_filename" };
  }
  if (input.buffer.byteLength === 0) return { ok: false, error: "empty_file" };
  if (input.buffer.byteLength > maxBytes) return { ok: false, error: "file_too_large" };
  const mimeType = imageMimeType(
    input.filename,
    typeof input.mimeType === "string" ? input.mimeType : null,
  );
  if (!mimeType) return { ok: false, error: "unsupported_media" };
  return {
    ok: true,
    input: { filename: input.filename, mimeType, buffer: input.buffer },
  };
}

export function parseExternalAssetJson(
  value: unknown,
  maxBytes: number,
): ExternalAssetUploadInputResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_body" };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.base64 !== "string") return { ok: false, error: "invalid_base64" };
  const buffer = decodeExternalAssetBase64(body.base64);
  if (!buffer) return { ok: false, error: "invalid_base64" };
  return validateExternalAssetUploadInput(
    { filename: body.filename, mimeType: body.mimeType, buffer },
    maxBytes,
  );
}
