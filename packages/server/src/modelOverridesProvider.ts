import {
  SETTING_DEEPSEEK_GLOBAL_KEY,
  SETTING_KIMI_GLOBAL_KEY,
  SETTING_MODEL_PROVIDER,
  SETTING_MODEL_PARAMS,
  getAppSetting,
  sanitizeBaseUrl,
  sanitizeModelId,
  validateModelFetchUrl,
  type ModelOverrides,
  type ModelProvider,
  type DeepseekTier,
  type ModelProtocol,
  type ModelParamOverrides,
} from "@qingagent/core";

const CACHE_TTL_MS = 30_000;

interface CachedSettings {
  expiresAt: number;
  provider?: ModelProvider;
  globalApiKeys?: Partial<Record<ModelProvider, string>>;
  params?: ModelParamOverrides;
}

let cachedSettings: CachedSettings | null = null;

export function invalidateModelOverridesCache(): void {
  cachedSettings = null;
}

function sanitizeApiKey(raw: string | undefined | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.length > 200) return undefined;
  if (!/^[\x21-\x7e]+$/.test(value)) return undefined;
  return value;
}

// baseURL / 模型名 header:可见 ASCII、长度受限;严格校验(URL 合法性等)交给 core resolve 兜底。
function sanitizeHeaderValue(raw: string | undefined | null, maxLen: number): string | undefined {
  const value = raw?.trim();
  if (!value || value.length > maxLen) return undefined;
  if (!/^[\x21-\x7e]+$/.test(value)) return undefined;
  return value;
}

function sanitizeModelTier(raw: string | undefined | null): DeepseekTier | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "flash" || value === "pro" ? value : undefined;
}

function sanitizeModelProvider(raw: string | undefined | null): ModelProvider | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "deepseek" || value === "kimi" ? value : undefined;
}

async function validateVisitorBaseUrl(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  // 入口就归一化(全栈 canonical 同一口径:补 /v1、剥用户多填的 endpoint 段、去 query/hash),
  // 这样所有 modelOverrides.baseUrl 消费口(余额接口拼路径等)天然拿到 canonical 形态,
  // 不必各自再 sanitize 一遍;core resolveBaseUrl 的 sanitize 保留作最后兜底。
  const normalized = sanitizeBaseUrl(raw);
  if (!normalized) return undefined;
  try {
    await validateModelFetchUrl(normalized);
    return normalized;
  } catch {
    // 访客自定义 endpoint 不可信:非法 / 内网 / 云元数据地址直接回退默认模型地址。
    // localhost / 127.0.0.1 / ::1 是 Ollama、LM Studio 的合法主场景。
    // 回退是静默的(不给用户红色报错),但服务端必须留痕——否则表现成"莫名其妙调用失败"无从排查。
    console.warn(
      `[modelOverrides] 自定义 baseURL 被安全策略拒绝,已回退默认端点: ${normalized}(原始输入: ${raw})`,
    );
    return undefined;
  }
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseStoredParams(raw: string | null): ModelParamOverrides | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const params: ModelParamOverrides = {};
    const temperature = readFiniteNumber(record, "temperature");
    const topP = readFiniteNumber(record, "topP");
    const maxOutputTokens = readFiniteNumber(record, "maxOutputTokens");
    if (temperature != null) params.temperature = temperature;
    if (topP != null) params.topP = topP;
    if (maxOutputTokens != null && Number.isInteger(maxOutputTokens)) {
      params.maxOutputTokens = maxOutputTokens;
    }
    return Object.keys(params).length > 0 ? params : undefined;
  } catch {
    return undefined;
  }
}

async function readCachedSettings(): Promise<CachedSettings> {
  const now = Date.now();
  if (cachedSettings && cachedSettings.expiresAt > now) return cachedSettings;

  try {
    const [deepseekKeyRaw, kimiKeyRaw, providerRaw, paramsRaw] = await Promise.all([
      getAppSetting(SETTING_DEEPSEEK_GLOBAL_KEY),
      getAppSetting(SETTING_KIMI_GLOBAL_KEY),
      getAppSetting(SETTING_MODEL_PROVIDER),
      getAppSetting(SETTING_MODEL_PARAMS),
    ]);
    const deepseekKey = sanitizeApiKey(deepseekKeyRaw);
    const kimiKey = sanitizeApiKey(kimiKeyRaw);
    cachedSettings = {
      expiresAt: now + CACHE_TTL_MS,
      provider: sanitizeModelProvider(providerRaw),
      globalApiKeys: {
        ...(deepseekKey ? { deepseek: deepseekKey } : {}),
        ...(kimiKey ? { kimi: kimiKey } : {}),
      },
      params: parseStoredParams(paramsRaw),
    };
    return cachedSettings;
  } catch {
    cachedSettings = { expiresAt: now + CACHE_TTL_MS };
    return cachedSettings;
  }
}

export interface RequestModelHeaders {
  provider?: string | null;
  visitorKey?: string | null;
  baseUrl?: string | null;
  modelFlash?: string | null;
  modelPro?: string | null;
  modelTier?: string | null;
  protocol?: string | null;
  visionKey?: string | null;
  visionBaseUrl?: string | null;
  visionModel?: string | null;
  visionProtocol?: string | null;
}

export async function resolveRequestModelOverrides(
  headers: RequestModelHeaders,
): Promise<ModelOverrides> {
  const settings = await readCachedSettings();
  const provider =
    sanitizeModelProvider(headers.provider) ??
    settings.provider ??
    sanitizeModelProvider(process.env.QINGAGENT_MODEL_PROVIDER) ??
    "deepseek";
  const visitorApiKey = sanitizeApiKey(headers.visitorKey);
  // 安全（代码评审 P1）:自定义 baseURL / 协议 / 模型名只在"访客自带 key"时生效。
  // 否则无 key 的请求会借用站点 global/env key 的 Authorization 打到任意 endpoint,造成凭据泄露。
  const baseUrl = visitorApiKey
    ? await validateVisitorBaseUrl(sanitizeHeaderValue(headers.baseUrl, 300))
    : undefined;
  const modelFlash = visitorApiKey ? sanitizeHeaderValue(headers.modelFlash, 120) : undefined;
  const modelPro = visitorApiKey ? sanitizeHeaderValue(headers.modelPro, 120) : undefined;
  const tier = sanitizeModelTier(headers.modelTier);
  // protocol override 必须和合法自定义 baseUrl 成对出现;否则回到默认 OpenAI 兼容协议/地址。
  const protocol =
    provider === "deepseek" && baseUrl && headers.protocol === "anthropic"
      ? "anthropic"
      : undefined;
  const modelIds =
    modelFlash || modelPro
      ? { ...(modelFlash ? { flash: modelFlash } : {}), ...(modelPro ? { pro: modelPro } : {}) }
      : undefined;
  const visionApiKey = sanitizeApiKey(headers.visionKey);
  const visionBaseUrl = visionApiKey
    ? sanitizeBaseUrl(sanitizeHeaderValue(headers.visionBaseUrl, 300))
    : undefined;
  const visionModel = visionApiKey
    ? sanitizeModelId(sanitizeHeaderValue(headers.visionModel, 120))
    : undefined;
  const visionProtocol: ModelProtocol | undefined =
    visionApiKey && (headers.visionProtocol === "openai" || headers.visionProtocol === "anthropic")
      ? headers.visionProtocol
      : undefined;
  const vision = visionApiKey
    ? {
        apiKey: visionApiKey,
        ...(visionBaseUrl ? { baseUrl: visionBaseUrl } : {}),
        ...(visionModel ? { model: visionModel } : {}),
        ...(visionProtocol ? { protocol: visionProtocol } : {}),
      }
    : undefined;
  return {
    provider,
    ...(visitorApiKey ? { visitorApiKey } : {}),
    ...(settings.globalApiKeys?.[provider]
      ? { globalApiKey: settings.globalApiKeys[provider] }
      : {}),
    ...(settings.params ? { params: settings.params } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelIds ? { modelIds } : {}),
    ...(tier ? { tier } : {}),
    ...(protocol ? { protocol } : {}),
    ...(vision ? { vision } : {}),
  };
}
