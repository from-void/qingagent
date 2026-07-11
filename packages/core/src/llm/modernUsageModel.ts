import type { RequestContext } from "@mastra/core/request-context";
import { recordUsageEvent } from "../db/usageRepo.js";
import type { ApiKeyOrigin } from "./modelConfig.js";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";
import { nextUsageAttempt } from "./usageAttempt.js";

export interface ModernUsageModelOptions {
  requestContext?: RequestContext;
  callSite: string;
  modelId: string;
  keyOrigin: ApiKeyOrigin;
  lane?: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function hasUsage(counts: ReturnType<typeof normalizeLlmUsageCounts>): boolean {
  return !!counts && Object.values(counts).some((value) => typeof value === "number");
}

function missingReason(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "provider_request_aborted";
  }
  return "provider_request_error";
}

/**
 * Mastra 主链/OM 使用 AI SDK v2/v3 模型，不能交给 ai@4 的 wrapLanguageModel。
 * 这层只代理 doGenerate/doStream，在真实 provider 请求边界采 usage；原模型其余字段与方法原样透传。
 */
export function wrapModernModelUsage<T extends object>(model: T, options: ModernUsageModelOptions): T {
  const baseEvent = {
    sessionId: (options.requestContext?.get("sessionId") as string | undefined) ?? "unknown",
    runId: (options.requestContext?.get("runId") as string | null | undefined) ?? null,
    callSite: options.callSite,
    modelId: options.modelId,
    keyOrigin: options.keyOrigin,
    lane: options.lane ?? null,
  };

  const record = async (
    usage: unknown,
    providerMetadata: unknown,
    reason: string | null,
    attempt: number,
  ): Promise<void> => {
    try {
      const usageRecord = asRecord(usage);
      const normalized = normalizeLlmUsageCounts(
        usageRecord
          ? { ...usageRecord, ...(providerMetadata ? { providerMetadata } : {}) }
          : usage,
      );
      if (reason || !hasUsage(normalized)) {
        await recordUsageEvent({
          ...baseEvent,
          usageState: "missing",
          reason: reason ?? "provider_usage_missing",
          attempt,
        });
        return;
      }
      await recordUsageEvent({
        ...baseEvent,
        inputTokens: normalized?.inputTokens,
        outputTokens: normalized?.outputTokens,
        cacheHitTokens: normalized?.promptCacheHitTokens,
        cacheMissTokens: normalized?.promptCacheMissTokens,
        cacheCreationTokens: normalized?.promptCacheCreationTokens,
        attempt,
      });
    } catch (error) {
      console.warn("[usage] modern model 入账失败(不影响主链)", {
        callSite: options.callSite,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return new Proxy(model, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (property === "doGenerate" && typeof original === "function") {
        return async (...args: unknown[]) => {
          const attempt = nextUsageAttempt(options.requestContext, options.callSite, options.lane);
          const signal = asRecord(args[0])?.abortSignal as AbortSignal | undefined;
          try {
            const result = await Reflect.apply(original, target, args) as unknown;
            const resultRecord = asRecord(result);
            void record(resultRecord?.usage, resultRecord?.providerMetadata, null, attempt);
            return result;
          } catch (error) {
            void record(null, null, missingReason(error, signal), attempt);
            throw error;
          }
        };
      }
      if (property !== "doStream" || typeof original !== "function") return original;
      return async (...args: unknown[]) => {
        const attempt = nextUsageAttempt(options.requestContext, options.callSite, options.lane);
        const signal = asRecord(args[0])?.abortSignal as AbortSignal | undefined;
        let result: unknown;
        try {
          result = await Reflect.apply(original, target, args);
        } catch (error) {
          void record(null, null, missingReason(error, signal), attempt);
          throw error;
        }
        const resultRecord = asRecord(result);
        const source = resultRecord?.stream;
        if (!(source instanceof ReadableStream)) {
          void record(null, null, "provider_stream_invalid", attempt);
          return result;
        }
        let reader: ReadableStreamDefaultReader<unknown>;
        try {
          reader = source.getReader();
        } catch (error) {
          void record(null, null, missingReason(error, signal), attempt);
          throw error;
        }
        let recorded = false;
        let sawErrorPart = false;
        let abortHandler: (() => void) | null = null;
        const recordOnce = (usage: unknown, metadata: unknown, reason: string | null) => {
          if (recorded) return;
          recorded = true;
          if (abortHandler) signal?.removeEventListener("abort", abortHandler);
          void record(usage, metadata, reason, attempt);
        };
        abortHandler = () => recordOnce(null, null, "provider_request_aborted");
        if (signal?.aborted) abortHandler();
        else signal?.addEventListener("abort", abortHandler, { once: true });

        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                recordOnce(null, null, sawErrorPart ? "provider_stream_error_part" : "provider_stream_without_finish");
                controller.close();
                return;
              }
              const part = asRecord(value);
              if (part?.type === "error") sawErrorPart = true;
              controller.enqueue(value);
              if (part?.type === "finish") {
                recordOnce(part.usage, part.providerMetadata, null);
              }
            } catch (error) {
              recordOnce(null, null, missingReason(error, signal));
              controller.error(error);
            }
          },
          async cancel(reason) {
            recordOnce(null, null, signal?.aborted ? "provider_request_aborted" : "provider_stream_cancelled");
            await reader.cancel(reason);
          },
        });
        return { ...resultRecord, stream };
      };
    },
  });
}
