import { Buffer } from "node:buffer";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  createPinnedLookup,
  hardenInlineSvg,
  validateAndPinFetchUrl,
  type PinnedFetchUrl,
} from "@qingagent/doc-render/browser";
import { localUploadPath, readLocalUploadBuffer } from "@qingagent/doc-render";
import { uploadsBaseDir } from "@qingagent/doc-render/paths";
import { Agent, fetch as undiciFetch } from "undici";

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;
const UPLOADS_BASE = uploadsBaseDir();
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RASTER_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const EDIT_IMAGE_MIME_TYPES = new Set([...RASTER_IMAGE_MIME_TYPES, "image/svg+xml"]);
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

export interface ResolveImageInputOptions {
  allowSvg?: boolean;
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
  if (/Blocked (?:private|loopback)|private hostname|private IPv[46]/i.test(message)) {
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

function allowedImageMimeTypes(options?: ResolveImageInputOptions): ReadonlySet<string> {
  return options?.allowSvg ? EDIT_IMAGE_MIME_TYPES : RASTER_IMAGE_MIME_TYPES;
}

function mimeFromMagic(buffer: Buffer, options?: ResolveImageInputOptions): string | null {
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
  if (
    options?.allowSvg &&
    hardenInlineSvg(buffer.toString("utf8"), { maxBytes: MAX_IMAGE_BYTES })
  ) {
    return "image/svg+xml";
  }
  return null;
}

function assertImageMime(
  buffer: Buffer,
  declaredMimeType?: string | null,
  options?: ResolveImageInputOptions,
): string {
  assertImageSize(buffer.length);
  const allowedMimeTypes = allowedImageMimeTypes(options);
  const declared = contentTypeMime(declaredMimeType ?? null);
  if (declared && !allowedMimeTypes.has(declared)) {
    throw imageInputError("unsupported_media", `不支持的图片 MIME: ${declared}`);
  }
  const magic = mimeFromMagic(buffer, options);
  if (!magic || !allowedMimeTypes.has(magic)) {
    throw imageInputError("unsupported_media", "图片魔数校验失败");
  }
  if (declared && declared !== magic) {
    throw imageInputError("unsupported_media", `图片 MIME 与魔数不符: ${declared} != ${magic}`);
  }
  return magic;
}

/** 素材上传预检复用的图片身份校验；只返回可信魔数 MIME，不暴露内部错误给客户端。 */
export function validateImageBufferMime(
  buffer: Buffer,
  declaredMimeType?: string | null,
): string {
  return assertImageMime(buffer, declaredMimeType);
}

async function readStreamWithLimit(
  response: UndiciResponse,
  abortController: AbortController,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    abortController.abort(imageInputError("too_large", "远程图片响应过大"));
    await response.body?.cancel().catch(() => undefined);
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
        abortController.abort(imageInputError("too_large", "远程图片响应过大"));
        throw imageInputError("too_large", `图片超过 ${MAX_IMAGE_BYTES} 字节上限`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function cancelResponseBody(response: UndiciResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function abortReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new DOMException(fallback, "AbortError");
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      cleanup();
      rejectPromise(abortReason(signal, "图片下载已取消"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        rejectPromise(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function createPinnedImageDispatcher(target: PinnedFetchUrl): Agent {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(target),
    },
  });
}

function extensionFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    case "image/jpeg":
    default:
      return "jpg";
  }
}

export async function downloadRemoteImage(
  rawUrl: string,
  parentSignal?: AbortSignal,
  options?: ResolveImageInputOptions,
): Promise<DownloadedRemoteImage> {
  const deadlineSignal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
  const abortController = new AbortController();
  const signal = AbortSignal.any(
    [parentSignal, deadlineSignal, abortController.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  let currentUrl = rawUrl;
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      signal.throwIfAborted();
      let target: PinnedFetchUrl;
      try {
        target = await awaitWithSignal(validateAndPinFetchUrl(currentUrl), signal);
      } catch (error) {
        if (parentSignal?.aborted) throw abortReason(parentSignal, "图片下载已取消");
        if (deadlineSignal.aborted) {
          throw imageInputError("timeout", `下载远程图片超时(${IMAGE_FETCH_TIMEOUT_MS}ms)`);
        }
        throw classifyFetchGuardError(error);
      }

      // 每一跳使用独立连接池，connect.lookup 只返回本跳已经校验过的 IP；响应处理完成或取消后
      // 立即关闭，避免跨重定向复用错误 origin，也避免 validate 与真实连接再次解析 DNS。
      const dispatcher = createPinnedImageDispatcher(target);
      try {
        const response = await undiciFetch(target.url, {
          dispatcher,
          redirect: "manual",
          signal,
          headers: {
            "User-Agent": FETCH_IMAGE_USER_AGENT,
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await cancelResponseBody(response);
          if (!location) {
            throw imageInputError("network", `图片重定向缺少 Location: ${currentUrl}`);
          }
          if (redirectCount >= MAX_IMAGE_REDIRECTS) {
            throw imageInputError("network", `图片重定向超过 ${MAX_IMAGE_REDIRECTS} 次`);
          }
          currentUrl = new URL(location, target.url).toString();
          continue;
        }

        if (!response.ok) {
          await cancelResponseBody(response);
          throw imageInputError("network", `下载远程图片失败: HTTP ${response.status}`);
        }

        const declaredMimeType = contentTypeMime(response.headers.get("content-type"));
        if (declaredMimeType && !allowedImageMimeTypes(options).has(declaredMimeType)) {
          await cancelResponseBody(response);
          throw imageInputError("unsupported_media", `不支持的图片 MIME: ${declaredMimeType}`);
        }
        const buffer = await readStreamWithLimit(response, abortController);
        const mimeType = assertImageMime(buffer, declaredMimeType, options);
        return {
          buffer,
          mimeType,
          filename: `thumbnail.${extensionFromMime(mimeType)}`,
        };
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }
  } catch (error) {
    if (parentSignal?.aborted) throw abortReason(parentSignal, "图片下载已取消");
    if (error instanceof ImageInputError) throw error;
    if (deadlineSignal.aborted) {
      throw imageInputError("timeout", `下载远程图片超时(${IMAGE_FETCH_TIMEOUT_MS}ms)`);
    }
    throw imageInputError("network", error instanceof Error ? error.message : String(error));
  }
}

function assertUploadContainment(path: string): void {
  const resolved = resolve(path);
  if (resolved !== UPLOADS_BASE && !resolved.startsWith(UPLOADS_BASE + sep)) {
    throw imageInputError("invalid_path", "上传文件路径越权");
  }
}

async function resolveLocalUploadPath(
  src: string,
  options?: ResolveImageInputOptions,
): Promise<ResolvedImageInput> {
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
  return { buffer, mimeType: assertImageMime(buffer, null, options) };
}

async function resolveBareFileId(
  fileId: string,
  options?: ResolveImageInputOptions,
): Promise<ResolvedImageInput> {
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
  return { buffer, mimeType: assertImageMime(buffer, null, options) };
}

// data:image/...;base64,...(正文内联图 / 文档编辑区插入的 base64 图)。
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is;

function resolveDataUrl(
  image: string,
  options?: ResolveImageInputOptions,
): ResolvedImageInput {
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
  return { buffer, mimeType: assertImageMime(buffer, declared, options) };
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

export async function resolveImageInput(
  rawImage: string,
  signal?: AbortSignal,
  options?: ResolveImageInputOptions,
): Promise<ResolvedImageInput> {
  const image = rawImage.trim();
  if (!image) throw imageInputError("invalid_url", "图片输入为空");
  if (image.startsWith("/api/v1/files/")) return resolveLocalUploadPath(image, options);
  if (/^https?:\/\//i.test(image)) return downloadRemoteImage(image, signal, options);
  if (/^data:/i.test(image)) return resolveDataUrl(image, options);
  if (UUID_RE.test(image)) return resolveBareFileId(image, options);
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
