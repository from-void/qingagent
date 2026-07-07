// F1 统一模型配置层:所有 DeepSeek 调用(主 Agent + 工具内层 streamText)从这里取
// baseURL / model / apiKey / 采样参数,不再各自读 env。
//
// key 解析采用两层模型(产品决策):
//   visitor   —— 访客在浏览器里填的 key,存前端 localStorage,随请求 header 透传,
//                服务端不落盘;经 RequestContext("modelOverrides") 进入本层。
//   global-db —— 站点管理员在设置页保存的全局兜底 key(app_settings 表)。
//   env       —— DEEPSEEK_API_KEY 环境变量,最终兜底(空输入走默认,不改默认值)。
// 优先级:visitor > global-db > env。
//
// env 层不止 key:整套"默认模型 endpoint"都可由 env 兜底配置(给共享 .env / 多 worktree 用)——
//   DEEPSEEK_API_KEY        —— key
//   QINGAGENT_DEEPSEEK_BASE_URL —— baseURL(其他厂商/中转,如 GLM)
//   QINGAGENT_MODEL_PROTOCOL —— anthropic | openai(GLM Coding 走 anthropic)
//   QINGAGENT_MODEL_FLASH / QINGAGENT_MODEL_PRO —— 模型名(GLM 用 glm-* 而非 deepseek-*)
// 这样把 GLM 配置只写进共享 .env,新建 worktree 即自动生效;访客在浏览器里的自定义 endpoint
// 仍以更高优先级覆盖它(env 只是该机/该 worktree 的默认底座)。

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";
import type { RequestContext } from "@mastra/core/request-context";
import { validateFetchUrl } from "../browser/extractor.js";

// 默认官方端点;QINGAGENT_DEEPSEEK_BASE_URL 可覆盖(自托管 / 本地 mock 端点做确定性 e2e / GLM 中转)。
export const DEEPSEEK_BASE_URL =
  process.env.QINGAGENT_DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1";

// env 层默认协议:QINGAGENT_MODEL_PROTOCOL=anthropic|openai(GLM Coding 走 anthropic)。
// 调用时读取(而非模块加载常量),便于 dotenv 时序与测试;非法值忽略 -> undefined。
function envModelProtocol(): ModelProtocol | undefined {
  const v = process.env.QINGAGENT_MODEL_PROTOCOL?.trim().toLowerCase();
  return v === "anthropic" || v === "openai" ? v : undefined;
}

export type DeepseekTier = "flash" | "pro";
export type ModelProtocol = "openai" | "anthropic";

/** 模型 id 单一来源。Flash 为默认档位,Pro 由请求档位显式选择。 */
export const DEEPSEEK_MODEL_IDS: Record<DeepseekTier, string> = {
  flash: "deepseek-v4-flash",
  pro: "deepseek-v4-pro",
};

/** 上下文窗口(tokens)。DeepSeek flash/pro 当前按 1M 估算口径展示,UI 标注"约"。 */
export const DEEPSEEK_CONTEXT_WINDOWS: Record<string, number> = {
  [DEEPSEEK_MODEL_IDS.flash]: 1_000_000,
  [DEEPSEEK_MODEL_IDS.pro]: 1_000_000,
};

export type ApiKeyOrigin = "visitor" | "global-db" | "env" | "none";

/** 随 RequestContext 传入的本请求模型覆盖(由 server 在入口解析好)。 */
export interface ModelOverrides {
  /** 访客自带 key(visitor 层);为空表示本请求没有访客覆盖。 */
  visitorApiKey?: string;
  /** 设置页保存的全局兜底 key(global-db 层);server 入口从 app_settings 读出注入。 */
  globalApiKey?: string;
  /** 采样参数覆盖;字段缺省 = 不覆盖(走调用点各自默认)。 */
  params?: ModelParamOverrides;
  /** 自定义 baseURL(其他厂商/中转);缺省走 DEEPSEEK_BASE_URL。 */
  baseUrl?: string;
  /** 自定义模型别名(flash/pro);缺省走 DEEPSEEK_MODEL_IDS。 */
  modelIds?: { flash?: string; pro?: string };
  /** 当前模型档位;缺省 flash。只影响默认 flash 出口,显式请求 pro 仍走 pro。 */
  tier?: DeepseekTier;
  /** API 协议:openai(默认,DeepSeek/多数厂商)或 anthropic(智谱 GLM Coding 等)。 */
  protocol?: ModelProtocol;
  /** 图像识别副基模(多模态)独立配置;缺省=未配置。 */
  vision?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    protocol?: ModelProtocol;
  };
}

export interface ModelParamOverrides {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface ResolvedDeepseekAuth {
  apiKey: string;
  origin: ApiKeyOrigin;
}

export const MODEL_OVERRIDES_CONTEXT_KEY = "modelOverrides";

function readOverrides(requestContext?: RequestContext): ModelOverrides | undefined {
  const value = requestContext?.get(MODEL_OVERRIDES_CONTEXT_KEY);
  if (value && typeof value === "object") return value as ModelOverrides;
  return undefined;
}

/** 按 visitor > global-db > env 解析本请求实际使用的 key。 */
export function resolveDeepseekAuth(requestContext?: RequestContext): ResolvedDeepseekAuth {
  const overrides = readOverrides(requestContext);
  if (overrides?.visitorApiKey) {
    return { apiKey: overrides.visitorApiKey, origin: "visitor" };
  }
  if (overrides?.globalApiKey) {
    return { apiKey: overrides.globalApiKey, origin: "global-db" };
  }
  const envKey = process.env.DEEPSEEK_API_KEY ?? "";
  return { apiKey: envKey, origin: envKey ? "env" : "none" };
}

/** 本请求的采样参数覆盖;无覆盖时返回空对象,调用点用展开语法合并即可。 */
export function resolveModelParams(requestContext?: RequestContext): ModelParamOverrides {
  const params = readOverrides(requestContext)?.params;
  if (!params) return {};
  const out: ModelParamOverrides = {};
  // 显式逐字段拷贝:防止把 NaN/越界值透传给 provider。
  if (typeof params.temperature === "number" && Number.isFinite(params.temperature)) {
    out.temperature = Math.min(2, Math.max(0, params.temperature));
  }
  if (typeof params.topP === "number" && Number.isFinite(params.topP)) {
    out.topP = Math.min(1, Math.max(0, params.topP));
  }
  if (
    typeof params.maxOutputTokens === "number" &&
    Number.isInteger(params.maxOutputTokens) &&
    params.maxOutputTokens > 0
  ) {
    out.maxOutputTokens = params.maxOutputTokens;
  }
  return out;
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

/** 自定义模型别名:非空、长度受限、字符白名单,否则回退官方默认。 */
export function sanitizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value || value.length > 120) return undefined;
  if (!/^[A-Za-z0-9._:\/-]+$/.test(value)) return undefined;
  return value;
}

/** 本请求生效的 baseURL:自定义中转/厂商 > 官方默认。 */
export function resolveBaseUrl(requestContext?: RequestContext): string {
  return sanitizeBaseUrl(readOverrides(requestContext)?.baseUrl) ?? DEEPSEEK_BASE_URL;
}

/** 当前请求选择的模型档位;非法/缺省均回退 fallback(默认 flash)。 */
export function resolveModelTier(
  requestContext?: RequestContext,
  fallback: DeepseekTier = "flash",
): DeepseekTier {
  const tier = readOverrides(requestContext)?.tier;
  return tier === "pro" || tier === "flash" ? tier : fallback;
}

/** 本请求生效的模型 id:访客自定义别名 > env 默认(QINGAGENT_MODEL_FLASH/_PRO) > 官方默认。
 *  访客自带 endpoint(baseUrl) 时不套用 env 模型名——那是给默认/env endpoint 的。 */
export function resolveModelId(requestContext?: RequestContext, tier: DeepseekTier = "flash"): string {
  const overrides = readOverrides(requestContext);
  const effectiveTier = tier === "flash" ? resolveModelTier(requestContext, tier) : tier;
  const visitor = sanitizeModelId(overrides?.modelIds?.[effectiveTier]);
  if (visitor) return visitor;
  if (!overrides?.baseUrl) {
    const envId = sanitizeModelId(
      effectiveTier === "flash" ? process.env.QINGAGENT_MODEL_FLASH : process.env.QINGAGENT_MODEL_PRO,
    );
    if (envId) return envId;
  }
  return DEEPSEEK_MODEL_IDS[effectiveTier];
}

/** Mastra ModelRouter 用模型 id(DeepSeek provider 前缀 + 当前档位模型名)。 */
export function resolveDeepseekRouterModelId(
  requestContext?: RequestContext,
  tier: DeepseekTier = "flash",
): `${string}/${string}` {
  return `deepseek/${resolveModelId(requestContext, tier)}` as `${string}/${string}`;
}

/** 本请求 API 协议:访客覆盖 > env 默认(QINGAGENT_MODEL_PROTOCOL) > openai。
 *  访客自带 endpoint(baseUrl) 时协议由访客决定(默认 openai),env 不介入,避免把 env 的
 *  anthropic 误套到访客的 openai endpoint 上。 */
export function resolveProtocol(requestContext?: RequestContext): ModelProtocol {
  const overrides = readOverrides(requestContext);
  if (overrides?.protocol === "anthropic") return "anthropic";
  if (overrides?.baseUrl) return "openai";
  return envModelProtocol() ?? "openai";
}

export interface ResolvedVisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: ModelProtocol;
}

export async function resolveVisionConfig(
  requestContext?: RequestContext,
): Promise<ResolvedVisionConfig | null> {
  const vision = readOverrides(requestContext)?.vision;
  const apiKey = vision?.apiKey?.trim();
  if (!apiKey) return null;
  const baseUrl = sanitizeBaseUrl(vision?.baseUrl);
  const model = sanitizeModelId(vision?.model);
  if (!baseUrl || !model) return null;
  const checkedUrl = await validateFetchUrl(baseUrl);
  return {
    apiKey,
    baseUrl: checkedUrl.toString().replace(/\/+$/, ""),
    model,
    protocol: vision?.protocol === "anthropic" ? "anthropic" : "openai",
  };
}

/** AI SDK 的 anthropic provider 只在 baseURL 后接 /messages,故 baseURL 需含 /vN;
 *  用户常按 Claude Code 习惯填到 /api/anthropic(不带 /v1),这里补齐。 */
export function anthropicBaseUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

/** 工具内层 streamText 用:按本请求协议 + key + baseURL 构建 provider(openai / anthropic)。 */
export function createDeepseekProvider(requestContext?: RequestContext): (modelId: string) => LanguageModelV1 {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const baseUrl = resolveBaseUrl(requestContext);
  if (resolveProtocol(requestContext) === "anthropic") {
    const provider = createAnthropic({ baseURL: anthropicBaseUrl(baseUrl), apiKey });
    return (modelId) => provider(modelId);
  }
  const provider = createOpenAI({ baseURL: baseUrl, apiKey });
  return (modelId) => provider(modelId);
}

/** 工具内层取模型实例的捷径;默认出口受当前模型档位影响。 */
export function getDeepseekModel(requestContext?: RequestContext, tier: DeepseekTier = "flash") {
  return createDeepseekProvider(requestContext)(resolveModelId(requestContext, tier));
}

export async function getVisionModel(requestContext?: RequestContext): Promise<LanguageModelV1 | null> {
  const config = await resolveVisionConfig(requestContext);
  if (!config) return null;
  if (config.protocol === "anthropic") {
    return createAnthropic({ baseURL: anthropicBaseUrl(config.baseUrl), apiKey: config.apiKey })(config.model);
  }
  return createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey })(config.model);
}
