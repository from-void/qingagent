import type {
  MaterialUploadErrorCode,
  UploadPurpose,
} from "@qingagent/contract-ts";
import {
  removeUnpairedSurrogates,
  UPLOAD_FILENAME_HEADER,
  UPLOAD_PURPOSE_HEADER,
} from "@qingagent/contract-ts";
import { materialPreflightErrorMessage } from "./materialFilePreflight";

export interface UploadedAsset {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface UploadAssetOptions {
  onProgress?: (progress: number | null) => void;
  purpose?: UploadPurpose;
}

export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type UploadAssetErrorCode =
  | MaterialUploadErrorCode
  | "file_too_large"
  | "network"
  | "upload_failed"
  | "invalid_response";

export class UploadAssetError extends Error {
  constructor(
    public readonly code: UploadAssetErrorCode,
    public readonly file: File,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadAssetError";
  }
}

function formatUploadLimit(maxBytes: number): string {
  const mib = maxBytes / (1024 * 1024);
  if (mib >= 1) return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
  const kib = maxBytes / 1024;
  if (kib >= 1) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KB`;
  return `${maxBytes} 字节`;
}

function fileTooLargeMessage(maxBytes: number): string {
  return `文件过大（上限 ${formatUploadLimit(maxBytes)}）`;
}

export function uploadFileSizeError(file: Pick<File, "size">): Error | null {
  return file.size > DEFAULT_UPLOAD_MAX_BYTES
    ? new Error(fileTooLargeMessage(DEFAULT_UPLOAD_MAX_BYTES))
    : null;
}

export function uploadFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof UploadAssetError) return error.message;
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("文件过大（上限 ") ? message : fallback;
}

export async function uploadAssetFile(file: File, options: UploadAssetOptions = {}): Promise<UploadedAsset> {
  const sizeError = uploadFileSizeError(file);
  if (sizeError) throw sizeError;
  return uploadBinary(file, options);
}

export function uploadedAssetUrl(asset: Pick<UploadedAsset, "fileId" | "filename">): string {
  return `/api/v1/files/${encodeURIComponent(asset.fileId)}/${encodeURIComponent(asset.filename)}`;
}

function uploadBinary(file: File, options: UploadAssetOptions): Promise<UploadedAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/upload");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader(
      UPLOAD_FILENAME_HEADER,
      encodeURIComponent(removeUnpairedSurrogates(file.name)),
    );
    if (options.purpose) {
      xhr.setRequestHeader(UPLOAD_PURPOSE_HEADER, options.purpose);
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        options.onProgress?.(null);
        return;
      }
      options.onProgress?.(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onerror = () => reject(new UploadAssetError(
      "network",
      file,
      "文件上传失败，请重试",
      true,
    ));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 413) {
          reject(new UploadAssetError(
            "file_too_large",
            file,
            fileTooLargeMessage(readUploadMaxBytes(xhr.responseText) ?? DEFAULT_UPLOAD_MAX_BYTES),
            false,
          ));
          return;
        }
        const errorCode = readMaterialUploadErrorCode(xhr.responseText);
        if (errorCode) {
          reject(new UploadAssetError(
            errorCode,
            file,
            materialPreflightErrorMessage(errorCode),
            false,
          ));
          return;
        }
        reject(new UploadAssetError(
          "upload_failed",
          file,
          "文件上传失败，请重试",
          xhr.status >= 500,
        ));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as UploadedAsset);
      } catch {
        reject(new UploadAssetError(
          "invalid_response",
          file,
          "文件已上传，但回执无法确认，请重试",
          true,
        ));
      }
    };
    // 直接交给浏览器网络栈发送 Blob，避免 arrayBuffer/base64/JSON 的整文件副本。
    xhr.send(file);
  });
}

function readUploadMaxBytes(text: string): number | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object") return null;
    const maxBytes = (body as Record<string, unknown>).maxBytes;
    return typeof maxBytes === "number" && Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : null;
  } catch {
    return null;
  }
}

function readMaterialUploadErrorCode(text: string): MaterialUploadErrorCode | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object") return null;
    const code = (body as Record<string, unknown>).error;
    if (
      code === "material_format_mismatch" ||
      code === "material_unreadable" ||
      code === "material_unsupported"
    ) {
      return code;
    }
  } catch {
    return null;
  }
  return null;
}
