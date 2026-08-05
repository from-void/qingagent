import type { MaterialUploadErrorCode } from "@qingagent/contract-ts";
import { acceptedDocumentExtension } from "../../../system/acceptedDocumentFiles";

export type BrowserMaterialFilePreflightErrorCode = MaterialUploadErrorCode | "material_empty";

export type BrowserMaterialFilePreflightResult =
  | { ok: true }
  | { ok: false; error: BrowserMaterialFilePreflightErrorCode };

const OFFICE_REQUIRED_PARTS: Record<string, readonly string[]> = {
  ".docx": ["[Content_Types].xml", "word/document.xml"],
  ".xlsx": ["[Content_Types].xml", "xl/workbook.xml"],
  ".pptx": ["[Content_Types].xml", "ppt/presentation.xml"],
};
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv"]);
const LEGACY_OFFICE_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);
const OLE_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const IMAGE_MAGIC_BYTES = 12;
const PDF_HEADER_BYTES = IMAGE_MAGIC_BYTES;
const PDF_TAIL_BYTES = 2048;
const OFFICE_HEAD_BYTES = 256 * 1024;
const OFFICE_TAIL_BYTES = 256 * 1024;
const TEXT_SAMPLE_BYTES = 64 * 1024;

const EXPECTED_MIME_TYPES: Record<string, readonly string[]> = {
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".csv": ["text/csv", "text/plain"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/x-markdown", "text/plain"],
  ".markdown": ["text/markdown", "text/x-markdown", "text/plain"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
};

function normalizedMimeType(value: string): string | null {
  return value.split(";")[0]?.trim().toLowerCase() || null;
}

function declaredMimeMatchesExtension(ext: string, mimeType: string): boolean {
  const declared = normalizedMimeType(mimeType);
  if (!declared || declared === "application/octet-stream") return true;
  return EXPECTED_MIME_TYPES[ext]?.includes(declared) ?? false;
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function includesAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  outer: for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function samplesIncludeAscii(samples: readonly Uint8Array[], value: string): boolean {
  return samples.some((sample) => includesAscii(sample, value));
}

function imageMimeFromMagic(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (startsWithBytes(bytes, new Uint8Array([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (includesAscii(bytes.subarray(0, Math.min(bytes.length, 6)), "GIF87a") ||
      includesAscii(bytes.subarray(0, Math.min(bytes.length, 6)), "GIF89a")) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    includesAscii(bytes.subarray(0, 4), "RIFF") &&
    includesAscii(bytes.subarray(8, 12), "WEBP")
  ) {
    return "image/webp";
  }
  return null;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return includesAscii(bytes.subarray(0, Math.min(bytes.length, 5)), "%PDF-");
}

function hasPdfEof(bytes: Uint8Array): boolean {
  return includesAscii(bytes.subarray(Math.max(0, bytes.length - 2048)), "%%EOF");
}

function decodeReadableText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const utf16Encoding = startsWithBytes(bytes, new Uint8Array([0xff, 0xfe]))
    ? "utf-16le"
    : startsWithBytes(bytes, new Uint8Array([0xfe, 0xff]))
      ? "utf-16be"
      : null;
  if (utf16Encoding) {
    if ((bytes.length - 2) % 2 !== 0) return false;
    try {
      const text = new TextDecoder(utf16Encoding, { fatal: true }).decode(bytes.subarray(2));
      return !/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text);
    } catch {
      return false;
    }
  }
  if (bytes.includes(0)) return false;
  for (const encoding of ["utf-8", "gb18030"] as const) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (!/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) return true;
    } catch {
      // 尝试下一种项目解析器支持的编码。
    }
  }
  return false;
}

function detectedKnownMime(bytes: Uint8Array): string | null {
  return imageMimeFromMagic(bytes) ?? (looksLikePdf(bytes) ? "application/pdf" : null);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file_read_failed"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
        return;
      }
      reject(new Error("file_read_failed"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function fileRangeBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  return blobBytes(file.slice(start, end));
}

async function fileHeadAndTail(
  file: File,
  headBytes: number,
  tailBytes: number,
): Promise<readonly Uint8Array[]> {
  const headEnd = Math.min(file.size, headBytes);
  const tailStart = Math.max(headEnd, file.size - tailBytes);
  const head = await fileRangeBytes(file, 0, headEnd);
  if (tailStart >= file.size) return [head];
  return [head, await fileRangeBytes(file, tailStart, file.size)];
}

function failure(error: BrowserMaterialFilePreflightErrorCode): BrowserMaterialFilePreflightResult {
  return { ok: false, error };
}

/** 浏览器低成本预检；服务端仍会用完整 ZIP/图片原语做权威校验。 */
export async function preflightBrowserMaterialFile(
  file: File,
): Promise<BrowserMaterialFilePreflightResult> {
  const ext = acceptedDocumentExtension(file.name);
  if (!EXPECTED_MIME_TYPES[ext]) return failure("material_unsupported");
  if (!declaredMimeMatchesExtension(ext, file.type)) {
    return failure("material_format_mismatch");
  }

  if (file.size === 0) return failure("material_empty");

  try {
    if (IMAGE_EXTENSIONS.has(ext)) {
      const bytes = await fileRangeBytes(file, 0, IMAGE_MAGIC_BYTES);
      const detected = imageMimeFromMagic(bytes);
      if (!detected) return failure("material_unreadable");
      return EXPECTED_MIME_TYPES[ext]?.includes(detected)
        ? { ok: true }
        : failure("material_format_mismatch");
    }

    if (ext === ".pdf") {
      const head = await fileRangeBytes(file, 0, PDF_HEADER_BYTES);
      if (!looksLikePdf(head)) {
        return failure(detectedKnownMime(head)
          ? "material_format_mismatch"
          : "material_unreadable");
      }
      const tail = await fileRangeBytes(file, Math.max(0, file.size - PDF_TAIL_BYTES), file.size);
      return hasPdfEof(tail) ? { ok: true } : failure("material_unreadable");
    }

    const requiredParts = OFFICE_REQUIRED_PARTS[ext];
    if (requiredParts) {
      const samples = await fileHeadAndTail(file, OFFICE_HEAD_BYTES, OFFICE_TAIL_BYTES);
      const head = samples[0]!;
      if (!startsWithBytes(head, new Uint8Array([0x50, 0x4b]))) {
        return failure(detectedKnownMime(head)
          ? "material_format_mismatch"
          : "material_unreadable");
      }
      return requiredParts.every((part) => samplesIncludeAscii(samples, part))
        ? { ok: true }
        : failure("material_format_mismatch");
    }

    if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
      const bytes = await fileRangeBytes(file, 0, OLE_MAGIC.length);
      return startsWithBytes(bytes, OLE_MAGIC)
        ? { ok: true }
        : failure(detectedKnownMime(bytes)
          ? "material_format_mismatch"
          : "material_unreadable");
    }

    if (TEXT_EXTENSIONS.has(ext)) {
      const bytes = await fileRangeBytes(file, 0, TEXT_SAMPLE_BYTES);
      return decodeReadableText(bytes) ? { ok: true } : failure("material_unreadable");
    }
  } catch {
    return failure("material_unreadable");
  }
  return failure("material_unsupported");
}

export function materialPreflightErrorMessage(error: BrowserMaterialFilePreflightErrorCode): string {
  switch (error) {
    case "material_empty":
      return "文件内容为空";
    case "material_format_mismatch":
      return "文件格式与内容不一致";
    case "material_unreadable":
      return "文件无法读取";
    case "material_unsupported":
      return "暂不支持这种文件";
  }
}
