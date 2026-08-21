import { createHash } from "node:crypto";
import { FormData } from "undici";
import { isOfficialDeepseekBaseUrl } from "./modelBaseUrl.js";
import { modelFetch } from "./modelTransport.js";

export const DEEPSEEK_FILE_SENTINEL_HOST = "qingagent-file-id.invalid";
// 约束:不得带 g 标志——supportedUrls 白名单与 transform 共享它，.test 的 lastIndex 会导致间歇失配；
// AI SDK 的 isUrlSupported 匹配前会把 URL 转为小写，字符类必须对全小写输入成立。
export const DEEPSEEK_FILE_SENTINEL_URL_RE =
  /^https:\/\/qingagent-file-id\.invalid\/file-api-[A-Za-z0-9-]+$/;

const FILE_ID_RE = /^file-api-[A-Za-z0-9-]+$/;
const FILE_CACHE_MAX = 128;
const FILE_CACHE_MIN_REMAINING_MS = 60 * 60 * 1_000;
const FILE_UPLOAD_TIMEOUT_MS = 30_000;
const FILE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

interface FileCacheEntry {
  fileId: string;
  expiresAtMs: number;
}

/** 传输层只关心这四个字段;结构类型使 ResolvedVisionConfig 天然兼容,避免反向依赖 modelConfig 成环。 */
export interface DeepseekFileTransportConfig {
  provider: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
}

const fileCache = new Map<string, FileCacheEntry>();
const uploadInFlight = new Map<string, Promise<FileCacheEntry>>();

export interface DeepseekFileTransport {
  /** 返回哨兵 URL 与本次实际使用的 fileId;上传失败抛错,由调用方降级内联。 */
  ensureFileSentinelUrl(
    image: { buffer: Buffer; mimeType: string },
    signal?: AbortSignal,
  ): Promise<{ sentinelUrl: string; fileId: string }>;
  /** 仅剔除仍指向失败 id 的条目，避免并发刷新后误删新 id。 */
  invalidate(image: { buffer: Buffer }, failedFileId: string): void;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileCacheKey(apiKey: string, buffer: Buffer): string {
  // Files 归属 API key，密钥指纹必须进入键但不能在内存键或日志中留下明文。
  return `${sha256(apiKey)}:${sha256(buffer)}`;
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.toLowerCase().split("/", 2)[1] ?? "bin";
  const aliases: Record<string, string> = {
    jpeg: "jpg",
    "svg+xml": "svg",
    "x-icon": "ico",
  };
  const extension = aliases[subtype] ?? subtype;
  return /^[a-z0-9]+$/.test(extension) ? extension : "bin";
}

function sentinelUrl(fileId: string): string {
  return `https://${DEEPSEEK_FILE_SENTINEL_HOST}/${fileId}`;
}

function refreshCachedFile(key: string, now: number): FileCacheEntry | null {
  const cached = fileCache.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs - now < FILE_CACHE_MIN_REMAINING_MS) {
    fileCache.delete(key);
    return null;
  }
  fileCache.delete(key);
  fileCache.set(key, cached);
  return cached;
}

function cacheUploadedFile(key: string, entry: FileCacheEntry): void {
  fileCache.delete(key);
  fileCache.set(key, entry);
  if (fileCache.size <= FILE_CACHE_MAX) return;
  const oldest = fileCache.keys().next().value;
  // 远端 TTL 负责回收；淘汰时 DELETE 会使已取得 id、尚未发出的并发 chat 必然失败。
  if (oldest !== undefined) fileCache.delete(oldest);
}

async function uploadFile(
  config: DeepseekFileTransportConfig,
  image: { buffer: Buffer; mimeType: string },
  signal?: AbortSignal,
): Promise<FileCacheEntry> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener("abort", relayAbort, { once: true });
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("DeepSeek Files upload timed out", "TimeoutError"));
  }, FILE_UPLOAD_TIMEOUT_MS);

  // 必须与 modelFetch 底层 undici 同源；全局 FormData 跨实现会产生 Invalid boundary 400。
  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
    `image.${imageExtension(image.mimeType)}`,
  );
  body.append("purpose", "user_data");
  body.append("expires_after[anchor]", "created_at");
  body.append("expires_after[seconds]", String(FILE_RETENTION_SECONDS));

  try {
    let response: Response;
    try {
      response = await modelFetch(`${config.baseUrl}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        // modelFetch 的兼容签名仍是全局 fetch；运行时与这里实际都使用 npm undici。
        body: body as unknown as BodyInit,
        signal: controller.signal,
      });
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`[deepseekFiles] upload failed category=${
        controller.signal.aborted ? "timeout" : "network"
      }`);
      throw controller.signal.aborted ? controller.signal.reason ?? error : error;
    }

    if (!response.ok) {
      console.warn(`[deepseekFiles] upload failed category=http status=${response.status}`);
      throw new Error("DeepSeek Files 上传失败");
    }

    let raw: unknown;
    try {
      raw = await response.json();
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (controller.signal.aborted) {
        console.warn("[deepseekFiles] upload failed category=timeout");
        throw controller.signal.reason ?? error;
      }
      console.warn(`[deepseekFiles] upload failed category=invalid_json status=${response.status}`);
      throw new Error("DeepSeek Files 响应格式无效");
    }
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string" || !FILE_ID_RE.test(record.id)) {
      console.warn(`[deepseekFiles] upload failed category=invalid_id status=${response.status}`);
      throw new Error("DeepSeek Files 响应 id 无效");
    }
    if (
      typeof record.expires_at !== "number" ||
      !Number.isFinite(record.expires_at) ||
      record.expires_at <= 0 ||
      !Number.isFinite(record.expires_at * 1_000)
    ) {
      console.warn(`[deepseekFiles] upload failed category=invalid_expiry status=${response.status}`);
      throw new Error("DeepSeek Files 响应过期时间无效");
    }
    return { fileId: record.id, expiresAtMs: record.expires_at * 1_000 };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", relayAbort);
  }
}

export function resolveDeepseekFileTransport(
  config: DeepseekFileTransportConfig,
): DeepseekFileTransport | null {
  if (
    config.provider !== "deepseek" ||
    config.protocol !== "openai" ||
    !isOfficialDeepseekBaseUrl(config.baseUrl)
  ) {
    return null;
  }

  return {
    async ensureFileSentinelUrl(image, signal) {
      signal?.throwIfAborted();
      const key = fileCacheKey(config.apiKey, image.buffer);
      const cached = refreshCachedFile(key, Date.now());
      if (cached) return { sentinelUrl: sentinelUrl(cached.fileId), fileId: cached.fileId };

      let pending = uploadInFlight.get(key);
      if (!pending) {
        pending = uploadFile(config, image, signal).then((entry) => {
          cacheUploadedFile(key, entry);
          return entry;
        });
        uploadInFlight.set(key, pending);
        void pending.finally(() => {
          if (uploadInFlight.get(key) === pending) uploadInFlight.delete(key);
        }).catch(() => {});
      }
      const entry = await pending;
      signal?.throwIfAborted();
      return { sentinelUrl: sentinelUrl(entry.fileId), fileId: entry.fileId };
    },

    invalidate(image, failedFileId) {
      const key = fileCacheKey(config.apiKey, image.buffer);
      const cached = fileCache.get(key);
      if (cached?.fileId !== failedFileId) return;
      fileCache.delete(key);
      void modelFetch(`${config.baseUrl}/files/${failedFileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${config.apiKey}` },
      }).catch(() => {});
    },
  };
}
