import type { RequestContext } from "@mastra/core/request-context";
import type { ApiKeyOrigin } from "./modelConfig.js";
import { nextUsageAttempt } from "./usageAttempt.js";
import {
  logModelCallStart,
  recordModelCallOutcome,
} from "./usageMiddleware.js";
import type { ModelCallSite } from "./modelCallSites.js";

export interface ModernUsageModelOptions {
  requestContext?: RequestContext;
  callSite: ModelCallSite;
  modelId: string;
  keyOrigin: ApiKeyOrigin;
  lane?: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
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
    requestContext: options.requestContext,
    callSite: options.callSite,
    modelId: options.modelId,
    keyOrigin: options.keyOrigin,
    lane: options.lane ?? null,
    transport: "mastra-v2-v3" as const,
  };

  const record = async (
    usage: unknown,
    providerMetadata: unknown,
    reason: string | null,
    attempt: number,
    startedAt: number,
    finishReason?: string | null,
  ): Promise<void> => {
    await recordModelCallOutcome({
      ...baseEvent,
      usage,
      providerMetadata,
      reason,
      attempt,
      startedAt,
      finishReason,
    });
  };

  const boundFunctions = new Map<PropertyKey, { source: Function; bound: Function }>();
  return new Proxy(model, {
    get(target, property) {
      // Mastra 的 ModelRouterLanguageModel 含 #lastStreamTransport 等私有字段；instanceof 会穿透
      // Proxy，但其方法若以 Proxy 为 this 就会触发私有字段品牌检查异常，因此 getter 与普通方法
      // 都必须以真实实例为 receiver/this。
      const original = Reflect.get(target, property, target);
      if (property === "doGenerate" && typeof original === "function") {
        return async (...args: unknown[]) => {
          const attempt = nextUsageAttempt(options.requestContext, options.callSite, options.lane);
          const startedAt = Date.now();
          logModelCallStart({ ...baseEvent, attempt });
          const signal = asRecord(args[0])?.abortSignal as AbortSignal | undefined;
          try {
            const result = await Reflect.apply(original, target, args) as unknown;
            const resultRecord = asRecord(result);
            void record(
              resultRecord?.usage,
              resultRecord?.providerMetadata,
              null,
              attempt,
              startedAt,
              typeof resultRecord?.finishReason === "string"
                ? resultRecord.finishReason
                : null,
            );
            return result;
          } catch (error) {
            void record(null, null, missingReason(error, signal), attempt, startedAt);
            throw error;
          }
        };
      }
      if (property === "doStream" && typeof original === "function") return async (...args: unknown[]) => {
        const attempt = nextUsageAttempt(options.requestContext, options.callSite, options.lane);
        const startedAt = Date.now();
        logModelCallStart({ ...baseEvent, attempt });
        const signal = asRecord(args[0])?.abortSignal as AbortSignal | undefined;
        let result: unknown;
        try {
          result = await Reflect.apply(original, target, args);
        } catch (error) {
          void record(null, null, missingReason(error, signal), attempt, startedAt);
          throw error;
        }
        const resultRecord = asRecord(result);
        const source = resultRecord?.stream;
        if (!(source instanceof ReadableStream)) {
          void record(null, null, "provider_stream_invalid", attempt, startedAt);
          return result;
        }
        let reader: ReadableStreamDefaultReader<unknown>;
        try {
          reader = source.getReader();
        } catch (error) {
          void record(null, null, missingReason(error, signal), attempt, startedAt);
          throw error;
        }
        let recorded = false;
        let sawErrorPart = false;
        let abortHandler: (() => void) | null = null;
        const recordOnce = (
          usage: unknown,
          metadata: unknown,
          reason: string | null,
          finishReason?: string | null,
        ) => {
          if (recorded) return;
          recorded = true;
          if (abortHandler) signal?.removeEventListener("abort", abortHandler);
          void record(
            usage,
            metadata,
            reason,
            attempt,
            startedAt,
            finishReason,
          );
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
                recordOnce(
                  part.usage,
                  part.providerMetadata,
                  null,
                  typeof part.finishReason === "string" ? part.finishReason : null,
                );
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
      if (typeof original !== "function") {
        boundFunctions.delete(property);
        return original;
      }
      const cached = boundFunctions.get(property);
      if (cached?.source === original) return cached.bound;
      const bound = original.bind(target) as Function;
      boundFunctions.set(property, { source: original, bound });
      return bound;
    },
  });
}
