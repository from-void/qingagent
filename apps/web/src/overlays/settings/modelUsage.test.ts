import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageSummaryRow } from "@qingagent/contract-ts";
import {
  buildDailyTrend,
  buildModelDistribution,
  summarizeRecentDays,
} from "./modelUsage";

function row(overrides: Partial<UsageSummaryRow> = {}): UsageSummaryRow {
  return {
    bucket: "2026-08-08",
    callSite: "agent",
    modelId: "zero-model",
    inputTokens: 10,
    outputTokens: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 10,
    cacheCreationTokens: 0,
    cacheHitRate: 0,
    calls: 1,
    recordedCalls: 1,
    missingCalls: 0,
    coverageRate: 1,
    costCny: 0,
    pricedCalls: 1,
    unpricedCalls: 0,
    estimatedPricedCalls: 0,
    estimatedUnpricedCalls: 0,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("usage 全部 view-model 的计价覆盖", () => {
  it("同模型新旧 epoch 混合时四计数贯穿 recent/distribution/trend，零价不隐藏", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    const rows = [
      row({ pricedCalls: 1, unpricedCalls: 0 }),
      row({ costCny: undefined, pricedCalls: 0, unpricedCalls: 1 }),
      row({
        recordedCalls: 0,
        estimatedCalls: 2,
        pricedCalls: 0,
        estimatedPricedCalls: 1,
        estimatedUnpricedCalls: 1,
        estimatedCostCny: 0,
      }),
    ];
    expect(summarizeRecentDays(rows, 7)).toMatchObject({
      cost: 0,
      pricedCalls: 1,
      unpricedCalls: 1,
      estimatedPricedCalls: 1,
      estimatedUnpricedCalls: 1,
    });
    expect(buildModelDistribution(rows)).toEqual([
      expect.objectContaining({
        cost: 0,
        pct: 0,
        pricedCalls: 1,
        unpricedCalls: 1,
        estimatedPricedCalls: 1,
        estimatedUnpricedCalls: 1,
      }),
    ]);
    const trend = buildDailyTrend(rows, 1);
    expect(trend?.days[0]).toMatchObject({
      cost: 0,
      pricedCalls: 1,
      unpricedCalls: 1,
      estimatedPricedCalls: 1,
      estimatedUnpricedCalls: 1,
    });
  });
});
