import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { createHash } from "node:crypto";
import { streamText, type ModelMessage } from "ai-v5";
import { z } from "zod";
import { getVisionModel } from "../llm/modelConfig.js";
import { ImageInputError, resolveImageInput } from "./imageInput.js";
import { startToolHeartbeat, writeToolStreamChunk } from "./toolHeartbeat.js";

export const READ_IMAGE_TIMEOUT_MS = 60_000;
export const READ_IMAGE_MAX_OUTPUT_BYTES = 64 * 1024;
export const READ_IMAGE_MAX_OUTPUT_TOKENS = 4096;
const READ_IMAGE_RATE_LIMIT_RETRY_DELAY_MS = 20_000;
const READ_IMAGE_RATE_LIMIT_ERROR =
  "图像识别模型限流(免费档常见)。已自动重试仍未成功;请等待至少 30 秒后再调 readImage,期间先继续其他写作步骤,不要立即重试。";
const VISION_CACHE_MAX = 50;
const CONVERSATION_MAX_MESSAGES = 8;
const CONVERSATION_MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const visionCache = new Map<string, string>();

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRateLimitError(error: unknown): boolean {
  const maybeError = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown } | null | undefined;
  if (maybeError?.statusCode === 429) return true;
  const haystack = [maybeError?.message, maybeError?.responseBody]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return (
    haystack.includes("1305") ||
    /rate.?limit/i.test(haystack) ||
    haystack.toLowerCase().includes("too many requests") ||
    haystack.includes("当前使用人数过多") ||
    haystack.includes("使用人数过多")
  );
}

function visionRequestErrorMessage(error: unknown): string {
  const maybeError = error as { statusCode?: unknown; status?: unknown; message?: unknown } | null | undefined;
  const status = typeof maybeError?.statusCode === "number"
    ? maybeError.statusCode
    : typeof maybeError?.status === "number"
      ? maybeError.status
      : null;
  const message = typeof maybeError?.message === "string" ? maybeError.message : "";
  if (
    status === 401 ||
    status === 403 ||
    /auth|unauthori[sz]ed|forbidden|api.?key|鉴权|认证/i.test(message)
  ) {
    return "图像识别模型鉴权失败，请检查模型配置。";
  }
  if (
    (status !== null && status >= 500) ||
    /network|fetch|econn|socket|连接|网络/i.test(message)
  ) {
    return "图像识别服务连接失败，请稍后重试。";
  }
  if (/unsupported|not support|不支持|model capability|模型能力/i.test(message)) {
    return "当前图像识别模型不支持此请求，请检查模型配置。";
  }
  return "图像识别失败，请检查模型配置或稍后重试。";
}

function makeAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function waitForRetryDelay(parentSignal?: AbortSignal): Promise<void> {
  if (parentSignal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    let onAbort: () => void;
    const cleanup = () => parentSignal?.removeEventListener("abort", onAbort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, READ_IMAGE_RATE_LIMIT_RETRY_DELAY_MS);
    onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(makeAbortError());
    };
    parentSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function refreshVisionCache(key: string): string | undefined {
  const cached = visionCache.get(key);
  if (cached === undefined) return undefined;
  visionCache.delete(key);
  visionCache.set(key, cached);
  return cached;
}

function writeVisionCache(key: string, text: string): void {
  visionCache.delete(key);
  visionCache.set(key, text);
  if (visionCache.size <= VISION_CACHE_MAX) return;
  const oldest = visionCache.keys().next().value;
  if (oldest !== undefined) visionCache.delete(oldest);
}

function textContentFromMessage(message: ModelMessage): string | null {
  const role = message.role;
  if (role !== "system" && role !== "user" && role !== "assistant") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  const parts: string[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
      return null;
    }
    parts.push(part.text);
  }
  return parts.join("\n");
}

function recentTextConversation(requestContext?: RequestContext): string {
  const raw = requestContext?.get("messages");
  if (!Array.isArray(raw)) return "";
  const selected: string[] = [];
  let bytes = 0;
  for (const message of raw.slice().reverse()) {
    const text = textContentFromMessage(message as ModelMessage)?.trim();
    if (!text) continue;
    const role = (message as ModelMessage).role;
    const line = `${role}: ${text}`;
    const nextBytes = utf8ByteLength(line) + 1;
    if (bytes + nextBytes > CONVERSATION_MAX_BYTES) break;
    selected.unshift(line);
    bytes += nextBytes;
    if (selected.length >= CONVERSATION_MAX_MESSAGES) break;
  }
  return selected.join("\n");
}

/** 素材区图片(场景5):若 image 命中会话素材库的某个 materialId,改用该素材的原始上传文件
 *  (Material.fileId → /uploads/<fileId>)。非素材则原样返回交给 resolveImageInput。 */
function resolveMaterialRef(
  requestContext: RequestContext | undefined,
  image: string,
): { imageRef: string; materialId: string | null } {
  const materials = requestContext?.get("materials") as
    | { get?: (id: string) => { fileId?: string | null; mimeType?: string; filename?: string } | undefined }
    | undefined;
  const mat = materials && typeof materials.get === "function" ? materials.get(image) : undefined;
  if (!mat || typeof mat !== "object") return { imageRef: image, materialId: null };
  if (mat.mimeType && !mat.mimeType.startsWith("image/")) {
    throw new Error(`素材「${mat.filename ?? image}」不是图片文件,识图只能识别图片。`);
  }
  if (!mat.fileId) {
    throw new Error(`素材「${mat.filename ?? image}」没有可识别的原始图片文件(可能是抓取类纯文本素材)`);
  }
  return { imageRef: mat.fileId, materialId: image };
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof ImageInputError) {
    switch (error.kind) {
      case "invalid_url":
        return `图片地址无效:${error.message}`;
      case "invalid_path":
        return `图片路径不安全:${error.message}`;
      case "not_found":
        return `图片不存在:${error.message}`;
      case "too_large":
        return `图片过大:${error.message}`;
      case "unsupported_media":
        return `图片格式不支持:${error.message}`;
      case "ssrf_blocked":
        return `图片地址被安全策略拦截:${error.message}`;
      case "timeout":
        return `读取图片超时:${error.message}`;
      case "network":
        return `读取图片失败:${error.message}`;
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return `图像识别超时(${READ_IMAGE_TIMEOUT_MS}ms)`;
  }
  return error instanceof Error ? error.message : String(error);
}

export const readImageTool = createTool({
  id: "readImage",
  description:
    "当用户上传图片、给出图片链接,或要求识别/描述/提取图片内容时调用。输入单张图片地址" +
    "(/api/v1/files/<id>/<name>、http(s) 链接或 fileId)和本次识别指令,返回可供继续写作的文字结果。" +
    "不要用于生成图片;若未配置图像识别副基模,工具会返回明确的设置指引。",
  inputSchema: z.object({
    image: z
      .string()
      .describe(
        "图片来源,支持:① http(s) 图片链接;② /api/v1/files/<id>/<name> 或裸 fileId(刚上传的文件);" +
          "③ 正文图片块的 src(可为 /api/v1/files、http(s) 或 data:image/...;base64,...);④ 素材区的 materialId(图片素材)。",
      ),
    prompt: z.string().describe("本次识别任务指令"),
    includeConversation: z.boolean().nullable().optional().describe("是否让副基模看最近聊天记录,默认 false"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    text: z.string(),
    error: z.string().nullable(),
    materialId: z.string().nullable(),
  }),
  execute: async (input, context) => {
    const stopHeartbeat = startToolHeartbeat(context, { tool: "readImage" });
    const requestContext = context?.requestContext as RequestContext | undefined;
    try {
      const model = await getVisionModel(requestContext, { callSite: "readImage" });
      if (!model) {
        return {
          ok: false,
          text: "",
          error: "还未配置图像识别模型,请在 设置 → 技能 → 图像识别 里填写模型 API Key。",
          materialId: null,
        };
      }

      const prompt = input.prompt.trim() || "请识别并描述这张图片的主要内容。";
      // 先把素材区 materialId 折算成原始上传文件,再统一交给安全 resolver。
      const { imageRef, materialId } = resolveMaterialRef(requestContext, input.image.trim());
      const image = context?.abortSignal
        ? await resolveImageInput(imageRef, context.abortSignal)
        : await resolveImageInput(imageRef);
      // 工具流式进度:副基模(GLM-4.6V 等推理模型 + 免费档限流)识图常耗数十秒,期间若主流
      // 无 chunk 会触发 agent 空闲看门狗(默认 90s)abort 整轮,且 UI 看着卡住像没响应。
      // 把副基模流式吐出的文字(推理或正文,谁先来展示谁)经 context.writer 推成 tool-output
      // (readimage-progress),桥层据此刷新识别卡的文案区(前端用思考中同款滚动展示),
      // 同时每个 chunk 重置看门狗保活。对齐 writeDraft/askUser 既有 writer 进度范式。
      const writer = (
        context as { writer?: { write: (chunk: Record<string, unknown>) => Promise<unknown> | unknown } } | undefined
      )?.writer;
      const DISPLAY_CAP = 800;
      let display = ""; // 卡片展示用:累积的流式文本(供前端滚动截取)
      let lastEmitAt = 0;
      const emitProgress = (force = false) => {
        if (!writer) return;
        const now = Date.now();
        if (!force && now - lastEmitAt < 300) return; // 节流,避免刷帧过密
        lastEmitAt = now;
        try {
          const result = writeToolStreamChunk(writer, {
            type: "readimage-progress",
            progress: { excerpt: display.slice(-DISPLAY_CAP) },
          });
          if (result && typeof (result as Promise<unknown>).then === "function") {
            void (result as Promise<unknown>).catch(() => {});
          }
        } catch {
          // 进度仅装饰 + 保活,失败静默,绝不影响识图主链
        }
      };
      // 兜底保活:reasoning 阶段部分 provider 不吐任何 part(纯静默),定时器维持看门狗 + 刷新展示。
      const heartbeat = writer ? setInterval(() => emitProgress(true), 8_000) : null;
      try {
        const useCache = !input.includeConversation;
        const modelId = (model as { modelId?: string }).modelId ?? "vision";
        const cacheKey = useCache ? `${modelId} ${sha256(image.buffer)} ${sha256(prompt.trim())}` : null;
        if (cacheKey) {
          const cached = refreshVisionCache(cacheKey);
          if (cached !== undefined) {
            display += "命中此前识别结果";
            emitProgress(true);
            return { ok: true, text: cached, error: null, materialId };
          }
        }

        const conversation = input.includeConversation ? recentTextConversation(requestContext) : "";
        const textPart = conversation
          ? `最近纯文本对话(仅供理解本次识图任务):\n${conversation}\n\n本次识别指令:\n${prompt}`
          : prompt;
        const parentSignal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const runVisionOnce = async (): Promise<string> => {
          const abortController = new AbortController();
          const abortFromParent = () => abortController.abort();
          if (parentSignal?.aborted) {
            abortController.abort();
          } else {
            parentSignal?.addEventListener("abort", abortFromParent, { once: true });
          }
          const timeoutId = setTimeout(() => abortController.abort(), READ_IMAGE_TIMEOUT_MS);
          let text = "";
          let bytes = 0;
          try {
            const result = streamText({
              model,
              maxOutputTokens: READ_IMAGE_MAX_OUTPUT_TOKENS,
              maxRetries: 0,
              toolChoice: "none",
              abortSignal: abortController.signal,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: textPart },
                    { type: "image", image: image.buffer, mediaType: image.mimeType },
                  ],
                },
              ],
            });
            // 用 fullStream 而非 textStream:上游 API 报错(限流 1305 / 鉴权 / 配额)时
            // textStream 会静默结束、不抛,导致把错误当成"空文本的成功"返回。fullStream
            // 能拿到 error part 并显式抛出。text-delta 收最终答案;reasoning-delta(若 provider
            // 吐)仅进展示缓冲,不计入最终 text。
            for await (const part of result.fullStream) {
              if (part.type === "error") {
                throw part.error instanceof Error ? part.error : new Error(String(part.error));
              }
              // 推理增量:部分多模态推理模型会以 reasoning-delta 吐思考(展示用,不进答案)
              if (part.type === "reasoning-delta") {
                if (part.text) {
                  display += part.text;
                  emitProgress();
                }
              }
              if (part.type === "text-delta") {
                bytes += utf8ByteLength(part.text);
                if (bytes > READ_IMAGE_MAX_OUTPUT_BYTES) {
                  abortController.abort();
                  throw new Error(`图像识别输出超过 ${READ_IMAGE_MAX_OUTPUT_BYTES} 字节上限`);
                }
                text += part.text;
                display += part.text;
                emitProgress();
              }
            }
          } finally {
            clearTimeout(timeoutId);
            parentSignal?.removeEventListener("abort", abortFromParent);
          }
          return text.trim();
        };

        let trimmed: string;
        try {
          trimmed = await runVisionOnce();
        } catch (error) {
          if (!isRateLimitError(error)) throw error;
          display += `${display ? "\n" : ""}识图模型限流,等待 20 秒后自动重试…`;
          emitProgress(true);
          await waitForRetryDelay(parentSignal);
          try {
            trimmed = await runVisionOnce();
          } catch (retryError) {
            parentSignal?.throwIfAborted();
            return {
              ok: false,
              text: "",
              error: isRateLimitError(retryError)
                ? READ_IMAGE_RATE_LIMIT_ERROR
                : visionRequestErrorMessage(retryError),
              materialId: null,
            };
          }
        }

        if (!trimmed) {
          // 不把"无文本"当成功:可能限流、思考超额(finishReason=length)或模型不支持图像。
          return {
            ok: false,
            text: "",
            error: "图像识别没有返回结果,请检查模型配置或稍后重试。",
            materialId: null,
          };
        }
        if (cacheKey) {
          writeVisionCache(cacheKey, trimmed);
        }
        return { ok: true, text: trimmed, error: null, materialId };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    } catch (error) {
      if (context?.abortSignal?.aborted) {
        throw context.abortSignal.reason ?? error;
      }
      return { ok: false, text: "", error: errorMessageFromUnknown(error), materialId: null };
    } finally {
      stopHeartbeat();
    }
  },
});
