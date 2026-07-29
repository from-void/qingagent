import type { RequestContext } from "@mastra/core/request-context";
import type { LanguageModelMiddleware } from "ai-v5";
import { recordUsageEvent } from "@qingagent/db";
import type { ApiKeyOrigin } from "./modelTypes.js";
import { normalizeLlmUsageCounts } from "./usageAccounting.js";
import { nextUsageAttempt } from "./usageAttempt.js";
import { observeCacheOutcome } from "./cacheEfficiencySentinel.js";
import type { ModelCallSite, ModelCallTransport } from "./modelCallSites.js";

type UsageMiddlewareStreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type ModelStreamPart = UsageMiddlewareStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

export interface UsageMiddlewareOptions {
  requestContext?: RequestContext;
  callSite: ModelCallSite;
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

export interface ModelCallOutcomeOptions {
  requestContext?: RequestContext;
  sessionId?: string;
  runId?: string | null;
  streamId?: string | null;
  callSite: ModelCallSite;
  modelId: string;
  keyOrigin: ApiKeyOrigin;
  lane?: number | null;
  attempt: number;
  transport: ModelCallTransport;
  startedAt: number;
  usage: unknown;
  providerMetadata?: unknown;
  reason?: string | null;
  finishReason?: string | null;
}

interface ModelCallContext {
  sessionId: string;
  runId: string | null;
  streamId: string | null;
}

function readContextString(
  requestContext: RequestContext | undefined,
  key: string,
): string | null {
  const value = requestContext?.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveModelCallContext(
  options: Pick<
    ModelCallOutcomeOptions,
    "requestContext" | "sessionId" | "runId" | "streamId"
  >,
): ModelCallContext {
  return {
    sessionId:
      readContextString(options.requestContext, "sessionId") ??
      options.sessionId ??
      "unknown",
    runId:
      readContextString(options.requestContext, "runId") ??
      options.runId ??
      null,
    streamId:
      readContextString(options.requestContext, "streamId") ??
      options.streamId ??
      null,
  };
}

function modelCallLogPrefix(
  options: Pick<
    ModelCallOutcomeOptions,
    "requestContext" | "sessionId" | "runId" | "streamId" | "callSite" | "transport" | "attempt" | "lane"
  >,
): string {
  const context = resolveModelCallContext(options);
  return (
    `[modelCall] site=${options.callSite} transport=${options.transport}` +
    ` session=${context.sessionId} run=${context.runId ?? "?"}` +
    ` stream=${context.streamId ?? "?"} lane=${options.lane ?? "?"}` +
    ` attempt=${options.attempt}`
  );
}

export function logModelCallStart(
  options: Pick<
    ModelCallOutcomeOptions,
    "requestContext" | "sessionId" | "runId" | "streamId" | "callSite" | "transport" | "attempt" | "lane"
  >,
): void {
  console.info(`${modelCallLogPrefix(options)} start`);
}

/** 将一次真实 provider 请求的唯一终态规范化、记录缓存哨兵并旁路写入账本。 */
export async function recordModelCallOutcome(
  options: ModelCallOutcomeOptions,
): Promise<void> {
  const context = resolveModelCallContext(options);
  const usageRecord = options.usage !== null && typeof options.usage === "object"
    ? options.usage as Record<string, unknown>
    : null;
  const normalized = normalizeLlmUsageCounts(
    usageRecord && options.providerMetadata
      ? { ...usageRecord, providerMetadata: options.providerMetadata }
      : options.usage,
  );
  const missing = Boolean(options.reason) || !hasUsageCounts(normalized);
  const reason = options.reason ?? (missing ? "provider_usage_missing" : null);
  const hitTokens = normalized?.promptCacheHitTokens;
  const missTokens = normalized?.promptCacheMissTokens;
  const cacheSummary =
    typeof hitTokens === "number" && typeof missTokens === "number"
      ? ` hit/miss=${hitTokens}/${missTokens}`
      : missing
        ? ` hit/miss=?/? usage=missing reason=${reason}`
        : " hit/miss=?/?";
  console.info(
    `${modelCallLogPrefix(options)} done${cacheSummary}` +
      ` latency=${Math.max(0, Date.now() - options.startedAt)}ms` +
      ` finish=${options.finishReason ?? "?"}`,
  );

  try {
    if (!missing && typeof hitTokens === "number" && typeof missTokens === "number") {
      void observeCacheOutcome({
        sessionId: context.sessionId,
        callSite: options.callSite,
        hitTokens,
        missTokens,
      });
    }
    if (missing) {
      await recordUsageEvent({
        sessionId: context.sessionId,
        runId: context.runId,
        callSite: options.callSite,
        modelId: options.modelId,
        keyOrigin: options.keyOrigin,
        lane: options.lane ?? null,
        attempt: options.attempt,
        usageState: "missing",
        reason,
      });
      return;
    }
    await recordUsageEvent({
      sessionId: context.sessionId,
      runId: context.runId,
      callSite: options.callSite,
      modelId: options.modelId,
      keyOrigin: options.keyOrigin,
      lane: options.lane ?? null,
      attempt: options.attempt,
      inputTokens: normalized?.inputTokens,
      outputTokens: normalized?.outputTokens,
      cacheHitTokens: hitTokens,
      cacheMissTokens: missTokens,
      cacheCreationTokens: normalized?.promptCacheCreationTokens,
    });
  } catch (error) {
    // 观测链路永远旁路，不得改变 provider 请求结果。
    console.warn("[modelCall] 入账失败(不影响主链)", {
      callSite: options.callSite,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 在 LanguageModelV2 的传输边界逐个 provider 请求入账。
 * middleware 位于 AI SDK 重试层内，因此一次重试会自然形成另一条真实请求事件。
 */
export function createUsageMiddleware(options: UsageMiddlewareOptions): LanguageModelMiddleware {
  const baseEvent = {
    requestContext: options.requestContext,
    callSite: options.callSite,
    modelId: options.modelId,
    keyOrigin: options.keyOrigin,
    lane: options.lane ?? null,
    transport: "ai-sdk-v2" as const,
  };

  const recordSafely = async (
    usage: unknown,
    providerMetadata: unknown,
    missing: string | null,
    attempt: number,
    startedAt: number,
    finishReason?: string | null,
  ): Promise<void> => {
    await recordModelCallOutcome({
      ...baseEvent,
      attempt,
      startedAt,
      usage,
      providerMetadata,
      reason: missing,
      finishReason,
    });
  };

  return {
    middlewareVersion: "v2",
    wrapGenerate: async ({ doGenerate, params }) => {
      const attempt = options.attempt ?? nextUsageAttempt(options.requestContext, options.callSite, options.lane);
      const startedAt = Date.now();
      logModelCallStart({ ...baseEvent, attempt });
      try {
        const result = await doGenerate();
        void recordSafely(
          result.usage,
          result.providerMetadata,
          null,
          attempt,
          startedAt,
          result.finishReason,
        );
        return result;
      } catch (error) {
        void recordSafely(
          null,
          null,
          missingReason(error, params.abortSignal),
          attempt,
          startedAt,
        );
        throw error;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const attempt = options.attempt ?? nextUsageAttempt(options.requestContext, options.callSite, options.lane);
      const startedAt = Date.now();
      logModelCallStart({ ...baseEvent, attempt });
      let result: UsageMiddlewareStreamResult;
      try {
        result = await doStream();
      } catch (error) {
        void recordSafely(null, null, missingReason(error, params.abortSignal), attempt, startedAt);
        throw error;
      }

      let reader: ReadableStreamDefaultReader<ModelStreamPart>;
      try {
        reader = result.stream.getReader();
      } catch (error) {
        void recordSafely(null, null, missingReason(error, params.abortSignal), attempt, startedAt);
        throw error;
      }
      let recorded = false;
      let sawErrorPart = false;
      let abortHandler: (() => void) | null = null;
      const recordOnce = (
        usage: unknown,
        providerMetadata: unknown,
        reason: string | null,
        finishReason?: string | null,
      ) => {
        if (recorded) return;
        recorded = true;
        if (abortHandler) params.abortSignal?.removeEventListener("abort", abortHandler);
        // 账本是旁路：不得用 DB 锁等待阻塞 finish/error 向消费者交付。
        void recordSafely(
          usage,
          providerMetadata,
          reason,
          attempt,
          startedAt,
          finishReason,
        );
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
              recordOnce(value.usage, value.providerMetadata, null, value.finishReason);
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
