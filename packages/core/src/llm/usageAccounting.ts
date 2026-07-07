import type { RequestContext } from "@mastra/core/request-context";
import { recordUsageEvent } from "../db/usageRepo.js";
import {
  resolveDeepseekAuth,
  resolveModelId,
} from "./modelConfig.js";

export interface NormalizedLlmUsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
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
  const providerUsage = providerMetadata ? asRecord(providerMetadata.usage) : null;
  const deepseekUsage = deepseekMetadata ? asRecord(deepseekMetadata.usage) : null;
  const openaiUsage = openaiMetadata ? asRecord(openaiMetadata.usage) : null;
  const rawUsage = asRecord(record.raw);
  if (providerMetadata) records.push(providerMetadata);
  if (deepseekMetadata) records.push(deepseekMetadata);
  if (openaiMetadata) records.push(openaiMetadata);
  if (providerUsage) records.push(providerUsage);
  if (deepseekUsage) records.push(deepseekUsage);
  if (openaiUsage) records.push(openaiUsage);
  if (rawUsage) records.push(rawUsage);
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
  const inputTokens = readFirstUsageNumber(records, ["inputTokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = readFirstUsageNumber(records, ["outputTokens", "completionTokens", "completion_tokens"]);
  const promptCacheHitTokens = readFirstUsageNumber(records, [
    "promptCacheHitTokens",
    "prompt_cache_hit_tokens",
    "cachedPromptTokens",
    "cachedInputTokens",
    "cache_read_input_tokens",
  ]);
  let promptCacheMissTokens = readFirstUsageNumber(records, [
    "promptCacheMissTokens",
    "prompt_cache_miss_tokens",
  ]);
  // 只有命中数时按 DeepSeek 语义推导 miss = input - hit(input = hit + miss)。
  if (promptCacheMissTokens == null && promptCacheHitTokens != null && inputTokens != null) {
    promptCacheMissTokens = Math.max(0, inputTokens - promptCacheHitTokens);
  }
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(promptCacheHitTokens != null ? { promptCacheHitTokens } : {}),
    ...(promptCacheMissTokens != null ? { promptCacheMissTokens } : {}),
  };
}

export async function recordDeepseekUsageFromResult(
  requestContext: RequestContext | undefined,
  callSite: string,
  usageOrPromise: unknown,
  /** R2-B:ai-sdk 把 providerMetadata 放在 usage 的同级,必须一并传入才能拿到缓存字段。 */
  providerMetadataOrPromise?: unknown,
): Promise<void> {
  try {
    const usage = await usageOrPromise;
    const providerMetadata = await providerMetadataOrPromise;
    const usageRecord = asRecord(usage);
    const merged = usageRecord
      ? { ...usageRecord, ...(providerMetadata ? { providerMetadata } : {}) }
      : usage;
    const normalized = normalizeLlmUsageCounts(merged);
    if (!normalized) return;
    await recordUsageEvent({
      sessionId: (requestContext?.get("sessionId") as string | undefined) ?? "unknown",
      runId: (requestContext?.get("runId") as string | null | undefined) ?? null,
      callSite,
      modelId: resolveModelId(requestContext, "flash"),
      keyOrigin: resolveDeepseekAuth(requestContext).origin,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cacheHitTokens: normalized.promptCacheHitTokens,
      cacheMissTokens: normalized.promptCacheMissTokens,
    });
  } catch (err) {
    // usage 入账是旁路账本,失败不影响主链——但要可观测(R8-B 审计)。
    console.warn("[usage] 旁路入账失败(不影响主链)", {
      callSite,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
