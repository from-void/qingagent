import { Buffer } from "node:buffer";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { validateFetchUrl } from "../browser/extractor.js";
import { localUploadPath, readLocalUploadBuffer } from "../export/shared.js";
import { uploadsBaseDir } from "../workspace/uploadsDir.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;
const UPLOADS_BASE = uploadsBaseDir();
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const FETCH_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type ImageInputErrorKind =
  | "invalid_url"
  | "invalid_path"
  | "not_found"
  | "too_large"
  | "unsupported_media"
  | "ssrf_blocked"
  | "timeout"
  | "network";

export class ImageInputError extends Error {
  constructor(
    public readonly kind: ImageInputErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ImageInputError";
  }
}

export interface ResolvedImageInput {
  buffer: Buffer;
  mimeType: string;
}

export interface DownloadedRemoteImage extends ResolvedImageInput {
  filename: string;
}

function imageInputError(kind: ImageInputErrorKind, message: string): ImageInputError {
  return new ImageInputError(kind, message);
}

function classifyFetchGuardError(error: unknown): ImageInputError {
  if (error instanceof ImageInputError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/Blocked private|private hostname|private IPv[46]/i.test(message)) {
    return imageInputError("ssrf_blocked", message);
  }
  if (/Invalid URL|Unsupported URL scheme/i.test(message)) {
    return imageInputError("invalid_url", message);
  }
  return imageInputError("network", message);
}

function assertImageSize(size: number): void {
  if (size > MAX_IMAGE_BYTES) {
    throw imageInputError("too_large", `图片超过 ${MAX_IMAGE_BYTES} 字节上限`);
  }
}

function contentTypeMime(value: string | null): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

function mimeFromMagic(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" ||
      buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function assertImageMime(buffer: Buffer, declaredMimeType?: string | null): string {
  assertImageSize(buffer.length);
  const declared = contentTypeMime(declaredMimeType ?? null);
  if (declared && !IMAGE_MIME_TYPES.has(declared)) {
    throw imageInputError("unsupported_media", `不支持的图片 MIME: ${declared}`);
  }
  const magic = mimeFromMagic(buffer);
  if (!magic || !IMAGE_MIME_TYPES.has(magic)) {
    throw imageInputError("unsupported_media", "图片魔数校验失败");
  }
  if (declared && declared !== magic) {
    throw imageInputError("unsupported_media", `图片 MIME 与魔数不符: ${declared} != ${magic}`);
  }
  return magic;
}

async function readStreamWithLimit(
  response: Response,
  abortController: AbortController,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    abortController.abort();
    throw imageInputError("too_large", `图片超过 ${MAX_IMAGE_BYTES} 字节上限`);
  }
  if (!response.body) {
    throw imageInputError("network", "远程图片响应没有 body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        abortController.abort();
        throw imageInputError("too_large", `图片超过 ${MAX_IMAGE_BYTES} 字节上限`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/jpeg":
    default:
      return "jpg";
  }
}

export async function downloadRemoteImage(
  rawUrl: string,
  redirectCount = 0,
): Promise<DownloadedRemoteImage> {
  if (redirectCount > MAX_IMAGE_REDIRECTS) {
    throw imageInputError("network", `图片重定向超过 ${MAX_IMAGE_REDIRECTS} 次`);
  }

  let url: URL;
  try {
    url = await validateFetchUrl(rawUrl);
  } catch (error) {
    throw classifyFetchGuardError(error);
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: abortController.signal,
      headers: {
        "User-Agent": FETCH_IMAGE_USER_AGENT,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw imageInputError("network", `图片重定向缺少 Location: ${rawUrl}`);
      }
      return downloadRemoteImage(new URL(location, url).toString(), redirectCount + 1);
    }

    if (!response.ok) {
      throw imageInputError("network", `下载远程图片失败: HTTP ${response.status}`);
    }

    const declaredMimeType = contentTypeMime(response.headers.get("content-type"));
    if (declaredMimeType && !IMAGE_MIME_TYPES.has(declaredMimeType)) {
      throw imageInputError("unsupported_media", `不支持的图片 MIME: ${declaredMimeType}`);
    }
    const buffer = await readStreamWithLimit(response, abortController);
    const mimeType = assertImageMime(buffer, declaredMimeType);
    return {
      buffer,
      mimeType,
      filename: `thumbnail.${extensionFromMime(mimeType)}`,
    };
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw imageInputError("timeout", `下载远程图片超时(${IMAGE_FETCH_TIMEOUT_MS}ms)`);
    }
    throw imageInputError("network", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

function assertUploadContainment(path: string): void {
  const resolved = resolve(path);
  if (resolved !== UPLOADS_BASE && !resolved.startsWith(UPLOADS_BASE + sep)) {
    throw imageInputError("invalid_path", "上传文件路径越权");
  }
}

async function resolveLocalUploadPath(src: string): Promise<ResolvedImageInput> {
  const path = localUploadPath(src);
  if (!path) throw imageInputError("invalid_path", "本地图片路径非法");
  assertUploadContainment(path);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch {
    throw imageInputError("not_found", "本地图片不存在");
  }
  assertImageSize(fileStat.size);
  const buffer = readLocalUploadBuffer(src);
  if (!buffer) throw imageInputError("not_found", "本地图片不存在");
  return { buffer, mimeType: assertImageMime(buffer, null) };
}

async function resolveBareFileId(fileId: string): Promise<ResolvedImageInput> {
  if (!UUID_RE.test(fileId)) {
    throw imageInputError("invalid_path", "fileId 不是合法 UUID");
  }
  const dir = resolve(UPLOADS_BASE, fileId);
  assertUploadContainment(dir);
  let files: string[];
  try {
    files = (await readdir(dir)).sort();
  } catch {
    throw imageInputError("not_found", "fileId 对应的上传目录不存在");
  }
  const filename = files.find((file) => file && basename(file) === file);
  if (!filename) throw imageInputError("not_found", "fileId 对应的上传目录为空");
  const filePath = resolve(dir, filename);
  assertUploadContainment(filePath);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw imageInputError("not_found", "fileId 对应的文件不存在");
  }
  assertImageSize(fileStat.size);
  const buffer = await readFile(filePath);
  return { buffer, mimeType: assertImageMime(buffer, null) };
}

// data:image/...;base64,...(正文内联图 / 文档编辑区插入的 base64 图)。
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is;

function resolveDataUrl(image: string): ResolvedImageInput {
  const m = DATA_URL_RE.exec(image);
  const declared = m?.[1]?.toLowerCase();
  if (!declared || !/;base64/i.test(m?.[2] ?? "")) {
    throw imageInputError("unsupported_media", "仅支持 base64 编码的 data:image URL");
  }
  const b64 = (m?.[3] ?? "").replace(/\s+/g, "");
  if (b64.length > MAX_IMAGE_BASE64_CHARS) {
    throw imageInputError("too_large", `base64 图片超过 ${MAX_IMAGE_BASE64_CHARS} 字符上限`);
  }
  const buffer = Buffer.from(b64, "base64");
  // assertImageMime 已做 体积 + MIME 白名单 + 魔数 + 声明/魔数一致性校验
  return { buffer, mimeType: assertImageMime(buffer, declared) };
}

function isLikelyBase64Image(value: string): boolean {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function rejectBase64LikeInput(value: string): never {
  if (value.length > MAX_IMAGE_BASE64_CHARS) {
    throw imageInputError("too_large", `base64 图片超过 ${MAX_IMAGE_BASE64_CHARS} 字符上限`);
  }
  throw imageInputError("invalid_url", "裸 base64 不受支持,请用 data:image/...;base64, 前缀");
}

export async function resolveImageInput(rawImage: string): Promise<ResolvedImageInput> {
  const image = rawImage.trim();
  if (!image) throw imageInputError("invalid_url", "图片输入为空");
  if (image.startsWith("/api/v1/files/")) return resolveLocalUploadPath(image);
  if (/^https?:\/\//i.test(image)) return downloadRemoteImage(image);
  if (/^data:/i.test(image)) return resolveDataUrl(image);
  if (UUID_RE.test(image)) return resolveBareFileId(image);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(image)) {
    throw imageInputError("invalid_url", "图片 URL 只支持 http(s)");
  }
  if (image.includes("..") || image.includes("/") || image.includes("\\") || image.startsWith("file:")) {
    throw imageInputError("invalid_path", "图片路径非法");
  }
  if (isLikelyBase64Image(image)) return rejectBase64LikeInput(image);
  throw imageInputError("invalid_url", "readImage 只接受 http(s)、/api/v1/files/<id>/<name> 或 fileId");
}

async function filenameForFileId(fileId: string): Promise<string | null> {
  if (!UUID_RE.test(fileId)) return null;
  const dir = resolve(UPLOADS_BASE, fileId);
  try {
    assertUploadContainment(dir);
    const files = (await readdir(dir)).sort();
    return files.find((file) => file && basename(file) === file) ?? null;
  } catch {
    return null;
  }
}

export async function thumbnailSrcForImageInput(rawImage: string): Promise<string | null> {
  const image = rawImage.trim();
  if (image.startsWith("/api/v1/files/")) {
    return localUploadPath(image) ? image : null;
  }
  if (UUID_RE.test(image)) {
    const filename = await filenameForFileId(image);
    return filename ? `/api/v1/files/${image}/${filename}` : null;
  }
  return null;
}

export function looksLikeSupportedImageFilename(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif";
}
