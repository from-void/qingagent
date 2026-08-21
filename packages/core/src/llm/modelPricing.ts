import { createHash } from "node:crypto";
import type { PricingSliceSpec } from "@qingagent/db";
import { DEEPSEEK_MODEL_IDS, KIMI_MODEL_IDS, NATIVE_VISION_MODEL } from "./modelTypes.js";

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
  /** 建缓存成本已包含在 cache miss 单价中，此维度永不重复计价。 */
  cacheCreation?: number;
}

export interface PeakPricingWindow {
  start: string;
  end: string;
}

export interface PricingEpoch {
  effectiveFrom: string;
  pricing: ModelPricingTable;
  peak?: {
    multiplier: number;
    windows: PeakPricingWindow[];
    models: string[];
  };
}

export interface PricingSchedule {
  revision: string;
  epochs: PricingEpoch[];
}

export interface ModelCostSnapshot {
  costCny: number;
  pricingTier: "standard" | "peak";
  pricingMultiplier: number;
}

/** 厂商峰谷公告统一按北京时间解释（固定 UTC+8，无夏令时）。 */
export const PRICING_TIME_ZONE = "Asia/Shanghai";

// 来源：各厂商官方中文价目页。单位：CNY / 1M tokens。
const CURRENT_MODEL_PRICING_CNY_PER_MILLION: ModelPricingTable = {
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

const MODEL_PRICING_CNY_PER_MILLION_FROM_2026_08_17: ModelPricingTable = {
  [DEEPSEEK_MODEL_IDS.flash]: {
    inputCacheHitPerMillion: 0.05,
    inputCacheMissPerMillion: 1.5,
    outputPerMillion: 4.5,
  },
  [DEEPSEEK_MODEL_IDS.pro]: {
    inputCacheHitPerMillion: 0.15,
    inputCacheMissPerMillion: 4.5,
    outputPerMillion: 13.5,
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

const MODEL_PRICING_CNY_PER_MILLION_FROM_2026_08_21: ModelPricingTable = {
  [DEEPSEEK_MODEL_IDS.flash]: {
    inputCacheHitPerMillion: 0.05,
    inputCacheMissPerMillion: 1.5,
    outputPerMillion: 4.5,
  },
  [DEEPSEEK_MODEL_IDS.pro]: {
    inputCacheHitPerMillion: 0.15,
    inputCacheMissPerMillion: 4.5,
    outputPerMillion: 13.5,
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
  [NATIVE_VISION_MODEL.deepseek]: {
    inputCacheHitPerMillion: 0.05,
    inputCacheMissPerMillion: 1.5,
    outputPerMillion: 4.5,
  },
};

const DEPRECATED_PRICING_ENV_NAMES = [
  "MODEL_PRICING_JSON",
  "DEEPSEEK_PRICING_JSON",
  "DEEPSEEK_PEAK_PRICING_JSON",
  "MODEL_PRICING_EPOCHS_JSON",
] as const;

for (const name of DEPRECATED_PRICING_ENV_NAMES) {
  if (process.env[name] !== undefined) {
    console.warn(`[pricing] ${name} 已退役，配置将被忽略；价目表仅随内置 schedule 发版`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
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

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 内置 schedule 的模块级断言；测试也直接用它构造非法表。 */
export function assertPricingEpochs(epochs: readonly PricingEpoch[]): void {
  if (!Array.isArray(epochs) || epochs.length === 0) {
    throw new Error("pricing schedule 必须至少包含一个 epoch");
  }
  if (epochs[0]?.effectiveFrom !== "1970-01-01T00:00:00.000Z") {
    throw new Error("pricing schedule epoch[0] 必须从 1970-01-01T00:00:00.000Z 生效");
  }
  let previous = "";
  for (const [index, epoch] of epochs.entries()) {
    if (!canonicalTimestamp(epoch.effectiveFrom)) {
      throw new Error(`pricing schedule epoch[${index}] effectiveFrom 非 canonical ISO`);
    }
    if (previous && epoch.effectiveFrom <= previous) {
      throw new Error("pricing schedule epochs 必须严格递增");
    }
    previous = epoch.effectiveFrom;
    if (epoch.pricing === null || typeof epoch.pricing !== "object") {
      throw new Error(`pricing schedule epoch[${index}] pricing 无效`);
    }
    for (const [modelId, price] of Object.entries(epoch.pricing)) {
      if (!modelId || price === null || typeof price !== "object") {
        throw new Error(`pricing schedule epoch[${index}] 模型价目无效`);
      }
      const modelPrice = price as ModelPricing;
      if (
        !finiteNonNegative(modelPrice.inputCacheHitPerMillion) ||
        !finiteNonNegative(modelPrice.inputCacheMissPerMillion) ||
        !finiteNonNegative(modelPrice.outputPerMillion)
      ) {
        throw new Error(`pricing schedule epoch[${index}] ${modelId} 单价必须有限且非负`);
      }
    }
    if (!epoch.peak) continue;
    if (!Number.isFinite(epoch.peak.multiplier) || epoch.peak.multiplier <= 0) {
      throw new Error(`pricing schedule epoch[${index}] peak multiplier 必须为有限正数`);
    }
    if (!Array.isArray(epoch.peak.models) || epoch.peak.models.length === 0 ||
      epoch.peak.models.some((model: unknown) => typeof model !== "string" || model.length === 0)) {
      throw new Error(`pricing schedule epoch[${index}] peak models 不得为空`);
    }
    if (!Array.isArray(epoch.peak.windows) || epoch.peak.windows.length === 0) {
      throw new Error(`pricing schedule epoch[${index}] peak windows 不得为空`);
    }
    for (const window of epoch.peak.windows) {
      const start = clockMinute(window.start);
      const end = clockMinute(window.end);
      if (start === null || end === null || start === end) {
        throw new Error(`pricing schedule epoch[${index}] peak window 必须是 start≠end 的 HH:mm`);
      }
    }
  }
}

export function createPricingSchedule(epochs: PricingEpoch[]): PricingSchedule {
  assertPricingEpochs(epochs);
  return {
    revision: createHash("sha256").update(canonicalJson({ epochs }), "utf8").digest("hex"),
    epochs,
  };
}

/** 内置 schedule 是价目的唯一来源；新增 epoch 必须随版本发布。 */
export const PRICING_SCHEDULE: PricingSchedule = createPricingSchedule([{
  effectiveFrom: "1970-01-01T00:00:00.000Z",
  pricing: CURRENT_MODEL_PRICING_CNY_PER_MILLION,
}, {
  effectiveFrom: "2026-08-16T16:00:00.000Z",
  pricing: MODEL_PRICING_CNY_PER_MILLION_FROM_2026_08_17,
  peak: {
    multiplier: 2,
    windows: [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ],
    models: [DEEPSEEK_MODEL_IDS.flash, DEEPSEEK_MODEL_IDS.pro],
  },
}, {
  effectiveFrom: "2026-08-20T16:00:00.000Z",
  pricing: MODEL_PRICING_CNY_PER_MILLION_FROM_2026_08_21,
  peak: {
    multiplier: 2,
    windows: [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ],
    models: [
      DEEPSEEK_MODEL_IDS.flash,
      DEEPSEEK_MODEL_IDS.pro,
      NATIVE_VISION_MODEL.deepseek,
    ],
  },
}]);

function normalizedCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeBaseCostCny(pricing: ModelPricing, usage: TokenUsageForCost): number {
  const input = normalizedCount(usage.input);
  const hit = normalizedCount(usage.cacheHit);
  const explicitMiss = normalizedCount(usage.cacheMiss);
  // provider 未分类的 input 必须按 miss 计价；逐行 max 不能挪到 SQL 聚合之后。
  const miss = explicitMiss + Math.max(0, input - hit - explicitMiss);
  const output = normalizedCount(usage.output);
  return (
    hit * pricing.inputCacheHitPerMillion +
    miss * pricing.inputCacheMissPerMillion +
    output * pricing.outputPerMillion
  ) / 1_000_000;
}

function minuteInWindow(minute: number, window: PeakPricingWindow): boolean {
  const start = clockMinute(window.start)!;
  const end = clockMinute(window.end)!;
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function shanghaiClockMinute(date: Date): number {
  const utcMinute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMinute + 8 * 60) % (24 * 60);
}

function costForEpoch(
  schedule: PricingSchedule,
  epochIndex: number,
  inPeakWindow: boolean,
  modelId: string,
  usage: TokenUsageForCost,
): ModelCostSnapshot | null {
  const epoch = schedule.epochs[epochIndex];
  const pricing = epoch?.pricing[modelId];
  if (!epoch || !pricing) return null;
  const peak = inPeakWindow && epoch.peak?.models.includes(modelId) === true;
  const multiplier = peak ? epoch.peak!.multiplier : 1;
  return {
    costCny: computeBaseCostCny(pricing, usage) * multiplier,
    pricingTier: peak ? "peak" : "standard",
    pricingMultiplier: multiplier,
  };
}

/** 纯函数：只由显式 schedule、模型、原始量与发生时刻决定金额。 */
export function computeCostCnyAt(
  schedule: PricingSchedule,
  modelId: string,
  usage: TokenUsageForCost,
  occurredAt: string | number | Date,
): ModelCostSnapshot | null {
  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return null;
  if (typeof occurredAt === "string" && date.toISOString() !== occurredAt) return null;
  let epochIndex = -1;
  for (let index = schedule.epochs.length - 1; index >= 0; index -= 1) {
    if (date.getTime() >= Date.parse(schedule.epochs[index]!.effectiveFrom)) {
      epochIndex = index;
      break;
    }
  }
  if (epochIndex < 0) return null;
  const epoch = schedule.epochs[epochIndex]!;
  const inPeakWindow = epoch.peak?.models.includes(modelId) === true &&
    epoch.peak.windows.some((window) => minuteInWindow(shanghaiClockMinute(date), window));
  return costForEpoch(schedule, epochIndex, inPeakWindow, modelId, usage);
}

/** session/total SQL slice 的纯计价入口，与逐行入口复用同一价目核。 */
export function computeCostCnyForSlice(
  schedule: PricingSchedule,
  pricingSlice: number,
  modelId: string,
  usage: TokenUsageForCost,
): ModelCostSnapshot | null {
  if (!Number.isInteger(pricingSlice) || pricingSlice < 0) return null;
  const epochIndex = Math.floor(pricingSlice / 2);
  if (epochIndex >= schedule.epochs.length) return null;
  return costForEpoch(schedule, epochIndex, pricingSlice % 2 === 1, modelId, usage);
}

export function toPricingSliceSpec(schedule: PricingSchedule): PricingSliceSpec {
  return {
    epochs: schedule.epochs.map((epoch) => ({
      effectiveFrom: epoch.effectiveFrom,
      ...(epoch.peak
        ? {
            peak: {
              windows: epoch.peak.windows.map((window) => ({ ...window })),
              models: [...epoch.peak.models],
            },
          }
        : {}),
    })),
  };
}
