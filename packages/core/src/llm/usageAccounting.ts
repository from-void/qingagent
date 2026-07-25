export interface NormalizedLlmUsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  promptCacheCreationTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsageNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = toNumber(record[key]);
    if (value != null) return value;
  }
  return undefined;
}

function collectUsageRecords(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [record];
  const providerMetadata = asRecord(record.providerMetadata) ?? asRecord(record.experimental_providerMetadata);
  const deepseekMetadata = providerMetadata ? asRecord(providerMetadata.deepseek) : null;
  // R2-B 排查:DeepSeek 走 @ai-sdk/openai 时缓存字段落在 providerMetadata.openai
  // (cachedPromptTokens),原生 prompt_cache_hit_tokens 则在 deepseek.usage。两路都收。
  const openaiMetadata = providerMetadata ? asRecord(providerMetadata.openai) : null;
  const kimiMetadata = providerMetadata ? asRecord(providerMetadata.kimi) : null;
  const anthropicMetadata = providerMetadata ? asRecord(providerMetadata.anthropic) : null;
  const providerUsage = providerMetadata ? asRecord(providerMetadata.usage) : null;
  const deepseekUsage = deepseekMetadata ? asRecord(deepseekMetadata.usage) : null;
  const openaiUsage = openaiMetadata ? asRecord(openaiMetadata.usage) : null;
  const kimiUsage = kimiMetadata ? asRecord(kimiMetadata.usage) : null;
  const rawUsage = asRecord(record.raw);
  if (providerMetadata) records.push(providerMetadata);
  if (deepseekMetadata) records.push(deepseekMetadata);
  if (openaiMetadata) records.push(openaiMetadata);
  if (kimiMetadata) records.push(kimiMetadata);
  if (anthropicMetadata) records.push(anthropicMetadata);
  if (providerUsage) records.push(providerUsage);
  if (deepseekUsage) records.push(deepseekUsage);
  if (openaiUsage) records.push(openaiUsage);
  if (kimiUsage) records.push(kimiUsage);
  if (rawUsage) records.push(rawUsage);
  // Kimi/OpenAI-compatible 的 cached_tokens 既可能保留在原始 prompt_tokens_details，
  // 也可能被 AI SDK 规范化到 promptTokensDetails.cachedTokens。
  for (const candidate of [...records]) {
    const snakeDetails = asRecord(candidate.prompt_tokens_details);
    const camelDetails = asRecord(candidate.promptTokensDetails);
    if (snakeDetails) records.push(snakeDetails);
    if (camelDetails) records.push(camelDetails);
  }
  return records;
}

function readFirstUsageNumber(records: Array<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const record of records) {
    const value = readUsageNumber(record, keys);
    if (value != null) return value;
  }
  return undefined;
}

export function normalizeLlmUsageCounts(usage: unknown): NormalizedLlmUsageCounts | null {
  const usageRecord = asRecord(usage);
  if (!usageRecord) return null;
  const records = collectUsageRecords(usageRecord);
  const providerMetadata = asRecord(usageRecord.providerMetadata) ?? asRecord(usageRecord.experimental_providerMetadata);
  const hasAnthropicMetadata = !!asRecord(providerMetadata?.anthropic);
  const inputTokens = readFirstUsageNumber(records, ["inputTokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = readFirstUsageNumber(records, ["outputTokens", "completionTokens", "completion_tokens"]);
  const promptCacheHitTokens = readFirstUsageNumber(records, [
    "promptCacheHitTokens",
    "prompt_cache_hit_tokens",
    "cachedPromptTokens",
    "cachedInputTokens",
    "cached_tokens",
    "cachedTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);
  const promptCacheCreationTokens = readFirstUsageNumber(records, [
    "promptCacheCreationTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  ]);
  let promptCacheMissTokens = readFirstUsageNumber(records, [
    "promptCacheMissTokens",
    "prompt_cache_miss_tokens",
  ]);
  // 只有命中数时按 DeepSeek 语义推导 miss = input - hit(input = hit + miss)。
  if (!hasAnthropicMetadata && promptCacheMissTokens == null && promptCacheHitTokens != null && inputTokens != null) {
    promptCacheMissTokens = Math.max(0, inputTokens - promptCacheHitTokens);
  }
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(promptCacheHitTokens != null ? { promptCacheHitTokens } : {}),
    ...(promptCacheMissTokens != null ? { promptCacheMissTokens } : {}),
    ...(promptCacheCreationTokens != null ? { promptCacheCreationTokens } : {}),
  };
}
