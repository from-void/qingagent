import { DEEPSEEK_MODEL_IDS, KIMI_MODEL_IDS } from "./modelConfig.js";

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
