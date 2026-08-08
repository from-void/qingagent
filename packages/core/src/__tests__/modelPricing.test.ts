import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRICING_SCHEDULE,
  assertPricingEpochs,
  computeCostCnyAt,
  createPricingSchedule,
  toPricingSliceSpec,
  type ModelPricing,
  type PricingEpoch,
  type PricingSchedule,
} from "../llm/modelPricing.js";

const unitPrice: ModelPricing = {
  inputCacheHitPerMillion: 1,
  inputCacheMissPerMillion: 10,
  outputPerMillion: 20,
};

function schedule(
  pricing: ModelPricing = unitPrice,
  extra: PricingEpoch[] = [],
): PricingSchedule {
  return createPricingSchedule([{
    effectiveFrom: "1970-01-01T00:00:00.000Z",
    pricing: { "model-a": pricing, "zero-model": {
      inputCacheHitPerMillion: 0,
      inputCacheMissPerMillion: 0,
      outputPerMillion: 0,
    } },
  }, ...extra]);
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MODEL_PRICING_JSON;
});

describe("pricing schedule", () => {
  it("内置 schedule revision 是 canonical epochs 的完整 SHA-256", () => {
    expect(PRICING_SCHEDULE.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(toPricingSliceSpec(PRICING_SCHEDULE).epochs).toHaveLength(1);
    const changed = createPricingSchedule(PRICING_SCHEDULE.epochs.map((epoch, index) => ({
      ...epoch,
      pricing: Object.fromEntries(Object.entries(epoch.pricing).map(([model, price]) => [
        model,
        index === 0 ? { ...price, outputPerMillion: price.outputPerMillion + 1 } : price,
      ])),
    })));
    expect(changed.revision).not.toBe(PRICING_SCHEDULE.revision);
    const first = createPricingSchedule([{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: { b: unitPrice, a: unitPrice },
    }]);
    const reordered = createPricingSchedule([{
      pricing: { a: unitPrice, b: unitPrice },
      effectiveFrom: "1970-01-01T00:00:00.000Z",
    }]);
    expect(first.revision).toBe(reordered.revision);
  });

  it("修改既有 epoch 单价会追溯重算，事实用量对象逐字节不变", () => {
    const usage = { input: 100, output: 20, cacheHit: 20, cacheMiss: 0 };
    const before = JSON.stringify(usage);
    const original = computeCostCnyAt(schedule(), "model-a", usage, "2025-01-01T00:00:00.000Z")!;
    const doubled = computeCostCnyAt(schedule({
      inputCacheHitPerMillion: 2,
      inputCacheMissPerMillion: 20,
      outputPerMillion: 40,
    }), "model-a", usage, "2025-01-01T00:00:00.000Z")!;
    expect(doubled.costCny).toBeCloseTo(original.costCny * 2, 15);
    expect(JSON.stringify(usage)).toBe(before);
  });

  it("追加 epoch 只从 T 起生效，并按 peak.models 限定峰谷", () => {
    const pricing2x = {
      inputCacheHitPerMillion: 2,
      inputCacheMissPerMillion: 20,
      outputPerMillion: 40,
    };
    const priced = schedule(unitPrice, [{
      effectiveFrom: "2026-01-01T15:00:00.000Z",
      pricing: { "model-a": pricing2x, "model-b": pricing2x },
      peak: {
        multiplier: 2,
        windows: [{ start: "23:00", end: "02:00" }],
        models: ["model-a"],
      },
    }]);
    const usage = { input: 1_000_000 };
    expect(computeCostCnyAt(priced, "model-a", usage, "2026-01-01T14:59:59.999Z"))
      .toMatchObject({ costCny: 10, pricingTier: "standard", pricingMultiplier: 1 });
    expect(computeCostCnyAt(priced, "model-a", usage, "2026-01-01T15:00:00.000Z"))
      .toMatchObject({ costCny: 40, pricingTier: "peak", pricingMultiplier: 2 });
    expect(computeCostCnyAt(priced, "model-a", usage, "2026-01-01T15:00:00.001Z"))
      .toMatchObject({ costCny: 40, pricingTier: "peak" });
    expect(computeCostCnyAt(priced, "model-b", usage, "2026-01-01T15:00:00.000Z"))
      .toMatchObject({ costCny: 20, pricingTier: "standard" });
  });

  it.each([
    ["22:59", "2026-01-02T14:59:00.000Z", "standard"],
    ["23:00", "2026-01-02T15:00:00.000Z", "peak"],
    ["01:59", "2026-01-02T17:59:00.000Z", "peak"],
    ["02:00", "2026-01-02T18:00:00.000Z", "standard"],
  ])("跨午夜北京时间 %s 遵循 [start,end)", (_clock, occurredAt, tier) => {
    const priced = schedule(unitPrice, [{
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      pricing: { "model-a": unitPrice },
      peak: {
        multiplier: 2,
        windows: [{ start: "23:00", end: "02:00" }],
        models: ["model-a"],
      },
    }]);
    expect(computeCostCnyAt(priced, "model-a", { input: 1 }, occurredAt)?.pricingTier).toBe(tier);
  });

  it("未分类 input 补 miss，cache_creation 不计价，零价与未收录严格区分", () => {
    const priced = schedule();
    const result = computeCostCnyAt(priced, "model-a", {
      input: 100,
      output: 0,
      cacheHit: 20,
      cacheMiss: 0,
      cacheCreation: 999_999,
    }, "2026-01-01T00:00:00.000Z");
    expect(result?.costCny).toBeCloseTo((20 * 1 + 80 * 10) / 1_000_000, 15);
    expect(computeCostCnyAt(priced, "zero-model", { input: 100 }, "2026-01-01T00:00:00.000Z"))
      .toMatchObject({ costCny: 0, pricingTier: "standard" });
    expect(computeCostCnyAt(priced, "unknown", { input: 100 }, "2026-01-01T00:00:00.000Z"))
      .toBeNull();
  });

  it("纯函数不读取 env/now，非 canonical 时刻拒绝计价", () => {
    const priced = schedule();
    const input = [priced, "model-a", { input: 100 }, "2026-01-01T00:00:00.000Z"] as const;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    process.env.MODEL_PRICING_JSON = "malicious";
    const first = computeCostCnyAt(...input);
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    process.env.MODEL_PRICING_JSON = "different";
    expect(computeCostCnyAt(...input)).toEqual(first);
    expect(computeCostCnyAt(priced, "model-a", { input: 100 }, "2026-01-01T00:00:00Z"))
      .toBeNull();
    delete process.env.MODEL_PRICING_JSON;
  });

  it.each([
    ["空 epochs", []],
    ["epoch0 非 1970", [{ effectiveFrom: "2026-01-01T00:00:00.000Z", pricing: {} }]],
    ["乱序", [
      { effectiveFrom: "1970-01-01T00:00:00.000Z", pricing: {} },
      { effectiveFrom: "1969-01-01T00:00:00.000Z", pricing: {} },
    ]],
    ["负单价", [{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: { bad: { ...unitPrice, outputPerMillion: -1 } },
    }]],
    ["坏窗口", [{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: {},
      peak: { multiplier: 2, windows: [{ start: "24:00", end: "02:00" }], models: ["a"] },
    }]],
    ["空 models", [{
      effectiveFrom: "1970-01-01T00:00:00.000Z",
      pricing: {},
      peak: { multiplier: 2, windows: [{ start: "23:00", end: "02:00" }], models: [] },
    }]],
  ])("模块断言拒绝%s", (_name, epochs) => {
    expect(() => assertPricingEpochs(epochs as PricingEpoch[])).toThrow();
  });
});
