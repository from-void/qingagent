import type { RequestContext } from "@mastra/core/request-context";
import { TokenCounter } from "@mastra/memory/processors";
import type { LanguageModelMiddleware } from "ai-v5";
import { recordUsageEvent } from "@qingagent/db";
import type { ApiKeyOrigin } from "./modelTypes.js";
import { estimateCostCnyAt } from "./modelPricing.js";
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

/** provider 未返回 usage 时，仅用实际发送/收到的文本做本地估算。 */
export interface ModelCallUsageEstimate {
  /** 可复用的快照前缀；仅表示估算缓存命中，不冒充 provider 实测。 */
  cachedInputText?: string;
  /** 本次新增 prompt；按估算缓存未命中计。 */
  uncachedInputText?: string;
  /** 中止前已收到的正文、思考或工具结果 delta。 */
  outputText?: string;
}

/**
 * Mastra 的 TokenCounter 对纯文本使用 tokenx 粗估，并不会按当前 provider/model
 * 切换到实际 tokenizer。tokenx 对 CJK 直接按字符计数（一个汉字记一个 token），而
 * DeepSeek 实测约为 0.53～0.63 token/字，因此中文方向是高估，不是低估。若拿“可见
 * 正文的 tokenx 结果”去对比“包含 system、tool schema 与消息框架的 prompt_tokens”，
 * 前者仍可能更小，但那是漏算上下文内容，不能反推分词器低估。在没有稳定的
 * provider/model-specific tokenizer 前不乘经验系数，避免把中文推到约两倍高估；正常
 * 完成的请求始终以 provider usage 为准。
 */
const usageTokenCounter = new TokenCounter();

/** 只序列化 provider prompt；失败时宁可缺失，也不让旁路估算影响真实请求。 */
export function serializeModelCallPrompt(params: unknown): string {
  if (params === null || typeof params !== "object") return "";
  try {
    return JSON.stringify((params as { prompt?: unknown }).prompt) ?? "";
  } catch {
    return "";
  }
}

/** 收集中止前 provider 已产出的可计费文本 delta。 */
export function modelCallOutputDelta(part: unknown): string {
  if (part === null || typeof part !== "object") return "";
  const value = part as { type?: unknown; delta?: unknown; textDelta?: unknown };
  if (
    value.type !== "text-delta" &&
    value.type !== "reasoning-delta" &&
    value.type !== "tool-input-delta"
  ) {
    return "";
  }
  if (typeof value.delta === "string") return value.delta;
  return typeof value.textDelta === "string" ? value.textDelta : "";
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
  usageEstimate?: ModelCallUsageEstimate | null;
  providerMetadata?: unknown;
  reason?: string | null;
  finishReason?: string | null;
}

function estimateUsageCounts(
  estimate: ModelCallUsageEstimate | null | undefined,
): ReturnType<typeof normalizeLlmUsageCounts> {
  if (!estimate) return null;
  const promptCacheHitTokens = usageTokenCounter.countString(estimate.cachedInputText ?? "");
  const promptCacheMissTokens = usageTokenCounter.countString(estimate.uncachedInputText ?? "");
  const outputTokens = usageTokenCounter.countString(estimate.outputText ?? "");
  const inputTokens = promptCacheHitTokens + promptCacheMissTokens;
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  };
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
  const recorded = hasUsageCounts(normalized);
  const estimated = recorded ? null : estimateUsageCounts(options.usageEstimate);
  const missing = !recorded && !hasUsageCounts(estimated);
  const usageState = recorded ? "recorded" : estimated ? "estimated" : "missing";
  const reason = options.reason ?? (missing ? "provider_usage_missing" : null);
  const counts = recorded ? normalized : estimated;
  const hitTokens = counts?.promptCacheHitTokens;
  const missTokens = counts?.promptCacheMissTokens;
  const cacheSummary =
    typeof hitTokens === "number" && typeof missTokens === "number"
      ? ` hit/miss=${hitTokens}/${missTokens} usage=${usageState}`
      : missing
        ? ` hit/miss=?/? usage=missing reason=${reason}`
        : ` hit/miss=?/? usage=${usageState}`;
  console.info(
    `${modelCallLogPrefix(options)} done${cacheSummary}` +
      ` latency=${Math.max(0, Date.now() - options.startedAt)}ms` +
      ` finish=${options.finishReason ?? "?"}`,
  );

  const costSnapshot = counts
    ? estimateCostCnyAt(options.modelId, {
        input: counts.inputTokens,
        output: counts.outputTokens,
        cacheHit: counts.promptCacheHitTokens,
        cacheMiss: counts.promptCacheMissTokens,
      }, options.startedAt)
    : null;
  const pricingFields = costSnapshot
    ? {
        costCny: costSnapshot.costCny,
        pricingTier: costSnapshot.pricingTier,
        pricingMultiplier: costSnapshot.pricingMultiplier,
      }
    : { pricingTier: "unpriced" as const };

  try {
    if (recorded && typeof hitTokens === "number" && typeof missTokens === "number") {
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
        occurredAt: options.startedAt,
        pricingTier: "unpriced",
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
      inputTokens: counts?.inputTokens,
      outputTokens: counts?.outputTokens,
      cacheHitTokens: hitTokens,
      cacheMissTokens: missTokens,
      cacheCreationTokens: counts?.promptCacheCreationTokens,
      cacheAccountingState: typeof hitTokens === "number" && typeof missTokens === "number"
        ? "known"
        : "unknown",
      usageState,
      reason,
      occurredAt: options.startedAt,
      ...pricingFields,
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
    usageEstimate?: ModelCallUsageEstimate | null,
  ): Promise<void> => {
    await recordModelCallOutcome({
      ...baseEvent,
      attempt,
      startedAt,
      usage,
      usageEstimate,
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
      const abortUsageEstimate = (): ModelCallUsageEstimate => ({
        uncachedInputText: serializeModelCallPrompt(params),
      });
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
        const reason = missingReason(error, params.abortSignal);
        void recordSafely(
          null,
          null,
          reason,
          attempt,
          startedAt,
          null,
          reason === "provider_request_aborted" ? abortUsageEstimate() : null,
        );
        throw error;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      const attempt = options.attempt ?? nextUsageAttempt(options.requestContext, options.callSite, options.lane);
      const startedAt = Date.now();
      let estimatedOutputText = "";
      const abortUsageEstimate = (): ModelCallUsageEstimate => ({
        uncachedInputText: serializeModelCallPrompt(params),
        outputText: estimatedOutputText,
      });
      logModelCallStart({ ...baseEvent, attempt });
      let result: UsageMiddlewareStreamResult;
      try {
        result = await doStream();
      } catch (error) {
        const reason = missingReason(error, params.abortSignal);
        void recordSafely(
          null,
          null,
          reason,
          attempt,
          startedAt,
          null,
          reason === "provider_request_aborted" ? abortUsageEstimate() : null,
        );
        throw error;
      }

      let reader: ReadableStreamDefaultReader<ModelStreamPart>;
      try {
        reader = result.stream.getReader();
      } catch (error) {
        const reason = missingReason(error, params.abortSignal);
        void recordSafely(
          null,
          null,
          reason,
          attempt,
          startedAt,
          null,
          reason === "provider_request_aborted" ? abortUsageEstimate() : null,
        );
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
        usageEstimate?: ModelCallUsageEstimate | null,
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
          usageEstimate,
        );
      };
      abortHandler = () => {
        void recordOnce(
          null,
          null,
          "provider_request_aborted",
          null,
          abortUsageEstimate(),
        );
      };
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
            estimatedOutputText += modelCallOutputDelta(value);
            if (value.type === "finish") {
              recordOnce(value.usage, value.providerMetadata, null, value.finishReason);
            }
            controller.enqueue(value);
          } catch (error) {
            const reason = missingReason(error, params.abortSignal);
            recordOnce(
              null,
              null,
              reason,
              null,
              reason === "provider_request_aborted" ? abortUsageEstimate() : null,
            );
            controller.error(error);
          }
        },
        async cancel(reason) {
          const terminalReason = params.abortSignal?.aborted
            ? "provider_request_aborted"
            : "provider_stream_cancelled";
          recordOnce(
            null,
            null,
            terminalReason,
            null,
            terminalReason === "provider_request_aborted" ? abortUsageEstimate() : null,
          );
          await reader.cancel(reason);
        },
      });

      return { ...result, stream };
    },
  };
}
