import type { RequestContext } from "@mastra/core/request-context";
import type { LanguageModelV1, LanguageModelV1Middleware } from "ai";
import { recordUsageEvent } from "../db/usageRepo.js";
import type { ApiKeyOrigin } from "./modelConfig.js";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";
import { nextUsageAttempt } from "./usageAttempt.js";

type ModelStreamResult = Awaited<ReturnType<LanguageModelV1["doStream"]>>;
type ModelStreamPart = ModelStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export interface UsageMiddlewareOptions {
  requestContext?: RequestContext;
  callSite: string;
  modelId: string;
  keyOrigin: ApiKeyOrigin;
  lane?: number | null;
  attempt?: number;
}

function hasUsageCounts(counts: ReturnType<typeof normalizeLlmUsageCounts>): boolean {
  return !!counts && Object.values(counts).some((value) => typeof value === "number");
}

function missingReason(error: unknown, abortSignal?: AbortSignal): string {
  if (abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "provider_request_aborted";
  }
  return "provider_request_error";
}

/**
 * 在 LanguageModelV1 的传输边界逐个 provider 请求入账。
 * middleware 位于 AI SDK 重试层内，因此一次重试会自然形成另一条真实请求事件。
 */
export function createUsageMiddleware(options: UsageMiddlewareOptions): LanguageModelV1Middleware {
  const baseEvent = {
    sessionId: (options.requestContext?.get("sessionId") as string | undefined) ?? "unknown",
    runId: (options.requestContext?.get("runId") as string | null | undefined) ?? null,
    callSite: options.callSite,
    modelId: options.modelId,
    keyOrigin: options.keyOrigin,
    lane: options.lane ?? null,
  };

  const recordSafely = async (
    usage: unknown,
    providerMetadata: unknown,
    missing: string | null,
    attempt: number,
  ): Promise<void> => {
    try {
      const usageRecord = usage !== null && typeof usage === "object"
        ? usage as Record<string, unknown>
        : null;
      const normalized = normalizeLlmUsageCounts(
        usageRecord
          ? { ...usageRecord, ...(providerMetadata ? { providerMetadata } : {}) }
          : usage,
      );
      if (missing || !hasUsageCounts(normalized)) {
        await recordUsageEvent({
          ...baseEvent,
          usageState: "missing",
          reason: missing ?? "provider_usage_missing",
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
      // 账本始终是旁路；数据库/迁移故障不能改变模型请求结果。
      console.warn("[usage] middleware 入账失败(不影响主链)", {
        callSite: options.callSite,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    middlewareVersion: "v1",
    wrapGenerate: async ({ doGenerate, params }) => {
      const attempt = options.attempt ?? nextUsageAttempt(options.requestContext, options.callSite, options.lane);
      try {
        const result = await doGenerate();
        void recordSafely(result.usage, result.providerMetadata, null, attempt);
        return result;
      } catch (error) {
        void recordSafely(null, null, missingReason(error, params.abortSignal), attempt);
        throw error;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const attempt = options.attempt ?? nextUsageAttempt(options.requestContext, options.callSite, options.lane);
      let result: ModelStreamResult;
      try {
        result = await doStream();
      } catch (error) {
        void recordSafely(null, null, missingReason(error, params.abortSignal), attempt);
        throw error;
      }

      let reader: ReadableStreamDefaultReader<ModelStreamPart>;
      try {
        reader = result.stream.getReader();
      } catch (error) {
        void recordSafely(null, null, missingReason(error, params.abortSignal), attempt);
        throw error;
      }
      let recorded = false;
      let sawErrorPart = false;
      let abortHandler: (() => void) | null = null;
      const recordOnce = (usage: unknown, providerMetadata: unknown, reason: string | null) => {
        if (recorded) return;
        recorded = true;
        if (abortHandler) params.abortSignal?.removeEventListener("abort", abortHandler);
        // 账本是旁路：不得用 DB 锁等待阻塞 finish/error 向消费者交付。
        void recordSafely(usage, providerMetadata, reason, attempt);
      };
      abortHandler = () => { void recordOnce(null, null, "provider_request_aborted"); };
      if (params.abortSignal?.aborted) abortHandler();
      else params.abortSignal?.addEventListener("abort", abortHandler, { once: true });

      const stream = new ReadableStream<ModelStreamPart>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              recordOnce(
                null,
                null,
                sawErrorPart ? "provider_stream_error_part" : "provider_stream_without_finish",
              );
              controller.close();
              return;
            }
            if (value.type === "error") sawErrorPart = true;
            if (value.type === "finish") {
              recordOnce(value.usage, value.providerMetadata, null);
            }
            controller.enqueue(value);
          } catch (error) {
            recordOnce(null, null, missingReason(error, params.abortSignal));
            controller.error(error);
          }
        },
        async cancel(reason) {
          recordOnce(
            null,
            null,
            params.abortSignal?.aborted ? "provider_request_aborted" : "provider_stream_cancelled",
          );
          await reader.cancel(reason);
        },
      });

      return { ...result, stream };
    },
  };
}
