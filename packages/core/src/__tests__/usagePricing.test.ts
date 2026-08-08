import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateUsageTotal,
  getDocumentsClient,
  queryUsageByDay,
  recordUsageEvent,
  type UsagePricingSliceRow,
} from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import {
  createPricingSchedule,
  toPricingSliceSpec,
  type PricingSchedule,
} from "../llm/modelPricing.js";
import { priceAggregatedSlices, priceUsageByDay } from "../llm/usagePricing.js";

let tempDb: TempDocumentsDb | null = null;

function testSchedule(): PricingSchedule {
  return createPricingSchedule([{
    effectiveFrom: "1970-01-01T00:00:00.000Z",
    pricing: {
      "model-a": {
        inputCacheHitPerMillion: 1,
        inputCacheMissPerMillion: 10,
        outputPerMillion: 20,
      },
      "zero-model": {
        inputCacheHitPerMillion: 0,
        inputCacheMissPerMillion: 0,
        outputPerMillion: 0,
      },
    },
  }, {
    effectiveFrom: "2026-08-07T15:00:00.000Z",
    pricing: {
      "model-a": {
        inputCacheHitPerMillion: 2,
        inputCacheMissPerMillion: 20,
        outputPerMillion: 40,
      },
      "zero-model": {
        inputCacheHitPerMillion: 0,
        inputCacheMissPerMillion: 0,
        outputPerMillion: 0,
      },
    },
    peak: {
      multiplier: 2,
      windows: [
        { start: "23:00", end: "02:00" },
        { start: "01:00", end: "03:00" },
      ],
      models: ["model-a"],
    },
  }]);
}

function sliceRow(
  overrides: Partial<UsagePricingSliceRow>,
): UsagePricingSliceRow {
  return {
    bucket: "total",
    callSite: "agent",
    modelId: "model-a",
    pricingSlice: 0,
    inputTokens: 1,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 1,
    billableMissTokens: 1,
    cacheCreationTokens: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCacheHitTokens: 0,
    estimatedCacheMissTokens: 0,
    estimatedBillableMissTokens: 0,
    knownCacheHitTokens: 0,
    knownCacheTotalTokens: 1,
    coldStartMissTokens: 1,
    calls: 1,
    recordedCalls: 1,
    estimatedCalls: 0,
    missingCalls: 0,
    billingUnknownCalls: 0,
    lastAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
  tempDb = prepareTempDocumentsDb("qingagent-usage-pricing-");
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
  vi.useRealTimers();
  delete process.env.MODEL_PRICING_JSON;
});

describe("usage pricing 两路径", () => {
  it("SQL slice 折算与 day 原始行逐行计价全量对拍一致", async () => {
    const events = [
      // billable miss 非线性反例：逐行 20 + 10 = 30，聚合后 max 会错误得到 20。
      { runId: "r1", inputTokens: 10, cacheHitTokens: 10, cacheMissTokens: 20, cacheAccountingState: "known" as const, occurredAt: "2026-08-07T14:59:59.999Z" },
      { runId: "r2", inputTokens: 10, cacheHitTokens: 0, cacheMissTokens: 0, cacheAccountingState: "unknown" as const, occurredAt: "2026-08-07T14:59:59.999Z" },
      { runId: "r3", inputTokens: 100, outputTokens: 10, cacheHitTokens: 20, cacheMissTokens: 0, cacheAccountingState: "known" as const, occurredAt: "2026-08-07T15:00:00.000Z" },
      { runId: "r4", inputTokens: 40, outputTokens: 5, cacheHitTokens: 10, cacheMissTokens: 30, cacheAccountingState: "known" as const, usageState: "estimated" as const, occurredAt: "2026-08-07T19:00:00.000Z" },
      { runId: "r5", usageState: "missing" as const, occurredAt: "2026-08-07T19:00:01.000Z" },
      { runId: "r6", usageState: "billing_unknown" as const, occurredAt: "2026-08-07T19:00:02.000Z" },
    ];
    for (const event of events) {
      await recordUsageEvent({
        sessionId: "session-a",
        callSite: "agent",
        modelId: "model-a",
        keyOrigin: "visitor",
        ...event,
      });
    }
    const schedule = testSchedule();
    const sliceRows = await aggregateUsageTotal(toPricingSliceSpec(schedule));
    const [slicePriced] = priceAggregatedSlices(schedule, sliceRows);
    const dayPriced = priceUsageByDay(schedule, await queryUsageByDay(30, "UTC"));
    const dayTotal = dayPriced.reduce((total, row) => ({
      inputTokens: total.inputTokens + row.inputTokens,
      outputTokens: total.outputTokens + row.outputTokens,
      cacheHitTokens: total.cacheHitTokens + row.cacheHitTokens,
      cacheMissTokens: total.cacheMissTokens + row.cacheMissTokens,
      costCny: total.costCny + (row.costCny ?? 0),
      estimatedCostCny: total.estimatedCostCny + (row.estimatedCostCny ?? 0),
      calls: total.calls + row.calls,
      recordedCalls: total.recordedCalls + row.recordedCalls,
      estimatedCalls: total.estimatedCalls + (row.estimatedCalls ?? 0),
      missingCalls: total.missingCalls + row.missingCalls,
      billingUnknownCalls: total.billingUnknownCalls + (row.billingUnknownCalls ?? 0),
      pricedCalls: total.pricedCalls + row.pricedCalls,
      unpricedCalls: total.unpricedCalls + row.unpricedCalls,
      estimatedPricedCalls: total.estimatedPricedCalls + row.estimatedPricedCalls,
      estimatedUnpricedCalls: total.estimatedUnpricedCalls + row.estimatedUnpricedCalls,
    }), {
      inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
      costCny: 0, estimatedCostCny: 0, calls: 0, recordedCalls: 0,
      estimatedCalls: 0, missingCalls: 0, billingUnknownCalls: 0,
      pricedCalls: 0, unpricedCalls: 0, estimatedPricedCalls: 0,
      estimatedUnpricedCalls: 0,
    });

    expect(sliceRows.reduce((sum, row) => sum + row.billableMissTokens, 0)).toBe(110);
    expect(slicePriced).toMatchObject(dayTotal);
    expect(slicePriced?.cacheHitRate).toBe(30 / 50);
    expect(slicePriced).toMatchObject({
      estimatedInputTokens: 40,
      estimatedOutputTokens: 5,
      estimatedCacheHitTokens: 10,
      estimatedCacheMissTokens: 30,
      coldStartMissTokens: 20,
      cacheCreationTokens: 0,
      coverageRate: 3 / 6,
    });
    expect(dayPriced.reduce((sum, row) => sum + (row.estimatedInputTokens ?? 0), 0)).toBe(40);
    expect(dayPriced.reduce((sum, row) => sum + (row.estimatedOutputTokens ?? 0), 0)).toBe(5);
    expect(dayPriced.reduce((sum, row) => sum + (row.estimatedCacheHitTokens ?? 0), 0)).toBe(10);
    expect(dayPriced.reduce((sum, row) => sum + (row.estimatedCacheMissTokens ?? 0), 0)).toBe(30);
    expect(dayPriced.reduce((sum, row) => sum + row.coldStartMissTokens, 0)).toBe(20);
    expect(dayPriced.reduce((sum, row) => sum + row.cacheCreationTokens, 0)).toBe(0);
    expect(dayPriced.reduce((sum, row) => sum + row.recordedCalls, 0) /
      dayPriced.reduce((sum, row) => sum + row.calls, 0)).toBe(3 / 6);
    const knownDayRows = dayPriced.filter((row) => row.cacheHitRate !== null);
    expect(knownDayRows.reduce((sum, row) => sum + row.cacheHitTokens, 0) /
      knownDayRows.reduce((sum, row) => sum + row.cacheHitTokens + row.cacheMissTokens, 0))
      .toBe(30 / 50);
    expect(slicePriced?.peakPricedCalls).toBe(1);
    expect(slicePriced?.peakPricingMultiplierMin).toBe(2);
    expect(slicePriced?.peakPricingMultiplierMax).toBe(2);
    const stable = priceAggregatedSlices(schedule, sliceRows);
    process.env.MODEL_PRICING_JSON = "ignored";
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    expect(priceAggregatedSlices(schedule, sliceRows)).toEqual(stable);
  });

  it("同一模型仅在新 epoch 收录时，旧行 unpriced、新行 priced 且金额只含新行", () => {
    const schedule = createPricingSchedule([{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: {},
    }, {
      effectiveFrom: "2026-08-08T00:00:00.000Z",
      pricing: { "new-model": {
        inputCacheHitPerMillion: 1,
        inputCacheMissPerMillion: 10,
        outputPerMillion: 20,
      } },
    }]);
    const base = {
      bucket: "2026-08-08",
      sessionId: "s",
      documentId: "s",
      callSite: "agent",
      modelId: "new-model",
      inputTokens: 100,
      outputTokens: 10,
      cacheHitTokens: 20,
      cacheMissTokens: 80,
      cacheCreationTokens: 0,
      cacheAccountingState: "known" as const,
      usageState: "recorded" as const,
      isColdStart: false,
    };
    expect(priceUsageByDay(schedule, [
      { ...base, occurredAt: "2026-08-07T23:59:59.999Z" },
      { ...base, occurredAt: "2026-08-08T00:00:00.000Z" },
    ])).toEqual([expect.objectContaining({
      costCny: (20 + 800 + 200) / 1_000_000,
      pricedCalls: 1,
      unpricedCalls: 1,
    })]);
  });

  it("多 slice 折回时取最大 last_at 恢复 total 排序", () => {
    const schedule = testSchedule();
    const rows = priceAggregatedSlices(schedule, [
      sliceRow({ modelId: "model-a", lastAt: "2026-01-01T00:00:00.000Z" }),
      sliceRow({ modelId: "model-a", pricingSlice: 2, lastAt: "2026-03-01T00:00:00.000Z" }),
      sliceRow({ modelId: "model-b", lastAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(rows.map((row) => [row.modelId, row.lastAt])).toEqual([
      ["model-a", "2026-03-01T00:00:00.000Z"],
      ["model-b", "2026-02-01T00:00:00.000Z"],
    ]);
  });

  it("合法零价进入 pricedCalls；同桶未收录模型单列 unpriced", () => {
    const schedule = testSchedule();
    const rows = priceUsageByDay(schedule, [{
      bucket: "2026-08-08",
      occurredAt: "2026-08-08T00:00:00.000Z",
      sessionId: "s",
      documentId: "s",
      callSite: "agent",
      modelId: "zero-model",
      inputTokens: 100,
      outputTokens: 10,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
      cacheCreationTokens: 999,
      cacheAccountingState: "known",
      usageState: "recorded",
      isColdStart: true,
    }, {
      bucket: "2026-08-08",
      occurredAt: "2026-08-08T00:00:00.000Z",
      sessionId: "s",
      documentId: "s",
      callSite: "agent",
      modelId: "unknown-model",
      inputTokens: 100,
      outputTokens: 10,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
      cacheCreationTokens: 0,
      cacheAccountingState: "unknown",
      usageState: "recorded",
      isColdStart: false,
    }]);
    expect(rows.find((row) => row.modelId === "zero-model")).toMatchObject({
      costCny: 0,
      pricedCalls: 1,
      unpricedCalls: 0,
    });
    expect(rows.find((row) => row.modelId === "unknown-model")).toMatchObject({
      pricedCalls: 0,
      unpricedCalls: 1,
    });
    expect(rows.find((row) => row.modelId === "unknown-model")?.costCny).toBeUndefined();
  });

  it.each([
    "9999-99-99T99:99:99.999Z",
    "2026-02-30T00:00:00.000Z",
    "9999-12-31T24:00:00.000Z",
  ])("不可解析或 T24 created_at 在 SQL 归 -1，day JS 同步跳过：%s", async (createdAt) => {
    await recordUsageEvent({
      sessionId: "sentinel",
      callSite: "agent",
      modelId: "model-a",
      keyOrigin: "visitor",
      inputTokens: 10,
      outputTokens: 1,
      occurredAt: "2026-08-08T00:00:00.000Z",
    });
    await getDocumentsClient().execute({
      sql: "UPDATE llm_usage_events SET created_at = ? WHERE session_id = 'sentinel'",
      args: [createdAt],
    });
    const schedule = testSchedule();
    const slices = await aggregateUsageTotal(toPricingSliceSpec(schedule));
    expect(slices).toEqual([expect.objectContaining({ pricingSlice: -1, calls: 1 })]);
    expect(priceAggregatedSlices(schedule, slices)).toEqual([
      expect.objectContaining({ unpricedCalls: 1, inputTokens: 10 }),
    ]);
    expect(await queryUsageByDay(30, "UTC")).toEqual([]);
  });
});
