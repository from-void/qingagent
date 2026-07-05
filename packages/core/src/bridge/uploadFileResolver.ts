import fs from "node:fs/promises";
import path from "node:path";
import { uploadsBaseDir } from "../workspace/uploadsDir.js";

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

export function isValidUploadId(fileId: unknown): fileId is string {
  return typeof fileId === "string" && UUID_RE.test(fileId);
}

function isWithinUploadRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function warnSkippedUploadFile(fileId: unknown, reason: string, error?: unknown): void {
  console.warn("[uploadFileResolver] 跳过不安全或不可用的上传文件", {
    fileId,
    reason,
    error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
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

    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
    results.push({ fileId, filename, filePath: fileRealPath, mimeType });
  }

  return results;
}
