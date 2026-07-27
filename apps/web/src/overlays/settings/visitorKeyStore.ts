// F1 visitor 层 key:随请求 header 透传,服务端不落盘。持久化后端经 clientPersist:
// 桌面端落 userData(打包后/换版都不丢),web 端仍用本浏览器 localStorage。
// 两层模型:visitor(本浏览器) > global-db(站点全局兜底) > env。
// 进阶:其他云厂商(custom_provider)整体覆盖 baseURL + key + 模型别名;
//       官方模型前缀(official_model)仅覆盖模型名(baseURL 仍官方)。
// 三者透传走同一出口 visitorKeyHeaders(),被对话/余额等请求统一带上。

import { visionKeyHeaders } from "./visionProviderStore";
import { readPersisted, writePersistedAwaited } from "./clientPersist";

const DEEPSEEK_STORAGE_KEY = "qingagent.deepseek_api_key";
const DEEPSEEK_CUSTOM_PROVIDER_KEY = "qingagent.custom_provider";
const DEEPSEEK_OFFICIAL_MODEL_KEY = "qingagent.official_model";
const KIMI_STORAGE_KEY = "qingagent.kimi_api_key";
const KIMI_CUSTOM_PROVIDER_KEY = "qingagent.kimi_custom_provider";
const KIMI_OFFICIAL_MODEL_KEY = "qingagent.kimi_official_model";
const MODEL_PROVIDER_KEY = "qingagent.model_provider";
const MODEL_TIER_KEY = "qingagent.model_tier";

const DEFAULT_MODEL_IDS = {
  deepseek: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  kimi: { flash: "kimi-for-coding", pro: "k3" },
} as const;
const DEFAULT_MODEL_TIER: ModelTier = "flash";

export type ModelTier = "flash" | "pro";
export type ModelProvider = "deepseek" | "kimi";

/** 其他云厂商/中转配置:整体覆盖。 */
export interface CustomProvider {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  modelFlash: string;
  modelPro: string;
}

/** 官方模型名前缀覆盖:仅覆盖模型名,防官方升级改名。 */
export interface OfficialModelOverride {
  flash?: string;
  pro?: string;
}

function providerStorageKeys(provider: ModelProvider) {
  return provider === "kimi"
    ? {
        apiKey: KIMI_STORAGE_KEY,
        customProvider: KIMI_CUSTOM_PROVIDER_KEY,
        officialModel: KIMI_OFFICIAL_MODEL_KEY,
      }
    : {
        apiKey: DEEPSEEK_STORAGE_KEY,
        customProvider: DEEPSEEK_CUSTOM_PROVIDER_KEY,
        officialModel: DEEPSEEK_OFFICIAL_MODEL_KEY,
      };
}

/** 未显式选择时返回 null，供请求层继续走 server DB/env provider 优先级。 */
export function getStoredModelProvider(): ModelProvider | null {
  const value = readPersisted(MODEL_PROVIDER_KEY)?.trim();
  return value === "deepseek" || value === "kimi" ? value : null;
}

/** UI 兼容旧数据：未存 provider 时仍以 DeepSeek 作为同步首屏默认值。 */
export function getSelectedModelProvider(): ModelProvider {
  return getStoredModelProvider() ?? "deepseek";
}

export function setSelectedModelProvider(provider: ModelProvider): Promise<boolean> {
  return writePersistedAwaited(MODEL_PROVIDER_KEY, provider);
}

export function getVisitorModelKey(provider: ModelProvider): string | null {
  const value = readPersisted(providerStorageKeys(provider).apiKey);
  return value && value.trim() ? value.trim() : null;
}

export function getVisitorDeepseekKey(): string | null {
  return getVisitorModelKey("deepseek");
}

export function setVisitorModelKey(provider: ModelProvider, key: string): Promise<boolean> {
  const trimmed = key.trim();
  return writePersistedAwaited(providerStorageKeys(provider).apiKey, trimmed ? trimmed : null);
}

export function setVisitorDeepseekKey(key: string): Promise<boolean> {
  return setVisitorModelKey("deepseek", key);
}

export function clearVisitorModelKey(provider: ModelProvider): Promise<boolean> {
  return setVisitorModelKey(provider, "");
}

export function clearVisitorDeepseekKey(): Promise<boolean> {
  return clearVisitorModelKey("deepseek");
}

// —— 其他云厂商(进阶):整体覆盖 baseURL + key + 模型别名 ——

export function readCustomProvider(provider: ModelProvider = "deepseek"): CustomProvider | null {
  try {
    const raw = readPersisted(providerStorageKeys(provider).customProvider);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<CustomProvider>;
    if (o && typeof o.baseUrl === "string" && o.baseUrl && typeof o.apiKey === "string" && o.apiKey) {
      return {
        protocol: provider === "kimi"
          ? "openai"
          : typeof o.protocol === "string" ? o.protocol : "openai",
        baseUrl: o.baseUrl,
        apiKey: o.apiKey,
        modelFlash: typeof o.modelFlash === "string" && o.modelFlash
          ? o.modelFlash
          : DEFAULT_MODEL_IDS[provider].flash,
        modelPro: typeof o.modelPro === "string" && o.modelPro
          ? o.modelPro
          : DEFAULT_MODEL_IDS[provider].pro,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCustomProvider(
  v: CustomProvider,
  provider: ModelProvider = "deepseek",
): Promise<boolean> {
  const value = provider === "kimi" ? { ...v, protocol: "openai" } : v;
  return writePersistedAwaited(providerStorageKeys(provider).customProvider, JSON.stringify(value));
}

export function clearCustomProvider(provider: ModelProvider = "deepseek"): Promise<boolean> {
  return writePersistedAwaited(providerStorageKeys(provider).customProvider, null);
}

// —— 官方模型前缀覆盖:仅覆盖模型名 ——

export function readOfficialModelOverride(
  provider: ModelProvider = "deepseek",
): OfficialModelOverride | null {
  try {
    const raw = readPersisted(providerStorageKeys(provider).officialModel);
    if (!raw) return null;
    const o = JSON.parse(raw) as OfficialModelOverride;
    const flash = typeof o.flash === "string" && o.flash.trim() ? o.flash.trim() : undefined;
    const pro = typeof o.pro === "string" && o.pro.trim() ? o.pro.trim() : undefined;
    return flash || pro ? { flash, pro } : null;
  } catch {
    return null;
  }
}

export function writeOfficialModelOverride(
  v: OfficialModelOverride,
  provider: ModelProvider = "deepseek",
): Promise<boolean> {
  try {
    const flash = v.flash?.trim();
    const pro = v.pro?.trim();
    if (flash || pro) {
      return writePersistedAwaited(
        providerStorageKeys(provider).officialModel,
        JSON.stringify({ ...(flash ? { flash } : {}), ...(pro ? { pro } : {}) }),
      );
    }
    return writePersistedAwaited(providerStorageKeys(provider).officialModel, null);
  } catch {
    return Promise.resolve(false);
  }
}

// —— 当前模型档位:默认 flash;pro 仅在用户显式选择后透传 ——

export function getSelectedModelTier(): ModelTier {
  const value = readPersisted(MODEL_TIER_KEY)?.trim();
  return value === "pro" ? "pro" : DEFAULT_MODEL_TIER;
}

export function setSelectedModelTier(tier: ModelTier): Promise<boolean> {
  return writePersistedAwaited(MODEL_TIER_KEY, tier === "pro" ? "pro" : "flash");
}

/** 给请求层用:按当前配置返回要附加的 header(对话 / 余额等请求统一带上)。
 *  主模型(x-deepseek-key / x-model-*)与图像识别副基模(x-vision-*,见
 *  visionProviderStore)各自独立,合并到同一出口随请求透传。 */
export function visitorKeyHeaders(): Record<string, string> {
  const storedProvider = getStoredModelProvider();
  const provider = storedProvider ?? "deepseek";
  const vision = visionKeyHeaders();
  const tier = getSelectedModelTier();
  const tierHeaders: Record<string, string> = tier === "pro" ? { "x-model-tier": "pro" } : {};
  // 其他云厂商:整体覆盖 baseURL + key + 模型别名
  const custom = readCustomProvider(provider);
  if (custom) {
    return {
      "x-model-provider": provider,
      "x-model-key": custom.apiKey,
      ...(provider === "deepseek" ? { "x-deepseek-key": custom.apiKey } : {}),
      "x-model-base-url": custom.baseUrl,
      "x-model-flash": custom.modelFlash,
      "x-model-pro": custom.modelPro,
      "x-model-protocol": custom.protocol,
      ...tierHeaders,
      ...vision,
    };
  }
  // 官方:key + 可选模型前缀覆盖(baseURL 仍官方,不传 base-url)
  const headers: Record<string, string> = {
    ...tierHeaders,
    ...vision,
  };
  const key = getVisitorModelKey(provider);
  const official = readOfficialModelOverride(provider);
  // 没有任何访客 provider/主模型配置时不发 provider，让 server 按 DB > env > 默认解析。
  // 老数据若已有 DeepSeek key/模型别名，则视为显式 DeepSeek，避免把该 key 发给 Kimi。
  if (storedProvider || key || official) headers["x-model-provider"] = provider;
  if (key) {
    headers["x-model-key"] = key;
    if (provider === "deepseek") headers["x-deepseek-key"] = key;
  }
  if (official?.flash) headers["x-model-flash"] = official.flash;
  if (official?.pro) headers["x-model-pro"] = official.pro;
  return headers;
}

/** 展示用尾 4 位掩码。 */
export function maskKey(key: string): string {
  return key.length > 4 ? `••••${key.slice(-4)}` : "••••";
}
