import { describe, expect, it } from "vitest";
import {
  estimateCostCny,
  hasDeepseekPricing,
} from "../llm/deepseekPricing.js";

describe("deepseekPricing provider 边界", () => {
  it.each(["k3", "kimi-for-coding"])("%s 未收录价目时只记 token，不伪造费用", (modelId) => {
    expect(hasDeepseekPricing(modelId)).toBe(false);
    expect(estimateCostCny(modelId, {
      input: 10_000,
      output: 1_000,
      cacheHit: 8_000,
    })).toBe(0);
  });
});
