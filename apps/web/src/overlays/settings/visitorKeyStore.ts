// F1 visitor 层 key:随请求 header 透传,服务端不落盘。持久化后端经 clientPersist:
// 桌面端落 userData(打包后/换版都不丢),web 端仍用本浏览器 localStorage。
// 两层模型:visitor(本浏览器) > global-db(站点全局兜底) > env。
// 进阶:其他云厂商(custom_provider)整体覆盖 baseURL + key + 模型别名;
//       官方模型前缀(official_model)仅覆盖模型名(baseURL 仍官方)。
// 三者透传走同一出口 visitorKeyHeaders(),被对话/余额等请求统一带上。

import { visionKeyHeaders } from "./visionProviderStore";
import { readPersisted, writePersisted, writePersistedAwaited } from "./clientPersist";

const STORAGE_KEY = "qingagent.deepseek_api_key";
const CUSTOM_PROVIDER_KEY = "qingagent.custom_provider";
const OFFICIAL_MODEL_KEY = "qingagent.official_model";
const MODEL_TIER_KEY = "qingagent.model_tier";

const DEFAULT_FLASH = "deepseek-v4-flash";
const DEFAULT_PRO = "deepseek-v4-pro";
const DEFAULT_MODEL_TIER: ModelTier = "flash";

export type ModelTier = "flash" | "pro";

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

export function getVisitorDeepseekKey(): string | null {
  const value = readPersisted(STORAGE_KEY);
  return value && value.trim() ? value.trim() : null;
}

export function setVisitorDeepseekKey(key: string): Promise<boolean> {
  const trimmed = key.trim();
  return writePersistedAwaited(STORAGE_KEY, trimmed ? trimmed : null);
}

export function clearVisitorDeepseekKey(): Promise<boolean> {
  return setVisitorDeepseekKey("");
}

// —— 其他云厂商(进阶):整体覆盖 baseURL + key + 模型别名 ——

export function readCustomProvider(): CustomProvider | null {
  try {
    const raw = readPersisted(CUSTOM_PROVIDER_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<CustomProvider>;
    if (o && typeof o.baseUrl === "string" && o.baseUrl && typeof o.apiKey === "string" && o.apiKey) {
      return {
        protocol: typeof o.protocol === "string" ? o.protocol : "openai",
        baseUrl: o.baseUrl,
        apiKey: o.apiKey,
        modelFlash: typeof o.modelFlash === "string" && o.modelFlash ? o.modelFlash : DEFAULT_FLASH,
        modelPro: typeof o.modelPro === "string" && o.modelPro ? o.modelPro : DEFAULT_PRO,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCustomProvider(v: CustomProvider): Promise<boolean> {
  return writePersistedAwaited(CUSTOM_PROVIDER_KEY, JSON.stringify(v));
}

export function clearCustomProvider(): Promise<boolean> {
  return writePersistedAwaited(CUSTOM_PROVIDER_KEY, null);
}

// —— 官方模型前缀覆盖:仅覆盖模型名 ——

export function readOfficialModelOverride(): OfficialModelOverride | null {
  try {
    const raw = readPersisted(OFFICIAL_MODEL_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as OfficialModelOverride;
    const flash = typeof o.flash === "string" && o.flash.trim() ? o.flash.trim() : undefined;
    const pro = typeof o.pro === "string" && o.pro.trim() ? o.pro.trim() : undefined;
    return flash || pro ? { flash, pro } : null;
  } catch {
    return null;
  }
}

export function writeOfficialModelOverride(v: OfficialModelOverride): void {
  try {
    const flash = v.flash?.trim();
    const pro = v.pro?.trim();
    if (flash || pro) {
      writePersisted(
        OFFICIAL_MODEL_KEY,
        JSON.stringify({ ...(flash ? { flash } : {}), ...(pro ? { pro } : {}) }),
      );
    } else {
      writePersisted(OFFICIAL_MODEL_KEY, null);
    }
  } catch {
    // 静默
  }
}

// —— 当前模型档位:默认 flash;pro 仅在用户显式选择后透传 ——

export function getSelectedModelTier(): ModelTier {
  const value = readPersisted(MODEL_TIER_KEY)?.trim();
  return value === "pro" ? "pro" : DEFAULT_MODEL_TIER;
}

export function setSelectedModelTier(tier: ModelTier): void {
  writePersisted(MODEL_TIER_KEY, tier === "pro" ? "pro" : "flash");
}

/** 给请求层用:按当前配置返回要附加的 header(对话 / 余额等请求统一带上)。
 *  主模型(x-deepseek-key / x-model-*)与图像识别副基模(x-vision-*,见
 *  visionProviderStore)各自独立,合并到同一出口随请求透传。 */
export function visitorKeyHeaders(): Record<string, string> {
  const vision = visionKeyHeaders();
  const tier = getSelectedModelTier();
  const tierHeaders: Record<string, string> = tier === "pro" ? { "x-model-tier": "pro" } : {};
  // 其他云厂商:整体覆盖 baseURL + key + 模型别名
  const custom = readCustomProvider();
  if (custom) {
    return {
      "x-deepseek-key": custom.apiKey,
      "x-model-base-url": custom.baseUrl,
      "x-model-flash": custom.modelFlash,
      "x-model-pro": custom.modelPro,
      "x-model-protocol": custom.protocol,
      ...tierHeaders,
      ...vision,
    };
  }
  // 官方:key + 可选模型前缀覆盖(baseURL 仍官方,不传 base-url)
  const headers: Record<string, string> = { ...tierHeaders, ...vision };
  const key = getVisitorDeepseekKey();
  if (key) headers["x-deepseek-key"] = key;
  const official = readOfficialModelOverride();
  if (official?.flash) headers["x-model-flash"] = official.flash;
  if (official?.pro) headers["x-model-pro"] = official.pro;
  return headers;
}

/** 展示用尾 4 位掩码。 */
export function maskKey(key: string): string {
  return key.length > 4 ? `••••${key.slice(-4)}` : "••••";
}
