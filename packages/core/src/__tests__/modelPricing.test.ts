import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG,
  estimateCostCny,
  estimateCostCnyAt,
  getDeepSeekPeakPricingConfig,
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

  it("北京时间高峰窗口内对 DeepSeek 所有计费项应用配置倍率", () => {
    const usage = { input: 10_000, output: 1_000, cacheHit: 8_000 };
    const result = estimateCostCnyAt(
      "deepseek-v4-flash",
      usage,
      // UTC 01:30 = 北京时间 09:30，不能按进程本地时区判定。
      new Date("2026-08-06T01:30:00.000Z"),
      {
        ...DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG,
        enabled: true,
      },
    );

    expect(result).toEqual({
      costCny: estimateCostCny("deepseek-v4-flash", usage) * 2,
      pricingTier: "peak",
      pricingMultiplier: 2,
    });
  });

  it("北京时间平峰窗口保持基础单价", () => {
    const usage = { input: 10_000, output: 1_000, cacheHit: 8_000 };
    const result = estimateCostCnyAt(
      "deepseek-v4-flash",
      usage,
      // UTC 04:30 = 北京时间 12:30，位于两个高峰窗口之间。
      new Date("2026-08-06T04:30:00.000Z"),
      {
        ...DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG,
        enabled: true,
      },
    );

    expect(result).toEqual({
      costCny: estimateCostCny("deepseek-v4-flash", usage),
      pricingTier: "standard",
      pricingMultiplier: 1,
    });
  });

  it("峰谷开关关闭时与原计算逐厘完全相同", () => {
    const usage = { input: 10_000, output: 1_000, cacheHit: 8_000 };
    const before = estimateCostCny("deepseek-v4-flash", usage);
    const after = estimateCostCnyAt(
      "deepseek-v4-flash",
      usage,
      new Date("2026-08-06T01:30:00.000Z"),
      DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG,
    );

    expect(after?.costCny).toBe(before);
    expect(after).toMatchObject({ pricingTier: "standard", pricingMultiplier: 1 });
    const multiplierOne = estimateCostCnyAt(
      "deepseek-v4-flash",
      usage,
      new Date("2026-08-06T01:30:00.000Z"),
      { ...DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG, enabled: true, multiplier: 1 },
    );
    expect(multiplierOne?.costCny).toBe(before);
    expect(multiplierOne).toMatchObject({ pricingTier: "standard", pricingMultiplier: 1 });
  });

  it("峰谷倍率与窗口可由配置覆盖，默认仍关闭", () => {
    expect(DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG).toEqual({
      enabled: false,
      multiplier: 2,
      windows: [
        { start: "09:00", end: "12:00" },
        { start: "14:00", end: "18:00" },
      ],
    });
    expect(getDeepSeekPeakPricingConfig({
      DEEPSEEK_PEAK_PRICING_JSON: JSON.stringify({
        enabled: true,
        multiplier: 1.5,
        windows: [{ start: "10:15", end: "11:45" }],
      }),
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      multiplier: 1.5,
      windows: [{ start: "10:15", end: "11:45" }],
    });
    expect(getDeepSeekPeakPricingConfig({
      DEEPSEEK_PEAK_PRICING_JSON: JSON.stringify({ enabled: true }),
    } as NodeJS.ProcessEnv)).toEqual({
      ...DEFAULT_DEEPSEEK_PEAK_PRICING_CONFIG,
      enabled: true,
    });
  });
});
