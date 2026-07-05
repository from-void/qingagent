import {
  SETTING_DEEPSEEK_GLOBAL_KEY,
  SETTING_MODEL_PARAMS,
  getAppSetting,
  sanitizeBaseUrl,
  sanitizeModelId,
  validateFetchUrl,
  type ModelOverrides,
  type ModelProtocol,
  type ModelParamOverrides,
} from "@qingagent/core";

const CACHE_TTL_MS = 30_000;

interface CachedSettings {
  expiresAt: number;
  globalApiKey?: string;
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

async function validateVisitorBaseUrl(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  try {
    await validateFetchUrl(raw);
    return raw;
  } catch {
    // 访客自定义 endpoint 不可信:非法 / 内网 / loopback / 云元数据地址直接回退默认模型地址。
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
    const [globalApiKeyRaw, paramsRaw] = await Promise.all([
      getAppSetting(SETTING_DEEPSEEK_GLOBAL_KEY),
      getAppSetting(SETTING_MODEL_PARAMS),
    ]);
    cachedSettings = {
      expiresAt: now + CACHE_TTL_MS,
      globalApiKey: sanitizeApiKey(globalApiKeyRaw),
      params: parseStoredParams(paramsRaw),
    };
    return cachedSettings;
  } catch {
    cachedSettings = { expiresAt: now + CACHE_TTL_MS };
    return cachedSettings;
  }
}

export interface RequestModelHeaders {
  visitorKey?: string | null;
  baseUrl?: string | null;
  modelFlash?: string | null;
  modelPro?: string | null;
  protocol?: string | null;
  visionKey?: string | null;
  visionBaseUrl?: string | null;
  visionModel?: string | null;
  visionProtocol?: string | null;
}

export async function resolveRequestModelOverrides(
  headers: RequestModelHeaders,
): Promise<ModelOverrides> {
  const visitorApiKey = sanitizeApiKey(headers.visitorKey);
  // 安全(codex review P1):自定义 baseURL / 协议 / 模型名只在"访客自带 key"时生效。
  // 否则无 key 的请求会借用站点 global/env key 的 Authorization 打到任意 endpoint,造成凭据泄露。
  const baseUrl = visitorApiKey
    ? await validateVisitorBaseUrl(sanitizeHeaderValue(headers.baseUrl, 300))
    : undefined;
  const modelFlash = visitorApiKey ? sanitizeHeaderValue(headers.modelFlash, 120) : undefined;
  const modelPro = visitorApiKey ? sanitizeHeaderValue(headers.modelPro, 120) : undefined;
  // protocol override 必须和合法自定义 baseUrl 成对出现;否则回到默认 OpenAI 兼容协议/地址。
  const protocol = baseUrl && headers.protocol === "anthropic" ? "anthropic" : undefined;
  const settings = await readCachedSettings();
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
    ...(visitorApiKey ? { visitorApiKey } : {}),
    ...(settings.globalApiKey ? { globalApiKey: settings.globalApiKey } : {}),
    ...(settings.params ? { params: settings.params } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(modelIds ? { modelIds } : {}),
    ...(protocol ? { protocol } : {}),
    ...(vision ? { vision } : {}),
  };
}
