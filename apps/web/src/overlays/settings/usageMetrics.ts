import type { UsageSummaryRow } from "@qingagent/contract-ts";

/** 汇总表格行；缓存分子/分母只统计后端标记为已知的行。 */
export function aggregateUsageRows(
  bucket: string,
  rows: UsageSummaryRow[],
): UsageSummaryRow {
  const sum = (select: (row: UsageSummaryRow) => number) =>
    rows.reduce((total, row) => total + select(row), 0);
  const knownCacheRows = rows.filter((row) => row.cacheHitRate !== null);
  const cacheHitTokens = knownCacheRows.reduce(
    (total, row) => total + row.cacheHitTokens,
    0,
  );
  const cacheMissTokens = knownCacheRows.reduce(
    (total, row) => total + row.cacheMissTokens,
    0,
  );
  const coldStartMissTokens = knownCacheRows.reduce(
    (total, row) => total + (row.coldStartMissTokens ?? 0),
    0,
  );
  const knownCacheTotal = cacheHitTokens + cacheMissTokens;
  const calls = sum((row) => row.calls);
  const recordedCalls = sum((row) => row.recordedCalls);
  const estimatedCalls = sum((row) => row.estimatedCalls ?? 0);
  const models = new Set(rows.map((row) => row.modelId));
  const pricedRows = rows.filter((row) => row.costCny !== undefined);
  const estimatedPricedRows = rows.filter((row) => row.estimatedCostCny !== undefined);
  const peakRows = rows.filter((row) => (row.peakPricedCalls ?? 0) > 0);

  return {
    bucket,
    label: rows.find((row) => row.label)?.label,
    callSite: "",
    modelId: models.size === 1 ? rows[0]?.modelId ?? "" : "__multiple__",
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    estimatedInputTokens: sum((row) => row.estimatedInputTokens ?? 0),
    estimatedOutputTokens: sum((row) => row.estimatedOutputTokens ?? 0),
    estimatedCacheHitTokens: sum((row) => row.estimatedCacheHitTokens ?? 0),
    estimatedCacheMissTokens: sum((row) => row.estimatedCacheMissTokens ?? 0),
    cacheHitTokens,
    cacheMissTokens,
    coldStartMissTokens,
    cacheCreationTokens: sum((row) => row.cacheCreationTokens),
    cacheHitRate: knownCacheTotal > 0 ? cacheHitTokens / knownCacheTotal : null,
    calls,
    recordedCalls,
    estimatedCalls,
    missingCalls: sum((row) => row.missingCalls),
    coverageRate: calls > 0 ? recordedCalls / calls : 0,
    ...(pricedRows.length > 0
      ? {
          costCny: pricedRows.reduce((total, row) => total + (row.costCny ?? 0), 0),
        }
      : {}),
    ...(estimatedPricedRows.length > 0
      ? {
          estimatedCostCny: estimatedPricedRows.reduce(
            (total, row) => total + (row.estimatedCostCny ?? 0),
            0,
          ),
        }
      : {}),
    ...(peakRows.length > 0
      ? {
          peakPricedCalls: peakRows.reduce(
            (total, row) => total + (row.peakPricedCalls ?? 0),
            0,
          ),
          peakPricingMultiplierMin: Math.min(
            ...peakRows.map((row) => row.peakPricingMultiplierMin ?? 1),
          ),
          peakPricingMultiplierMax: Math.max(
            ...peakRows.map((row) => row.peakPricingMultiplierMax ?? 1),
          ),
        }
      : {}),
  };
}

/** 排除必然未命中的冷启动建缓存 miss；旧服务端缺字段时自然退化为总命中率。 */
export function effectiveCacheHitRate(row: UsageSummaryRow): number | null {
  if (row.cacheHitRate === null) return null;
  const eligibleInput =
    row.cacheHitTokens + row.cacheMissTokens - (row.coldStartMissTokens ?? 0);
  return eligibleInput > 0 ? row.cacheHitTokens / eligibleInput : null;
}
