import { DEEPSEEK_MODEL_IDS, KIMI_MODEL_IDS } from "./modelTypes.js";

export interface ModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

export type ModelPricingTable = Record<string, ModelPricing>;

export interface TokenUsageForCost {
  input?: number;
  output?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

export interface PeakPricingWindow {
  start: string;
  end: string;
}

export interface DeepSeekPeakPricingConfig {
  enabled: boolean;
  multiplier: number;
  windows: PeakPricingWindow[];
}

export interface ModelCostSnapshot {
  costCny: number;
  pricingTier: "standard" | "peak";
  pricingMultiplier: number;
}

/** DeepSeek 峰谷时段由官方按北京时间定义，不随服务进程或看板客户端时区变化。 */
export const DEEPSEEK_PRICING_TIME_ZONE = "Asia/Shanghai";

/**
 * 官网当前公告值；“即将生效”的准确日期尚未公布，因此默认关闭。
 * 生效时只需配置 DEEPSEEK_PEAK_PRICING_JSON，无需修改计价代码。
 */
export const DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG: DeepSeekPeakPricingConfig = {
  enabled: false,
  multiplier: 2,
  windows: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
};

// 来源: 各厂商官方中文价目页(人民币计价——产品决策:金额统一用人民币)。单位: CNY(元) / 1M tokens。
//
// DeepSeek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing 查询日期 2026-06-12。
// Kimi:     platform.kimi.com 价目页,查询日期 2026-07-28(人工核实)。
//           k3              输入 ¥20.00(缓存命中 ¥2.00) / 输出 ¥100.00
//           kimi-for-coding 输入 ¥6.50(缓存命中 ¥1.30) / 输出 ¥27.00  (K2.7 Code)
//           官方价目页未单列 K2.7 非 code 变体;产品档位只映射 KIMI_MODEL_IDS 两个 code 变体,
//           故不额外收录,第三方中转的别名模型仍走"未收录只记 token"分支。
//
// Mastra-first 检查记录(0612):@mastra/observability 内建 PricingRegistry/estimateCosts
// 自带 deepseek 定价(dist/metrics/pricing-data.jsonl),但其数据与官方页比对已过期——
// v4-flash cache-hit 标 $0.028/M(官方 $0.0028,差10倍)、v4-pro miss 标 $1.74/M(官方
// $0.435,差4倍)。故此处维护已核实的最小价表(env MODEL_PRICING_JSON / DEEPSEEK_PRICING_JSON
// 可覆盖);若日后框架数据修正,可换回 PricingRegistry.fromText 机制。
export const DEFAULT_MODEL_PRICING_CNY_PER_MILLION: ModelPricingTable = {
  [DEEPSEEK_MODEL_IDS.flash]: {
    inputCacheHitPerMillion: 0.02,
    inputCacheMissPerMillion: 1,
    outputPerMillion: 2,
  },
  [DEEPSEEK_MODEL_IDS.pro]: {
    inputCacheHitPerMillion: 0.025,
    inputCacheMissPerMillion: 3,
    outputPerMillion: 6,
  },
  [KIMI_MODEL_IDS.flash]: {
    inputCacheHitPerMillion: 1.3,
    inputCacheMissPerMillion: 6.5,
    outputPerMillion: 27,
  },
  [KIMI_MODEL_IDS.pro]: {
    inputCacheHitPerMillion: 2,
    inputCacheMissPerMillion: 20,
    outputPerMillion: 100,
  },
};

function asFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asFinitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function clockMinute(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : null;
}

function normalizePeakWindows(value: unknown): PeakPricingWindow[] | null {
  if (!Array.isArray(value)) return null;
  const windows: PeakPricingWindow[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const startMinute = clockMinute(record.start);
    const endMinute = clockMinute(record.end);
    if (
      startMinute === null ||
      endMinute === null ||
      startMinute === endMinute ||
      typeof record.start !== "string" ||
      typeof record.end !== "string"
    ) {
      return null;
    }
    windows.push({ start: record.start, end: record.end });
  }
  return windows;
}

/** 配置格式:{ enabled, multiplier, windows:[{ start:"HH:mm", end:"HH:mm" }] }。 */
export function getDeepSeekPeakPricingConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeepSeekPeakPricingConfig {
  const raw = env.DEEPSEEK_PEAK_PRICING_JSON;
  if (!raw) return DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") {
      return DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG;
    }
    const enabled = parsed.enabled === undefined
      ? DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG.enabled
      : typeof parsed.enabled === "boolean"
        ? parsed.enabled
        : null;
    const multiplier = parsed.multiplier === undefined
      ? DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG.multiplier
      : asFinitePositive(parsed.multiplier);
    const windows = parsed.windows === undefined
      ? DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG.windows
      : normalizePeakWindows(parsed.windows);
    if (enabled === null || multiplier === null || windows === null) {
      return DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG;
    }
    return { enabled, multiplier, windows: windows.map((window) => ({ ...window })) };
  } catch {
    return DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG;
  }
}

function normalizePricingEntry(value: unknown): ModelPricing | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const inputCacheHitPerMillion = asFiniteNonNegative(
    record.inputCacheHitPerMillion ?? record.inputCacheHit ?? record.cacheHit,
  );
  const inputCacheMissPerMillion = asFiniteNonNegative(
    record.inputCacheMissPerMillion ?? record.inputCacheMiss ?? record.cacheMiss,
  );
  const outputPerMillion = asFiniteNonNegative(record.outputPerMillion ?? record.output);
  if (
    inputCacheHitPerMillion === null ||
    inputCacheMissPerMillion === null ||
    outputPerMillion === null
  ) {
    return null;
  }
  return { inputCacheHitPerMillion, inputCacheMissPerMillion, outputPerMillion };
}

export function getModelPricingTable(env: NodeJS.ProcessEnv = process.env): ModelPricingTable {
  // MODEL_PRICING_JSON 为现名;DEEPSEEK_PRICING_JSON 是历史名,继续兼容。
  const raw = env.MODEL_PRICING_JSON ?? env.DEEPSEEK_PRICING_JSON;
  if (!raw) return DEFAULT_MODEL_PRICING_CNY_PER_MILLION;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const table: ModelPricingTable = { ...DEFAULT_MODEL_PRICING_CNY_PER_MILLION };
    for (const [modelId, value] of Object.entries(parsed)) {
      const entry = normalizePricingEntry(value);
      if (entry) table[modelId] = entry;
    }
    return table;
  } catch {
    return DEFAULT_MODEL_PRICING_CNY_PER_MILLION;
  }
}

/** 未收录的模型(例如第三方中转的自定义别名)只展示 token,不展示为 ¥0 的伪价格。 */
export function hasModelPricing(
  modelId: string,
  pricingTable: ModelPricingTable = getModelPricingTable(),
): boolean {
  return Object.prototype.hasOwnProperty.call(pricingTable, modelId);
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function estimateCostCny(
  modelId: string,
  usage: TokenUsageForCost,
  pricingTable: ModelPricingTable = getModelPricingTable(),
): number {
  const pricing = pricingTable[modelId];
  if (!pricing) return 0;

  const input = count(usage.input);
  const output = count(usage.output);
  const cacheHit = count(usage.cacheHit);
  const explicitCacheMiss = count(usage.cacheMiss);
  const unclassifiedInput = Math.max(0, input - cacheHit - explicitCacheMiss);
  const cacheMiss = explicitCacheMiss + unclassifiedInput;

  return (
    (cacheHit / 1_000_000) * pricing.inputCacheHitPerMillion +
    (cacheMiss / 1_000_000) * pricing.inputCacheMissPerMillion +
    (output / 1_000_000) * pricing.outputPerMillion
  );
}

const beijingClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DEEPSEEK_PRICING_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

function clockMinuteInBeijing(occurredAt: string | number | Date): number | null {
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = beijingClockFormatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function minuteInWindow(minute: number, window: PeakPricingWindow): boolean {
  const start = clockMinute(window.start);
  const end = clockMinute(window.end);
  if (start === null || end === null || start === end) return false;
  // [start,end)；跨午夜窗口也可配置，例如 23:00～02:00。
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function isDeepSeekModel(modelId: string): boolean {
  return Object.values(DEEPSEEK_MODEL_IDS).some((candidate) => candidate === modelId);
}

/**
 * 按调用发生时刻生成不可变金额快照。未收录模型返回 null；调用方应将其标为 unpriced，
 * 避免模型日后加入价表时反向改写历史费用。
 */
export function estimateCostCnyAt(
  modelId: string,
  usage: TokenUsageForCost,
  occurredAt: string | number | Date,
  peakPricing: DeepSeekPeakPricingConfig = getDeepSeekPeakPricingConfig(),
  pricingTable: ModelPricingTable = getModelPricingTable(),
): ModelCostSnapshot | null {
  if (!hasModelPricing(modelId, pricingTable)) return null;
  const baseCostCny = estimateCostCny(modelId, usage, pricingTable);
  if (!isDeepSeekModel(modelId) || !peakPricing.enabled || peakPricing.multiplier === 1) {
    return { costCny: baseCostCny, pricingTier: "standard", pricingMultiplier: 1 };
  }
  const minute = clockMinuteInBeijing(occurredAt);
  const peak = minute !== null && peakPricing.windows.some((window) => minuteInWindow(minute, window));
  if (!peak) {
    return { costCny: baseCostCny, pricingTier: "standard", pricingMultiplier: 1 };
  }
  return {
    costCny: baseCostCny * peakPricing.multiplier,
    pricingTier: "peak",
    pricingMultiplier: peakPricing.multiplier,
  };
}
