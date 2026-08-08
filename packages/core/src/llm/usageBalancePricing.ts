import { computeCostCnyAt, type PricingSchedule } from "./modelPricing.js";

export interface UsageBalanceLedgerEvent {
  occurredAt: string;
  modelId: string;
  usageState: "recorded" | "estimated" | "missing" | "billing_unknown";
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
}

export interface UsageBalanceLedgerSummary {
  ledgerCostCny: number;
  estimatedCostCny: number;
  calls: number;
  recordedCalls: number;
  estimatedCalls: number;
  missingCalls: number;
  billingUnknownCalls: number;
  pricedCalls: number;
  unpricedCalls: number;
  estimatedPricedCalls: number;
  estimatedUnpricedCalls: number;
  coverageRate: number | null;
}

/** 余额对账只把 recorded 金额纳入差额；estimated 永远单列参考。 */
export function priceUsageBalanceLedger(
  schedule: PricingSchedule,
  events: readonly UsageBalanceLedgerEvent[],
): UsageBalanceLedgerSummary {
  const summary: UsageBalanceLedgerSummary = {
    ledgerCostCny: 0,
    estimatedCostCny: 0,
    calls: 0,
    recordedCalls: 0,
    estimatedCalls: 0,
    missingCalls: 0,
    billingUnknownCalls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    estimatedPricedCalls: 0,
    estimatedUnpricedCalls: 0,
    coverageRate: null,
  };
  for (const event of events) {
    summary.calls += 1;
    if (event.usageState === "missing") {
      summary.missingCalls += 1;
      continue;
    }
    if (event.usageState === "billing_unknown") {
      summary.billingUnknownCalls += 1;
      continue;
    }
    const cost = computeCostCnyAt(schedule, event.modelId, {
      input: event.inputTokens,
      output: event.outputTokens,
      cacheHit: event.cacheHitTokens,
      cacheMiss: event.cacheMissTokens,
      cacheCreation: event.cacheCreationTokens,
    }, event.occurredAt);
    if (event.usageState === "recorded") {
      summary.recordedCalls += 1;
      if (cost) {
        summary.ledgerCostCny += cost.costCny;
        summary.pricedCalls += 1;
      } else {
        summary.unpricedCalls += 1;
      }
    } else {
      summary.estimatedCalls += 1;
      if (cost) {
        summary.estimatedCostCny += cost.costCny;
        summary.estimatedPricedCalls += 1;
      } else {
        summary.estimatedUnpricedCalls += 1;
      }
    }
  }
  summary.coverageRate = summary.calls > 0
    ? (summary.recordedCalls + summary.estimatedCalls) / summary.calls
    : null;
  return summary;
}
