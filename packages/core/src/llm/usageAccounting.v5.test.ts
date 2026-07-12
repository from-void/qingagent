import { describe, expect, it } from "vitest";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";

describe("AI SDK 4/5 usage 归一化对照", () => {
  it("相同 provider 数字在 v4 与 v5 形状下得到同一账本计数", () => {
    const v4 = normalizeLlmUsageCounts({
      promptTokens: 120,
      completionTokens: 30,
      providerMetadata: { openai: { cachedPromptTokens: 80 } },
    });
    const v5 = normalizeLlmUsageCounts({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 80,
    });

    expect(v4).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 40,
    });
    expect(v5).toEqual(v4);
  });
});
