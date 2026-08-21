// 模型 baseURL 的无副作用入口:桌面启动预热会在迁移前加载它,不能依赖 Mastra。
import { allowGlobalModelFallback } from "./modelSourcePolicy.js";

export const OFFICIAL_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const OFFICIAL_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";

/** DeepSeek 官方端点判定:原生视觉(实验模型)与 Files API 仅在官方端点启用——中转/反代未必部署两者。 */
export function isOfficialDeepseekBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === OFFICIAL_DEEPSEEK_BASE_URL;
}

// 默认官方端点;Web/自部署/desktop dev 可由 env 覆盖。打包 desktop 固定官方端点，
// 自定义地址必须随 visitor key 从请求显式传入。
export const DEEPSEEK_BASE_URL =
  (allowGlobalModelFallback()
    ? process.env.QINGAGENT_DEEPSEEK_BASE_URL?.trim()
    : undefined) || OFFICIAL_DEEPSEEK_BASE_URL;

/** Kimi Coding 官方 OpenAI 兼容端点。 */
export const KIMI_BASE_URL =
  (allowGlobalModelFallback()
    ? process.env.QINGAGENT_KIMI_BASE_URL?.trim()
    : undefined) || OFFICIAL_KIMI_BASE_URL;

export type ModelProvider = "deepseek" | "kimi";

export const MODEL_OVERRIDES_CONTEXT_KEY = "modelOverrides";

export interface RequestContextLike {
  get(key: string): unknown;
}

/** 用户常把"最终 endpoint"也填进 baseURL,这些尾段要剥掉(只取一段,见下)。 */
const ENDPOINT_TAIL_RE = /\/(?:chat\/completions|messages|completions|responses|embeddings)\/?$/i;

/**
 * 归一化自定义 baseURL —— **全栈唯一 canonical 入口**(core 运行时 + server 测连接共用)。
 * 规则:① 合法 http(s) 且长度受限,否则 undefined;② 丢掉 query/hash(baseURL 不该带);
 * ③ 剥掉用户多填的最终 endpoint 段(/chat/completions、/messages、/responses 等);
 * ④ 没有 /vN 版本段就补 /v1(AI SDK 会再拼 /chat/completions|/messages,缺 /v1 会 404)。
 * 用 new URL() 解析,避免对带 query/hash 的串做正则替换出 `/v1?x=1/v1`、`/v1/responses/v1` 之类脏值。
 */
export function sanitizeBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value || value.length > 300) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.search = "";
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(ENDPOINT_TAIL_RE, "").replace(/\/+$/, "");
  if (!/\/v\d+$/.test(path)) path = `${path}/v1`;
  url.pathname = path;
  return url.toString().replace(/\/+$/, "");
}

/** provider 选择:请求覆盖(DB 选择也由 server 注入这里) > 允许时 env > DeepSeek 默认。 */
export function resolveModelProvider(requestContext?: RequestContextLike): ModelProvider {
  const value = requestContext?.get(MODEL_OVERRIDES_CONTEXT_KEY);
  if (value && typeof value === "object") {
    const provider = (value as { provider?: unknown }).provider;
    if (provider === "kimi" || provider === "deepseek") return provider;
  }
  return allowGlobalModelFallback() &&
      process.env.QINGAGENT_MODEL_PROVIDER?.trim().toLowerCase() === "kimi"
    ? "kimi"
    : "deepseek";
}

/** 本请求生效的 baseURL:自定义中转/厂商 > 当前 provider 官方默认。 */
export function resolveBaseUrl(requestContext?: RequestContextLike): string {
  return sanitizeBaseUrl(readBaseUrlOverride(requestContext)) ??
    (resolveModelProvider(requestContext) === "kimi" ? KIMI_BASE_URL : DEEPSEEK_BASE_URL);
}

function readBaseUrlOverride(requestContext?: RequestContextLike): string | undefined {
  const value = requestContext?.get(MODEL_OVERRIDES_CONTEXT_KEY);
  if (!value || typeof value !== "object") return undefined;
  const baseUrl = (value as { baseUrl?: unknown }).baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}
