import type { MaterialUploadErrorCode } from "@qingagent/contract-ts";
import { decodeTextBuffer, loadSafeOfficeZip } from "./parseFile.js";
import { validateImageBufferMime } from "./imageInput.js";

export interface MaterialFilePreflightInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string | null;
  signal?: AbortSignal;
}

export type MaterialFilePreflightResult =
  | { ok: true; detectedMimeType: string | null }
  | { ok: false; error: MaterialUploadErrorCode };

const OFFICE_REQUIRED_PARTS: Record<string, readonly string[]> = {
  docx: ["[Content_Types].xml", "word/document.xml"],
  xlsx: ["[Content_Types].xml", "xl/workbook.xml"],
  pptx: ["[Content_Types].xml", "ppt/presentation.xml"],
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv"]);
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls", "ppt"]);
const SUPPORTED_EXTENSIONS = new Set([
  "pdf",
  ...Object.keys(OFFICE_REQUIRED_PARTS),
  ...IMAGE_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...LEGACY_OFFICE_EXTENSIONS,
]);

const EXPECTED_MIME_TYPES: Record<string, readonly string[]> = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "text/plain"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
  markdown: ["text/markdown", "text/x-markdown", "text/plain"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  webp: ["image/webp"],
  gif: ["image/gif"],
};

const OLE_COMPOUND_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index < 0 ? "" : filename.slice(index + 1).toLowerCase();
}

function normalizedMimeType(value: string | null | undefined): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

function declaredMimeMatchesExtension(ext: string, mimeType: string | null | undefined): boolean {
  const declared = normalizedMimeType(mimeType);
  if (!declared || declared === "application/octet-stream") return true;
  return EXPECTED_MIME_TYPES[ext]?.includes(declared) ?? false;
}

function hasPrefix(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function hasPdfEof(buffer: Buffer): boolean {
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  return tail.includes("%%EOF");
}

function detectedNonOfficeMime(buffer: Buffer): string | null {
  try {
    return validateImageBufferMime(buffer);
  } catch {
    if (looksLikePdf(buffer)) return "application/pdf";
    return null;
  }
}

function failure(error: MaterialUploadErrorCode): MaterialFilePreflightResult {
  return { ok: false, error };
}

/**
 * 聊天素材的服务端权威预检：只验证文件身份、容器安全与基本可读性，不做模型工作，
 * 也不替代后续 parseFile/readImage。
 */
export async function preflightMaterialFileBuffer({
  buffer,
  filename,
  mimeType,
  signal,
}: MaterialFilePreflightInput): Promise<MaterialFilePreflightResult> {
  signal?.throwIfAborted();
  const ext = extensionOf(filename);
  if (!SUPPORTED_EXTENSIONS.has(ext)) return failure("material_unsupported");
  if (buffer.length === 0) return failure("material_unreadable");
  if (!declaredMimeMatchesExtension(ext, mimeType)) {
    return failure("material_format_mismatch");
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const declaredMimeType = normalizedMimeType(mimeType);
      const detectedMimeType = validateImageBufferMime(
        buffer,
        declaredMimeType === "application/octet-stream" ? null : declaredMimeType,
      );
      if (!EXPECTED_MIME_TYPES[ext]?.includes(detectedMimeType)) {
        return failure("material_format_mismatch");
      }
      return { ok: true, detectedMimeType };
    } catch {
      return failure(detectedNonOfficeMime(buffer)
        ? "material_format_mismatch"
        : "material_unreadable");
    }
  }

  if (ext === "pdf") {
    if (!looksLikePdf(buffer)) {
      return failure(detectedNonOfficeMime(buffer)
        ? "material_format_mismatch"
        : "material_unreadable");
    }
    return hasPdfEof(buffer)
      ? { ok: true, detectedMimeType: "application/pdf" }
      : failure("material_unreadable");
  }

  const requiredParts = OFFICE_REQUIRED_PARTS[ext];
  if (requiredParts) {
    if (!hasPrefix(buffer, Buffer.from("PK"))) {
      return failure(detectedNonOfficeMime(buffer)
        ? "material_format_mismatch"
        : "material_unreadable");
    }
    try {
      const zip = await loadSafeOfficeZip(buffer, signal);
      signal?.throwIfAborted();
      if (!requiredParts.every((part) => zip.file(part))) {
        return failure("material_format_mismatch");
      }
      return { ok: true, detectedMimeType: EXPECTED_MIME_TYPES[ext]?.[0] ?? null };
    } catch {
      signal?.throwIfAborted();
      return failure("material_unreadable");
    }
  }

  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    return hasPrefix(buffer, OLE_COMPOUND_MAGIC)
      ? { ok: true, detectedMimeType: EXPECTED_MIME_TYPES[ext]?.[0] ?? null }
      : failure(detectedNonOfficeMime(buffer)
        ? "material_format_mismatch"
        : "material_unreadable");
  }

  try {
    decodeTextBuffer(buffer);
    return { ok: true, detectedMimeType: normalizedMimeType(mimeType) };
  } catch {
    return failure("material_unreadable");
  }
}
