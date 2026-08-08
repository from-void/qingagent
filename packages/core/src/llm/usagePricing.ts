import type { UsageAggRow, UsageDayRow, UsagePricingSliceRow } from "@qingagent/db";
import {
  computeCostCnyAt,
  computeCostCnyForSlice,
  type ModelCostSnapshot,
  type PricingSchedule,
} from "./modelPricing.js";

interface UsageAccumulator {
  row: UsageAggRow;
  knownCacheHitTokens: number;
  knownCacheTotalTokens: number;
  costCny: number;
  estimatedCostCny: number;
  hasRecordedPrice: boolean;
  hasEstimatedPrice: boolean;
}

function createAccumulator(base: Pick<UsageAggRow,
  "bucket" | "callSite" | "modelId" | "sessionId" | "documentId" | "documentTitle" | "lastAt"
>): UsageAccumulator {
  return {
    row: {
      bucket: base.bucket,
      ...(base.sessionId === undefined ? {} : { sessionId: base.sessionId }),
      ...(base.documentId === undefined ? {} : { documentId: base.documentId }),
      ...(base.documentTitle === undefined ? {} : { documentTitle: base.documentTitle }),
      callSite: base.callSite,
      modelId: base.modelId,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      coldStartMissTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: null,
      calls: 0,
      recordedCalls: 0,
      missingCalls: 0,
      coverageRate: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      estimatedPricedCalls: 0,
      estimatedUnpricedCalls: 0,
      ...(base.lastAt === undefined ? {} : { lastAt: base.lastAt }),
    },
    knownCacheHitTokens: 0,
    knownCacheTotalTokens: 0,
    costCny: 0,
    estimatedCostCny: 0,
    hasRecordedPrice: false,
    hasEstimatedPrice: false,
  };
}

function addOptional(row: UsageAggRow, key: "billingUnknownCalls" | "estimatedCalls", value: number): void {
  if (value <= 0) return;
  row[key] = (row[key] ?? 0) + value;
}

function addEstimatedTokens(
  row: UsageAggRow,
  input: number,
  output: number,
  hit: number,
  miss: number,
): void {
  row.estimatedInputTokens = (row.estimatedInputTokens ?? 0) + input;
  row.estimatedOutputTokens = (row.estimatedOutputTokens ?? 0) + output;
  row.estimatedCacheHitTokens = (row.estimatedCacheHitTokens ?? 0) + hit;
  row.estimatedCacheMissTokens = (row.estimatedCacheMissTokens ?? 0) + miss;
}

function addPricing(
  accumulator: UsageAccumulator,
  state: "recorded" | "estimated",
  calls: number,
  cost: ModelCostSnapshot | null,
): void {
  if (calls <= 0) return;
  const row = accumulator.row;
  if (state === "recorded") {
    if (cost) {
      accumulator.costCny += cost.costCny;
      accumulator.hasRecordedPrice = true;
      row.pricedCalls += calls;
    } else {
      row.unpricedCalls += calls;
    }
  } else if (cost) {
    accumulator.estimatedCostCny += cost.costCny;
    accumulator.hasEstimatedPrice = true;
    row.estimatedPricedCalls += calls;
  } else {
    row.estimatedUnpricedCalls += calls;
  }
  if (!cost || cost.pricingTier !== "peak") return;
  row.peakPricedCalls = (row.peakPricedCalls ?? 0) + calls;
  row.peakPricingMultiplierMin = row.peakPricingMultiplierMin === undefined
    ? cost.pricingMultiplier
    : Math.min(row.peakPricingMultiplierMin, cost.pricingMultiplier);
  row.peakPricingMultiplierMax = row.peakPricingMultiplierMax === undefined
    ? cost.pricingMultiplier
    : Math.max(row.peakPricingMultiplierMax, cost.pricingMultiplier);
}

function finalize(accumulator: UsageAccumulator): UsageAggRow {
  const { row } = accumulator;
  row.cacheHitRate = accumulator.knownCacheTotalTokens > 0
    ? accumulator.knownCacheHitTokens / accumulator.knownCacheTotalTokens
    : null;
  row.coverageRate = row.calls > 0 ? row.recordedCalls / row.calls : 0;
  if (accumulator.hasRecordedPrice) row.costCny = accumulator.costCny;
  if (accumulator.hasEstimatedPrice) row.estimatedCostCny = accumulator.estimatedCostCny;
  return row;
}

/** session/total：把 SQL 的 slice 私有投影折回公开聚合行并派生金额。 */
export function priceAggregatedSlices(
  schedule: PricingSchedule,
  sliceRows: readonly UsagePricingSliceRow[],
): UsageAggRow[] {
  const grouped = new Map<string, UsageAccumulator>();
  for (const slice of sliceRows) {
    const key = JSON.stringify([slice.bucket, slice.sessionId, slice.callSite, slice.modelId]);
    const accumulator = grouped.get(key) ?? createAccumulator({
      bucket: slice.bucket,
      sessionId: slice.sessionId,
      callSite: slice.callSite,
      modelId: slice.modelId,
      lastAt: slice.lastAt,
    });
    const row = accumulator.row;
    if (slice.lastAt > (row.lastAt ?? "")) row.lastAt = slice.lastAt;
    row.inputTokens += slice.inputTokens;
    row.outputTokens += slice.outputTokens;
    row.cacheHitTokens += slice.cacheHitTokens;
    row.cacheMissTokens += slice.cacheMissTokens;
    row.cacheCreationTokens += slice.cacheCreationTokens;
    row.coldStartMissTokens += slice.coldStartMissTokens;
    row.calls += slice.calls;
    row.recordedCalls += slice.recordedCalls;
    row.missingCalls += slice.missingCalls;
    addOptional(row, "estimatedCalls", slice.estimatedCalls);
    addOptional(row, "billingUnknownCalls", slice.billingUnknownCalls);
    addEstimatedTokens(
      row,
      slice.estimatedInputTokens,
      slice.estimatedOutputTokens,
      slice.estimatedCacheHitTokens,
      slice.estimatedCacheMissTokens,
    );
    accumulator.knownCacheHitTokens += slice.knownCacheHitTokens;
    accumulator.knownCacheTotalTokens += slice.knownCacheTotalTokens;

    const recordedCost = computeCostCnyForSlice(schedule, slice.pricingSlice, slice.modelId, {
      input: slice.cacheHitTokens + slice.billableMissTokens,
      output: slice.outputTokens,
      cacheHit: slice.cacheHitTokens,
      cacheMiss: slice.billableMissTokens,
    });
    const estimatedCost = computeCostCnyForSlice(schedule, slice.pricingSlice, slice.modelId, {
      input: slice.estimatedCacheHitTokens + slice.estimatedBillableMissTokens,
      output: slice.estimatedOutputTokens,
      cacheHit: slice.estimatedCacheHitTokens,
      cacheMiss: slice.estimatedBillableMissTokens,
    });
    addPricing(accumulator, "recorded", slice.recordedCalls, recordedCost);
    addPricing(accumulator, "estimated", slice.estimatedCalls, estimatedCost);
    grouped.set(key, accumulator);
  }
  return [...grouped.values()]
    .map(finalize)
    .sort((left, right) =>
      (right.lastAt ?? "").localeCompare(left.lastAt ?? "") ||
      left.bucket.localeCompare(right.bucket) ||
      left.callSite.localeCompare(right.callSite) ||
      left.modelId.localeCompare(right.modelId));
}

/** day：原始行逐行计价并在同一 JS 循环里按 IANA 日历桶聚合。 */
export function priceUsageByDay(
  schedule: PricingSchedule,
  usageRows: readonly UsageDayRow[],
): UsageAggRow[] {
  const grouped = new Map<string, UsageAccumulator>();
  for (const usage of usageRows) {
    const key = JSON.stringify([
      usage.bucket,
      usage.sessionId,
      usage.documentId,
      usage.documentTitle,
      usage.callSite,
      usage.modelId,
    ]);
    const accumulator = grouped.get(key) ?? createAccumulator({
      bucket: usage.bucket,
      sessionId: usage.sessionId,
      documentId: usage.documentId,
      documentTitle: usage.documentTitle,
      callSite: usage.callSite,
      modelId: usage.modelId,
    });
    const row = accumulator.row;
    row.calls += 1;
    const cost = computeCostCnyAt(schedule, usage.modelId, {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheHit: usage.cacheHitTokens,
      cacheMiss: usage.cacheMissTokens,
      cacheCreation: usage.cacheCreationTokens,
    }, usage.occurredAt);
    if (usage.usageState === "recorded") {
      row.recordedCalls += 1;
      row.inputTokens += usage.inputTokens;
      row.outputTokens += usage.outputTokens;
      row.cacheHitTokens += usage.cacheHitTokens;
      row.cacheMissTokens += usage.cacheMissTokens;
      row.cacheCreationTokens += usage.cacheCreationTokens;
      if (usage.cacheAccountingState === "known") {
        accumulator.knownCacheHitTokens += usage.cacheHitTokens;
        accumulator.knownCacheTotalTokens += usage.cacheHitTokens + usage.cacheMissTokens;
        if (usage.isColdStart) row.coldStartMissTokens += usage.cacheMissTokens;
      }
      addPricing(accumulator, "recorded", 1, cost);
    } else if (usage.usageState === "estimated") {
      addOptional(row, "estimatedCalls", 1);
      addEstimatedTokens(
        row,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheHitTokens,
        usage.cacheMissTokens,
      );
      addPricing(accumulator, "estimated", 1, cost);
    } else if (usage.usageState === "missing") {
      row.missingCalls += 1;
    } else {
      addOptional(row, "billingUnknownCalls", 1);
    }
    grouped.set(key, accumulator);
  }
  return [...grouped.values()]
    .map(finalize)
    .sort((left, right) =>
      right.bucket.localeCompare(left.bucket) ||
      (left.documentTitle ?? "").localeCompare(right.documentTitle ?? "") ||
      (left.documentId ?? "").localeCompare(right.documentId ?? "") ||
      left.callSite.localeCompare(right.callSite) ||
      left.modelId.localeCompare(right.modelId));
}
