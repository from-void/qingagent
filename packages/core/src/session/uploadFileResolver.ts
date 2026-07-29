import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { uploadsBaseDir } from "@qingagent/doc-render/paths";

export type ResolvedUploadedFile = {
  fileId: string;
  filename: string;
  filePath: string;
  mimeType: string;
};

export const UPLOADS_BASE = uploadsBaseDir();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function inferMimeTypeFromFilename(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? null;
}

export function isValidUploadId(fileId: unknown): fileId is string {
  return typeof fileId === "string" && UUID_RE.test(fileId);
}

function isWithinUploadRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function warnSkippedUploadFile(fileId: unknown, reason: string, error?: unknown): void {
  const errorRecord = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : null;
  console.warn("[uploadFileResolver] 跳过不安全或不可用的上传文件", {
    fileIdHash: typeof fileId === "string"
      ? createHash("sha256").update(fileId).digest("hex").slice(0, 12)
      : null,
    fileIdType: typeof fileId,
    reason,
    errorName: typeof errorRecord?.name === "string" ? errorRecord.name : null,
    errorCode: typeof errorRecord?.code === "string" ? errorRecord.code : null,
  });
}

export async function resolveFileIds(
  fileIds: readonly unknown[],
): Promise<ResolvedUploadedFile[]> {
  if (fileIds.length === 0) return [];

  const results: ResolvedUploadedFile[] = [];
  let uploadsRootRealPath: string | null = null;

  const getUploadsRootRealPath = async () => {
    uploadsRootRealPath ??= await fs.realpath(UPLOADS_BASE);
    return uploadsRootRealPath;
  };

  for (const fileId of fileIds) {
    if (!isValidUploadId(fileId)) {
      warnSkippedUploadFile(fileId, "fileId 不是合法 UUID");
      continue;
    }

    let rootRealPath: string;
    let dirRealPath: string;
    try {
      rootRealPath = await getUploadsRootRealPath();
      dirRealPath = await fs.realpath(path.resolve(UPLOADS_BASE, fileId));
    } catch (error) {
      warnSkippedUploadFile(fileId, "上传目录不存在或不可访问", error);
      continue;
    }

    if (!isWithinUploadRoot(rootRealPath, dirRealPath)) {
      warnSkippedUploadFile(fileId, "上传目录 realpath 不在 uploads 根目录内");
      continue;
    }

    let files: string[];
    try {
      files = await fs.readdir(dirRealPath);
    } catch (error) {
      warnSkippedUploadFile(fileId, "上传目录读取失败", error);
      continue;
    }

    if (files.length === 0) {
      warnSkippedUploadFile(fileId, "上传目录为空");
      continue;
    }

    const filename = files[0]!;
    let fileRealPath: string;
    try {
      fileRealPath = await fs.realpath(path.resolve(dirRealPath, filename));
    } catch (error) {
      warnSkippedUploadFile(fileId, "上传文件不存在或不可访问", error);
      continue;
    }

    if (!isWithinUploadRoot(rootRealPath, fileRealPath)) {
      warnSkippedUploadFile(fileId, "上传文件 realpath 不在 uploads 根目录内");
      continue;
    }

    const mimeType = inferMimeTypeFromFilename(filename) ?? "application/octet-stream";
    results.push({ fileId, filename, filePath: fileRealPath, mimeType });
  }

  return results;
}
