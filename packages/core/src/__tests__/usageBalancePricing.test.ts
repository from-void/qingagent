import { describe, expect, it } from "vitest";
import { createPricingSchedule } from "../llm/modelPricing.js";
import { priceUsageBalanceLedger } from "../llm/usageBalancePricing.js";

describe("余额对账逐事件计价", () => {
  it("跨 epoch 且四状态分账，estimated 只作参考", () => {
    const schedule = createPricingSchedule([{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: { model: {
        inputCacheHitPerMillion: 1,
        inputCacheMissPerMillion: 1,
        outputPerMillion: 1,
      } },
    }, {
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      pricing: { model: {
        inputCacheHitPerMillion: 2,
        inputCacheMissPerMillion: 2,
        outputPerMillion: 2,
      } },
    }]);
    const event = (usageState: "recorded" | "estimated" | "missing" | "billing_unknown", occurredAt: string, modelId = "model") => ({
      occurredAt,
      modelId,
      usageState,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 1_000_000,
      cacheCreationTokens: 99_000_000,
    });
    const result = priceUsageBalanceLedger(schedule, [
      event("recorded", "2025-12-31T23:59:59.999Z"),
      event("recorded", "2026-01-01T00:00:00.000Z"),
      event("estimated", "2026-01-01T00:00:00.001Z"),
      event("missing", "2026-01-01T00:00:00.002Z"),
      event("billing_unknown", "2026-01-01T00:00:00.003Z"),
      event("recorded", "2026-01-01T00:00:00.004Z", "unknown"),
    ]);
    expect(result).toEqual({
      ledgerCostCny: 3,
      estimatedCostCny: 2,
      calls: 6,
      recordedCalls: 3,
      estimatedCalls: 1,
      missingCalls: 1,
      billingUnknownCalls: 1,
      pricedCalls: 2,
      unpricedCalls: 1,
      estimatedPricedCalls: 1,
      estimatedUnpricedCalls: 0,
      coverageRate: 4 / 6,
    });
  });
});
