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

  it("保留 Anthropic wire 原始 input_tokens/output_tokens 与缓存字段", () => {
    expect(normalizeLlmUsageCounts({
      input_tokens: 37,
      output_tokens: 8,
      cache_read_input_tokens: 11,
      cache_creation_input_tokens: 4,
      providerMetadata: { anthropic: {} },
    })).toEqual({
      inputTokens: 37,
      outputTokens: 8,
      promptCacheHitTokens: 11,
      promptCacheCreationTokens: 4,
    });
  });
});
