import { DEEPSEEK_MODEL_IDS } from "./modelConfig.js";

export interface DeepseekModelPricing {
  inputCacheHitPerMillion: number;
  inputCacheMissPerMillion: number;
  outputPerMillion: number;
}

export type DeepseekPricingTable = Record<string, DeepseekModelPricing>;

export interface TokenUsageForCost {
  input?: number;
  output?: number;
  cacheHit?: number;
  cacheMiss?: number;
}

// 来源: DeepSeek 官方模型价格(中文站,人民币计价——产品决策:金额统一用人民币)
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 查询日期: 2026-06-12。单位: CNY(元) / 1M tokens。
//
// Mastra-first 检查记录(0612):@mastra/observability 内建 PricingRegistry/estimateCosts
// 自带 deepseek 定价(dist/metrics/pricing-data.jsonl),但其数据与官方页比对已过期——
// v4-flash cache-hit 标 $0.028/M(官方 $0.0028,差10倍)、v4-pro miss 标 $1.74/M(官方
// $0.435,差4倍)。故此处维护已核实的最小价表(env DEEPSEEK_PRICING_JSON 可覆盖);
// 若日后框架数据修正,可换回 PricingRegistry.fromText 机制。
export const DEFAULT_DEEPSEEK_PRICING_CNY_PER_MILLION: DeepseekPricingTable = {
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
};

function asFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizePricingEntry(value: unknown): DeepseekModelPricing | null {
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

export function getDeepseekPricingTable(env: NodeJS.ProcessEnv = process.env): DeepseekPricingTable {
  const raw = env.DEEPSEEK_PRICING_JSON;
  if (!raw) return DEFAULT_DEEPSEEK_PRICING_CNY_PER_MILLION;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const table: DeepseekPricingTable = { ...DEFAULT_DEEPSEEK_PRICING_CNY_PER_MILLION };
    for (const [modelId, value] of Object.entries(parsed)) {
      const entry = normalizePricingEntry(value);
      if (entry) table[modelId] = entry;
    }
    return table;
  } catch {
    return DEFAULT_DEEPSEEK_PRICING_CNY_PER_MILLION;
  }
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function estimateCostCny(
  modelId: string,
  usage: TokenUsageForCost,
  pricingTable: DeepseekPricingTable = getDeepseekPricingTable(),
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
