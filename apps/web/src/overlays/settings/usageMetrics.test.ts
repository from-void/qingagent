import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "@qingagent/contract-ts";
import { aggregateUsageRows, effectiveCacheHitRate } from "./usageMetrics";

function usageRow(
  cacheHitTokens: number,
  cacheMissTokens: number,
  coldStartMissTokens?: number,
): UsageSummaryRow {
  const cacheTotal = cacheHitTokens + cacheMissTokens;
  return {
    bucket: "S1",
    callSite: "agentChat",
    modelId: "deepseek-v4-flash",
    inputTokens: cacheTotal,
    outputTokens: 1,
    cacheHitTokens,
    cacheMissTokens,
    ...(coldStartMissTokens === undefined ? {} : { coldStartMissTokens }),
    cacheCreationTokens: 0,
    cacheHitRate: cacheTotal > 0 ? cacheHitTokens / cacheTotal : null,
    calls: 1,
    recordedCalls: 1,
    missingCalls: 0,
    coverageRate: 1,
  };
}

describe("aggregateUsageRows", () => {
  it("billing_unknown 只累计调用数，不混入 token 与金额", () => {
    const recorded = usageRow(8, 2);
    const unknown = {
      ...usageRow(0, 0),
      calls: 1,
      recordedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      billingUnknownCalls: 1,
      coverageRate: 0,
      costCny: undefined,
    };
    const summary = aggregateUsageRows("S1", [recorded, unknown]);
    expect(summary).toMatchObject({
      calls: 2,
      recordedCalls: 1,
      billingUnknownCalls: 1,
      inputTokens: 10,
      outputTokens: 1,
    });
  });

  it("按验收样例汇总总账与冷启动，并可推导 95.3% 有效命中率", () => {
    const summary = aggregateUsageRows("S1", [
      usageRow(0, 25_000, 25_000),
      usageRow(40_000, 2_000, 0),
      usageRow(42_000, 2_000, 0),
    ]);

    expect(summary).toMatchObject({
      inputTokens: 111_000,
      cacheHitTokens: 82_000,
      cacheMissTokens: 29_000,
      coldStartMissTokens: 25_000,
      cacheHitRate: 82_000 / 111_000,
    });
    expect(effectiveCacheHitRate(summary)).toBeCloseTo(82_000 / 86_000, 10);
  });

  it("可命中输入分母为 0 时返回 null，旧服务端缺字段时退化为总命中率", () => {
    expect(effectiveCacheHitRate(usageRow(0, 25_000, 25_000))).toBeNull();
    expect(effectiveCacheHitRate(usageRow(40_000, 2_000))).toBeCloseTo(40_000 / 42_000, 10);
  });

  it("unknown 记账行继续排除在缓存分子、分母和建缓存之外", () => {
    const unknown = {
      ...usageRow(9_000, 1_000, 1_000),
      cacheHitRate: null,
    };
    const summary = aggregateUsageRows("S1", [usageRow(40_000, 2_000, 2_000), unknown]);

    expect(summary).toMatchObject({
      cacheHitTokens: 40_000,
      cacheMissTokens: 2_000,
      coldStartMissTokens: 2_000,
    });
    expect(effectiveCacheHitRate(summary)).toBe(1);
  });

  it("估算用量与金额单列，精确覆盖率只认 provider 实测", () => {
    const summary = aggregateUsageRows("S1", [
      {
        ...usageRow(40_000, 2_000, 2_000),
        calls: 3,
        estimatedInputTokens: 8_000,
        estimatedOutputTokens: 900,
        estimatedCacheHitTokens: 6_000,
        estimatedCacheMissTokens: 2_000,
        estimatedCalls: 1,
        missingCalls: 1,
        coverageRate: 1 / 3,
        costCny: 5.3297,
        estimatedCostCny: 2.545,
      },
    ]);

    expect(summary).toMatchObject({
      inputTokens: 42_000,
      estimatedInputTokens: 8_000,
      estimatedOutputTokens: 900,
      estimatedCacheHitTokens: 6_000,
      estimatedCacheMissTokens: 2_000,
      recordedCalls: 1,
      estimatedCalls: 1,
      missingCalls: 1,
      coverageRate: 1 / 3,
      costCny: 5.3297,
      estimatedCostCny: 2.545,
    });
  });

  it("只有 estimated 金额的行仍进入分组估算金额", () => {
    const summary = aggregateUsageRows("S1", [
      {
        ...usageRow(0, 0),
        recordedCalls: 0,
        estimatedCalls: 1,
        estimatedInputTokens: 800,
        estimatedOutputTokens: 90,
        estimatedCostCny: 0.2545,
      },
    ]);

    expect(summary.costCny).toBeUndefined();
    expect(summary.estimatedCostCny).toBe(0.2545);
  });

  it("汇总高峰计价次数并保留倍率范围供看板解释价差", () => {
    const summary = aggregateUsageRows("S1", [
      {
        ...usageRow(100, 20),
        costCny: 0.01,
        peakPricedCalls: 1,
        peakPricingMultiplierMin: 1.5,
        peakPricingMultiplierMax: 1.5,
      },
      {
        ...usageRow(200, 40),
        costCny: 0.02,
        peakPricedCalls: 2,
        peakPricingMultiplierMin: 2,
        peakPricingMultiplierMax: 2,
      },
    ]);

    expect(summary).toMatchObject({
      peakPricedCalls: 3,
      peakPricingMultiplierMin: 1.5,
      peakPricingMultiplierMax: 2,
    });
  });
});
