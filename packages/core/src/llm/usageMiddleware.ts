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
import {
  armWireScopeForStreamDelivery,
  claimWireScopeFinalization,
  createWireScope,
  wireUsageStorage,
  type ModelCallUsageEstimate,
  type WireAttempt,
  type WireScope,
} from "./wireUsage.js";

export type { ModelCallUsageEstimate } from "./wireUsage.js";

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

/** recorded 的统一门槛：输入与输出都必须是 provider 给出的有限计数（0 也有效）。 */
export function isCompleteUsage(usage: unknown): boolean {
  const counts = normalizeLlmUsageCounts(usage);
  return typeof counts?.inputTokens === "number" && typeof counts.outputTokens === "number";
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
  /** 调用层在首次 provider await 前创建并持有；记录器不得自行从 ALS 反查。 */
  wireScope?: WireScope;
  /** @internal finalizeOnce 已由本函数认领。 */
  wireFinalizationClaimed?: true;
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

type NormalizedCounts = NonNullable<ReturnType<typeof normalizeLlmUsageCounts>>;
type FinalUsageState = "recorded" | "estimated" | "missing" | "billing_unknown";

export interface ModelUsageConsistencyObservation {
  sessionId: string;
  callSite: ModelCallSite;
  sdk: NormalizedCounts;
  wire: NormalizedCounts;
  consistent: boolean;
}

const modelUsageConsistencyObservers = new Set<
  (observation: ModelUsageConsistencyObservation) => void
>();

/** 仅供真网对账探针订阅；回调异常不得进入模型或账本主链。 */
export function observeModelUsageConsistency(
  observer: (observation: ModelUsageConsistencyObservation) => void,
): () => void {
  modelUsageConsistencyObservers.add(observer);
  return () => modelUsageConsistencyObservers.delete(observer);
}

interface ClassifiedUsage {
  usageState: FinalUsageState;
  counts: NormalizedCounts | null;
  reason: string | null;
  cacheAccountingState?: "known" | "unknown";
}

function wireUsageCounts(attempt: WireAttempt): NormalizedCounts | null {
  const usage = attempt.usage?.usage;
  if (!usage) return null;
  const anthropic = "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage;
  return normalizeLlmUsageCounts(anthropic
    ? { ...usage, providerMetadata: { anthropic: {} } }
    : usage);
}

function upperUsageCounts(options: ModelCallOutcomeOptions): NormalizedCounts | null {
  return normalizeLlmUsageCounts(
    options.usage !== null && typeof options.usage === "object" && options.providerMetadata
      ? { ...(options.usage as Record<string, unknown>), providerMetadata: options.providerMetadata }
      : options.usage,
  );
}

function usageCountsAgree(sdk: NormalizedCounts, wire: NormalizedCounts): boolean {
  if (sdk.inputTokens !== wire.inputTokens || sdk.outputTokens !== wire.outputTokens) return false;
  for (const field of [
    "promptCacheHitTokens",
    "promptCacheMissTokens",
    "promptCacheCreationTokens",
  ] as const) {
    if (sdk[field] !== undefined && wire[field] !== undefined && sdk[field] !== wire[field]) {
      return false;
    }
  }
  return true;
}

function conservativeAttemptEstimate(
  attempt: WireAttempt,
  upperEstimate?: ModelCallUsageEstimate | null,
): NormalizedCounts {
  // wire 路径不使用缓存先验：所有序列化 prompt 都按 miss 估算。
  const inputText = [
    attempt.requestEstimate.uncachedInputText,
    upperEstimate?.uncachedInputText,
    upperEstimate?.cachedInputText,
  ].filter((value): value is string => Boolean(value)).join("\n");
  const outputText = attempt.outputText || upperEstimate?.outputText || "";
  const inputTokens = usageTokenCounter.countString(inputText);
  const outputTokens = usageTokenCounter.countString(outputText);
  return {
    inputTokens,
    outputTokens,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: inputTokens,
  };
}

function partialWireEstimate(
  attempt: WireAttempt,
  upperEstimate?: ModelCallUsageEstimate | null,
): NormalizedCounts {
  const measured = wireUsageCounts(attempt);
  const estimated = conservativeAttemptEstimate(attempt, upperEstimate);
  return {
    inputTokens: measured?.inputTokens ?? estimated.inputTokens,
    outputTokens: estimated.outputTokens,
    ...(measured?.promptCacheHitTokens === undefined
      ? { promptCacheHitTokens: estimated.promptCacheHitTokens }
      : { promptCacheHitTokens: measured.promptCacheHitTokens }),
    ...(measured?.promptCacheMissTokens === undefined
      ? { promptCacheMissTokens: estimated.promptCacheMissTokens }
      : { promptCacheMissTokens: measured.promptCacheMissTokens }),
    ...(measured?.promptCacheCreationTokens === undefined
      ? {}
      : { promptCacheCreationTokens: measured.promptCacheCreationTokens }),
  };
}

function classifyWireAttempt(
  options: ModelCallOutcomeOptions,
  attempt: WireAttempt,
  terminal: boolean,
): ClassifiedUsage {
  const upper = terminal ? upperUsageCounts(options) : null;
  if (terminal && isCompleteUsage(
    options.usage !== null && typeof options.usage === "object" && options.providerMetadata
      ? { ...(options.usage as Record<string, unknown>), providerMetadata: options.providerMetadata }
      : options.usage,
  )) {
    return { usageState: "recorded", counts: upper, reason: options.reason ?? null };
  }
  const wireCounts = wireUsageCounts(attempt);
  if (attempt.usage?.completeness === "complete" && isCompleteUsage(
    "cache_read_input_tokens" in attempt.usage.usage ||
      "cache_creation_input_tokens" in attempt.usage.usage
      ? { ...attempt.usage.usage, providerMetadata: { anthropic: {} } }
      : attempt.usage.usage,
  )) {
    return { usageState: "recorded", counts: wireCounts, reason: terminal ? options.reason ?? null : null };
  }
  if (attempt.usage?.completeness === "partial-input") {
    return {
      usageState: "estimated",
      counts: partialWireEstimate(attempt, terminal ? options.usageEstimate : null),
      reason: options.reason ? `wire-partial:${options.reason}` : "wire-partial",
      cacheAccountingState: "unknown",
    };
  }
  if (attempt.responseStatus !== null && attempt.responseStatus >= 200 && attempt.responseStatus < 300) {
    const estimate = conservativeAttemptEstimate(attempt, terminal ? options.usageEstimate : null);
    // SDK 偶发只保留一侧 usage 时，该侧仍优先于字符估算，但绝不升 recorded。
    const counts = terminal && upper
      ? {
          ...estimate,
          ...(typeof upper.inputTokens === "number" ? { inputTokens: upper.inputTokens } : {}),
          ...(typeof upper.outputTokens === "number" ? { outputTokens: upper.outputTokens } : {}),
          ...(typeof upper.promptCacheHitTokens === "number"
            ? { promptCacheHitTokens: upper.promptCacheHitTokens }
            : {}),
          ...(typeof upper.promptCacheMissTokens === "number"
            ? { promptCacheMissTokens: upper.promptCacheMissTokens }
            : {}),
          ...(typeof upper.promptCacheCreationTokens === "number"
            ? { promptCacheCreationTokens: upper.promptCacheCreationTokens }
            : {}),
        }
      : estimate;
    return {
      usageState: "estimated",
      counts,
      reason: options.reason ?? (terminal ? "provider_usage_missing" : "wire_attempt_incomplete"),
    };
  }
  return {
    usageState: "billing_unknown",
    counts: null,
    reason: attempt.responseStatus === null ? "no_response" : `http_${attempt.responseStatus}`,
  };
}

function classifyWithoutWire(options: ModelCallOutcomeOptions): ClassifiedUsage {
  const usageRecord = options.usage !== null && typeof options.usage === "object"
    ? options.usage as Record<string, unknown>
    : null;
  const normalized = normalizeLlmUsageCounts(
    usageRecord && options.providerMetadata
      ? { ...usageRecord, providerMetadata: options.providerMetadata }
      : options.usage,
  );
  if (isCompleteUsage(
    usageRecord && options.providerMetadata
      ? { ...usageRecord, providerMetadata: options.providerMetadata }
      : options.usage,
  )) {
    return { usageState: "recorded", counts: normalized, reason: options.reason ?? null };
  }
  const estimated = estimateUsageCounts(options.usageEstimate);
  if (estimated || hasUsageCounts(normalized)) {
    return {
      usageState: "estimated",
      counts: { ...(estimated ?? {}), ...(normalized ?? {}) },
      reason: options.reason ?? "provider_usage_incomplete",
    };
  }
  return {
    usageState: "missing",
    counts: null,
    reason: options.reason ?? "provider_usage_missing",
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

function observeSdkWireConsistency(
  options: ModelCallOutcomeOptions,
  context: ModelCallContext,
  attempts: WireAttempt[],
): void {
  const terminal = attempts.at(-1);
  if (!terminal || terminal.usage?.completeness !== "complete") return;
  const sdk = upperUsageCounts(options);
  const wire = wireUsageCounts(terminal);
  if (!sdk || !wire || !isCompleteUsage(options.usage) || !isCompleteUsage(terminal.usage.usage)) return;
  const observation: ModelUsageConsistencyObservation = {
    sessionId: context.sessionId,
    callSite: options.callSite,
    sdk,
    wire,
    consistent: usageCountsAgree(sdk, wire),
  };
  console.info(
    `${modelCallLogPrefix(options)} wire/sdk consistency=${observation.consistent ? "match" : "mismatch"}`,
  );
  for (const observer of modelUsageConsistencyObservers) {
    try {
      observer(observation);
    } catch {
      // 探针旁路不能改变模型调用与入账。
    }
  }
}

/** 将一次真实 provider 请求的唯一终态规范化、记录缓存哨兵并旁路写入账本。 */
export async function recordModelCallOutcome(
  options: ModelCallOutcomeOptions,
): Promise<void> {
  if (options.wireScope && !options.wireFinalizationClaimed) {
    if (!claimWireScopeFinalization(options.wireScope)) return;
    return recordModelCallOutcome({ ...options, wireFinalizationClaimed: true });
  }
  const context = resolveModelCallContext(options);
  const attempts = options.wireScope?.attempts ?? [];
  if (options.wireScope && attempts.length === 0) {
    console.info(`${modelCallLogPrefix(options)} wire coverage=scope_without_attempt`);
  }
  observeSdkWireConsistency(options, context, attempts);
  const rows = attempts.length > 0
    ? attempts.map((attempt, index) => ({
        attempt,
        classified: classifyWireAttempt(options, attempt, index === attempts.length - 1),
      }))
    : [{ attempt: null, classified: classifyWithoutWire(options) }];

  for (const row of rows) {
    await recordClassifiedModelCall(options, context, row.classified, row.attempt);
  }
}

async function recordClassifiedModelCall(
  options: ModelCallOutcomeOptions,
  context: ModelCallContext,
  classified: ClassifiedUsage,
  wireAttempt: WireAttempt | null,
): Promise<void> {
  const { usageState, counts, reason } = classified;
  const occurredAt = wireAttempt?.startedAt ?? options.startedAt;
  const recorded = usageState === "recorded";
  const missing = usageState === "missing";
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
      `${wireAttempt ? ` wireAttempt=${wireAttempt.wireAttemptSeq}` : ""}` +
      ` finish=${options.finishReason ?? "?"}`,
  );

  const costSnapshot = counts
    ? estimateCostCnyAt(options.modelId, {
        input: counts.inputTokens,
        output: counts.outputTokens,
        cacheHit: counts.promptCacheHitTokens,
        cacheMiss: counts.promptCacheMissTokens,
      }, occurredAt)
    : null;
  const pricingFields = costSnapshot
    ? {
        costCny: costSnapshot.costCny,
        pricingTier: costSnapshot.pricingTier,
        pricingMultiplier: costSnapshot.pricingMultiplier,
      }
    : { pricingTier: "unpriced" as const };

  try {
    const cacheAccountingState = classified.cacheAccountingState ?? (
      typeof hitTokens === "number" && typeof missTokens === "number" ? "known" : "unknown"
    );
    if (
      recorded && cacheAccountingState === "known" &&
      typeof hitTokens === "number" && typeof missTokens === "number"
    ) {
      void observeCacheOutcome({
        sessionId: context.sessionId,
        callSite: options.callSite,
        hitTokens,
        missTokens,
      });
    }
    if (missing || usageState === "billing_unknown") {
      await recordUsageEvent({
        sessionId: context.sessionId,
        runId: context.runId,
        callSite: options.callSite,
        modelId: options.modelId,
        keyOrigin: options.keyOrigin,
        lane: options.lane ?? null,
        attempt: options.attempt,
        usageState,
        reason,
        occurredAt,
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
      cacheAccountingState,
      usageState,
      reason,
      occurredAt,
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
    wireScope?: WireScope,
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
      wireScope,
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
      let wireScope!: WireScope;
      wireScope = createWireScope({
        onFinalizeTimeout: () => {
          void recordSafely(
            null,
            null,
            "finalize_timeout",
            attempt,
            startedAt,
            null,
            abortUsageEstimate(),
            wireScope,
          );
        },
      });
      logModelCallStart({ ...baseEvent, attempt });
      try {
        const result = await wireUsageStorage.run(wireScope, () => doGenerate());
        void recordSafely(
          result.usage,
          result.providerMetadata,
          null,
          attempt,
          startedAt,
          result.finishReason,
          null,
          wireScope,
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
          wireScope,
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
      let wireScope!: WireScope;
      wireScope = createWireScope({
        onFinalizeTimeout: () => {
          void recordSafely(
            null,
            null,
            "finalize_timeout",
            attempt,
            startedAt,
            null,
            abortUsageEstimate(),
            wireScope,
          );
        },
      });
      logModelCallStart({ ...baseEvent, attempt });
      let result: UsageMiddlewareStreamResult;
      try {
        result = await wireUsageStorage.run(wireScope, () => doStream());
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
          wireScope,
        );
        throw error;
      }
      armWireScopeForStreamDelivery(wireScope);

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
          wireScope,
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
          wireScope,
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
