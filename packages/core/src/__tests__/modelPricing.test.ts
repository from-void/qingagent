import { describe, expect, it } from "vitest";
import {
  estimateCostCny,
  hasModelPricing,
} from "../llm/modelPricing.js";

describe("modelPricing provider 边界", () => {
  it.each(["gpt-4o", "my-relay-alias"])("%s 未收录价目时只记 token，不伪造费用", (modelId) => {
    expect(hasModelPricing(modelId)).toBe(false);
    expect(estimateCostCny(modelId, {
      input: 10_000,
      output: 1_000,
      cacheHit: 8_000,
    })).toBe(0);
  });

  // Kimi 官方价目(2026-07 现行,人民币 / 百万 tokens):
  // kimi-for-coding 命中 1.3 / 未命中 6.5 / 输出 27;k3 命中 2 / 未命中 20 / 输出 100。
  it("K2.7 Code(kimi-for-coding)按官方单价换算", () => {
    expect(hasModelPricing("kimi-for-coding")).toBe(true);
    // 命中 8k × 1.3 + 未命中 2k × 6.5 + 输出 1k × 27 = 0.0104 + 0.013 + 0.027
    expect(estimateCostCny("kimi-for-coding", {
      input: 10_000,
      output: 1_000,
      cacheHit: 8_000,
    })).toBeCloseTo(0.0504, 10);
  });

  it("K3 按官方单价换算,无缓存信息时整段输入按未命中价", () => {
    expect(hasModelPricing("k3")).toBe(true);
    // 未命中 10k × 20 + 输出 1k × 100 = 0.2 + 0.1
    expect(estimateCostCny("k3", { input: 10_000, output: 1_000 })).toBeCloseTo(0.3, 10);
  });

  it("混合厂商聚合:DeepSeek + Kimi 分别估算后可直接相加", () => {
    const deepseek = estimateCostCny("deepseek-v4-flash", {
      input: 10_000,
      output: 1_000,
      cacheHit: 8_000,
    });
    const kimi = estimateCostCny("k3", { input: 10_000, output: 1_000, cacheHit: 8_000 });
    // DeepSeek:8k × 0.02 + 2k × 1 + 1k × 2 = 0.00016 + 0.002 + 0.002
    expect(deepseek).toBeCloseTo(0.00416, 10);
    // Kimi:8k × 2 + 2k × 20 + 1k × 100 = 0.016 + 0.04 + 0.1
    expect(kimi).toBeCloseTo(0.156, 10);
    expect(deepseek + kimi).toBeCloseTo(0.16016, 10);
  });
});
