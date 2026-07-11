import { describe, expect, it } from "vitest";
import { normalizeLlmUsageCounts } from "../llm/usageAccounting.js";
import { normalizeLlmUsage } from "../bridge/agentSpans.js";

// R2-B 回归:cache_hit/miss 全 0 的采集断链——providerMetadata 与 usage 同级被丢、
// @ai-sdk/openai 把缓存放 providerMetadata.openai.cachedPromptTokens 未被识别。
describe("usage cache tokens 采集(R2 修复回归)", () => {
  it("DeepSeek 原生字段在 providerMetadata.deepseek.usage 时被识别", () => {
    const merged = {
      promptTokens: 12000,
      completionTokens: 100,
      providerMetadata: {
        deepseek: { usage: { prompt_cache_hit_tokens: 11000, prompt_cache_miss_tokens: 1000 } },
      },
    };
    const counts = normalizeLlmUsageCounts(merged);
    expect(counts).toMatchObject({
      inputTokens: 12000,
      promptCacheHitTokens: 11000,
      promptCacheMissTokens: 1000,
    });
  });

  it("openai 风格 cachedPromptTokens:命中取到,miss 按 input-hit 推导", () => {
    const merged = {
      inputTokens: 16000,
      outputTokens: 200,
      providerMetadata: { openai: { cachedPromptTokens: 15000 } },
    };
    const counts = normalizeLlmUsageCounts(merged);
    expect(counts).toMatchObject({
      promptCacheHitTokens: 15000,
      promptCacheMissTokens: 1000,
    });
  });

  it("agentSpans.normalizeLlmUsage 同样识别 openai cachedPromptTokens 并推导 miss", () => {
    const usage = normalizeLlmUsage({
      inputTokens: 8000,
      outputTokens: 50,
      providerMetadata: { openai: { cachedPromptTokens: 6000 } },
    });
    expect(usage).toMatchObject({
      promptCacheHitTokens: 6000,
      promptCacheMissTokens: 2000,
    });
  });

  it("Anthropic/GLM camelCase 缓存读取与创建分别归一化，不把 creation 并进 miss", () => {
    const merged = {
      inputTokens: 9000,
      outputTokens: 80,
      providerMetadata: {
        anthropic: {
          cacheReadInputTokens: 7000,
          cacheCreationInputTokens: 1500,
        },
      },
    };
    expect(normalizeLlmUsageCounts(merged)).toMatchObject({
      promptCacheHitTokens: 7000,
      promptCacheCreationTokens: 1500,
    });
    expect(normalizeLlmUsageCounts(merged)?.promptCacheMissTokens).toBeUndefined();
    expect(normalizeLlmUsage(merged)).toMatchObject({
      promptCacheHitTokens: 7000,
      promptCacheCreationTokens: 1500,
    });
    expect(normalizeLlmUsage(merged)?.promptCacheMissTokens).toBeUndefined();
  });

  it("无缓存字段时不臆造(hit/miss 缺省)", () => {
    const counts = normalizeLlmUsageCounts({ inputTokens: 100, outputTokens: 10 });
    expect(counts?.promptCacheHitTokens).toBeUndefined();
    expect(counts?.promptCacheMissTokens).toBeUndefined();
  });

  it("hit 大于 input 的脏数据 miss 钳到 0", () => {
    const counts = normalizeLlmUsageCounts({
      inputTokens: 100,
      providerMetadata: { openai: { cachedPromptTokens: 150 } },
    });
    expect(counts?.promptCacheMissTokens).toBe(0);
  });
});
