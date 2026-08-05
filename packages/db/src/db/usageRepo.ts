// F1 usage 账本读写。写入是 fire-and-forget(绝不影响生成主链),读取供设置页聚合展示。

import { randomUUID } from "node:crypto";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

type ApiKeyOrigin = "visitor" | "global-db" | "env" | "vision" | "none";

export interface UsageEventInput {
  sessionId: string;
  runId?: string | null;
  /** 调用点:agent / askUser / askMore / writeDraft / generateSvg 等。 */
  callSite: string;
  modelId: string;
  keyOrigin: ApiKeyOrigin;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheCreationTokens?: number;
  /** known 仅在 hit/miss 都由 provider 给出或可可靠推导时使用。 */
  cacheAccountingState?: "known" | "unknown";
  /** recorded=provider 实测；estimated=按 prompt/delta 本地估算；missing=无法取得或估算。 */
  usageState?: "recorded" | "estimated" | "missing";
  reason?: string | null;
  /** 并发赛马 lane；非赛马调用可为空。 */
  lane?: number | null;
  /** 同一 lane/call site 内的真实 provider 请求序号，从 1 开始。 */
  attempt?: number | null;
  /** 调用开始时计算并固化的人民币金额；未收录价目的模型为空。 */
  costCny?: number | null;
  /** null 仅属于迁移前旧行；新事件必须明确标出是否可计价。 */
  pricingTier?: "standard" | "peak" | "unpriced" | null;
  pricingMultiplier?: number | null;
  /** provider 请求实际开始时刻；计价与事件日历归属统一使用这一时刻。 */
  occurredAt?: string | number | Date;
}

function toCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function toCost(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toMultiplier(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toOccurredAt(value: string | number | Date | undefined): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** 写一条 usage 事件;失败只 console.warn,绝不抛(主链优先)。
 *  recorded 的 input/output 全 0 时跳过；estimated/missing 仍保留终态事实。 */
export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  const usageState = input.usageState ?? "recorded";
  const cacheAccountingState = input.cacheAccountingState ?? (
    input.cacheHitTokens !== undefined && input.cacheMissTokens !== undefined ? "known" : "unknown"
  );
  if (
    usageState === "recorded" &&
    toCount(input.inputTokens) === 0 &&
    toCount(input.outputTokens) === 0
  ) return;
  const costCny = toCost(input.costCny);
  const pricingTier = input.pricingTier ?? (costCny === null ? "unpriced" : "standard");
  const pricingMultiplier = pricingTier === "unpriced"
    ? null
    : toMultiplier(input.pricingMultiplier) ?? 1;
  try {
    const client = getDocumentsClient();
    await ensureMigrated();
    await withWriteRetry(() =>
      client.execute({
        sql: `INSERT INTO llm_usage_events
          (id, session_id, run_id, call_site, model_id, key_origin,
           input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
           cache_creation_tokens, cache_accounting_state, usage_state, reason, lane, attempt,
           cost_cny, pricing_tier, pricing_multiplier, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          input.sessionId,
          input.runId ?? null,
          input.callSite,
          input.modelId,
          input.keyOrigin,
          toCount(input.inputTokens),
          toCount(input.outputTokens),
          toCount(input.cacheHitTokens),
          toCount(input.cacheMissTokens),
          toCount(input.cacheCreationTokens),
          cacheAccountingState,
          usageState,
          input.reason ?? null,
          input.lane ?? null,
          input.attempt ?? null,
          costCny,
          pricingTier,
          pricingMultiplier,
          toOccurredAt(input.occurredAt),
        ],
      }),
    );
  } catch (err) {
    console.warn("[usage] 记录 usage 事件失败(不影响主链)", {
      callSite: input.callSite,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface UsageAggRow {
  /** 聚合桶:day 模式为 YYYY-MM-DD,session 模式为 session_id。 */
  bucket: string;
  /** 按天聚合内部保留真实会话键，供上层兼容旧线程标题。 */
  sessionId?: string;
  /** 按天聚合的文档主表 ID；旧数据无主表行时回退 session_id。 */
  documentId?: string;
  /** documents.title 为空时不返回，由上层尝试旧线程标题。 */
  documentTitle?: string;
  callSite: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** estimated 永不混入上面的 provider 实测 token。 */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCacheHitTokens?: number;
  estimatedCacheMissTokens?: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** 每个会话 × 调用点 × 并发 lane 首次请求中可确知用于建缓存的 miss token。 */
  coldStartMissTokens: number;
  cacheCreationTokens: number;
  /** hit/(hit+miss)；provider 未给缓存拆分时为 null，而不是 0。 */
  cacheHitRate: number | null;
  calls: number;
  recordedCalls: number;
  estimatedCalls?: number;
  missingCalls: number;
  /** provider 实测请求占全部真实请求比例；estimated/missing 都不进入精确覆盖率。 */
  coverageRate: number;
  /** 调用发生时已固化的金额，recorded 与 estimated 始终分开。 */
  costCny?: number;
  estimatedCostCny?: number;
  /** 当前聚合中按北京时间高峰倍率计价的真实请求。 */
  peakPricedCalls?: number;
  peakPricingMultiplierMin?: number;
  peakPricingMultiplierMax?: number;
  /** 仅供 server 区分迁移前旧行与已明确 unpriced 的新行，不对外返回。 */
  pricingSnapshotCalls?: number;
  legacyPricingCalls?: number;
  legacyInputTokens?: number;
  legacyOutputTokens?: number;
  legacyCacheHitTokens?: number;
  legacyCacheMissTokens?: number;
  legacyEstimatedInputTokens?: number;
  legacyEstimatedOutputTokens?: number;
  legacyEstimatedCacheHitTokens?: number;
  legacyEstimatedCacheMissTokens?: number;
}

function rowToAgg(row: Record<string, unknown>): UsageAggRow {
  const estimatedCalls = Number(row.estimated_calls ?? 0);
  const estimatedInputTokens = Number(row.estimated_input_tokens ?? 0);
  const estimatedOutputTokens = Number(row.estimated_output_tokens ?? 0);
  const estimatedCacheHitTokens = Number(row.estimated_cache_hit_tokens ?? 0);
  const estimatedCacheMissTokens = Number(row.estimated_cache_miss_tokens ?? 0);
  const pricedRecordedCalls = Number(row.priced_recorded_calls ?? 0);
  const pricedEstimatedCalls = Number(row.priced_estimated_calls ?? 0);
  const peakPricedCalls = Number(row.peak_priced_calls ?? 0);
  const pricingSnapshotCalls = Number(row.pricing_snapshot_calls ?? 0);
  const legacyPricingCalls = Number(row.legacy_pricing_calls ?? 0);
  return {
    bucket: String(row.bucket ?? ""),
    ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
    ...(row.document_id == null ? {} : { documentId: String(row.document_id) }),
    ...(row.document_title == null || String(row.document_title) === ""
      ? {}
      : { documentTitle: String(row.document_title) }),
    callSite: String(row.call_site ?? ""),
    modelId: String(row.model_id ?? ""),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    ...(estimatedCalls > 0 || estimatedInputTokens > 0 || estimatedOutputTokens > 0
      ? {
          estimatedInputTokens,
          estimatedOutputTokens,
          estimatedCacheHitTokens,
          estimatedCacheMissTokens,
          estimatedCalls,
        }
      : {}),
    cacheHitTokens: Number(row.cache_hit_tokens ?? 0),
    cacheMissTokens: Number(row.cache_miss_tokens ?? 0),
    coldStartMissTokens: Number(row.cold_start_miss_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    cacheHitRate: row.cache_hit_rate == null ? null : Number(row.cache_hit_rate),
    calls: Number(row.calls ?? 0),
    recordedCalls: Number(row.recorded_calls ?? 0),
    missingCalls: Number(row.missing_calls ?? 0),
    coverageRate: Number(row.calls ?? 0) > 0
      ? Number(row.recorded_calls ?? 0) / Number(row.calls)
      : 0,
    ...(pricedRecordedCalls > 0 ? { costCny: Number(row.cost_cny ?? 0) } : {}),
    ...(pricedEstimatedCalls > 0
      ? { estimatedCostCny: Number(row.estimated_cost_cny ?? 0) }
      : {}),
    ...(peakPricedCalls > 0
      ? {
          peakPricedCalls,
          peakPricingMultiplierMin: Number(row.peak_pricing_multiplier_min),
          peakPricingMultiplierMax: Number(row.peak_pricing_multiplier_max),
        }
      : {}),
    ...(pricingSnapshotCalls > 0 ? { pricingSnapshotCalls } : {}),
    ...(legacyPricingCalls > 0
      ? {
          legacyPricingCalls,
          legacyInputTokens: Number(row.legacy_input_tokens ?? 0),
          legacyOutputTokens: Number(row.legacy_output_tokens ?? 0),
          legacyCacheHitTokens: Number(row.legacy_cache_hit_tokens ?? 0),
          legacyCacheMissTokens: Number(row.legacy_cache_miss_tokens ?? 0),
          legacyEstimatedInputTokens: Number(row.legacy_estimated_input_tokens ?? 0),
          legacyEstimatedOutputTokens: Number(row.legacy_estimated_output_tokens ?? 0),
          legacyEstimatedCacheHitTokens: Number(row.legacy_estimated_cache_hit_tokens ?? 0),
          legacyEstimatedCacheMissTokens: Number(row.legacy_estimated_cache_miss_tokens ?? 0),
        }
      : {}),
  };
}

function usageDayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function usageDayBucket(
  value: string | number | Date,
  formatter: Intl.DateTimeFormat,
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function usageDayWindowStart(days: number, formatter: Intl.DateTimeFormat): string {
  const today = usageDayBucket(Date.now(), formatter);
  if (!today) throw new Error("无法计算用量统计日历窗口");
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(Date.UTC(
    year!,
    month! - 1,
    day! - Math.max(0, Math.round(days) - 1),
  ));
  return start.toISOString().slice(0, 10);
}

/** 天级 × 文档 × 调用点 × 模型聚合(默认最近 30 个客户端日历日)。 */
export async function aggregateUsageByDay(
  days = 30,
  timeZone = "UTC",
): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const normalizedDays = Math.max(1, Math.round(days));
  const formatter = usageDayFormatter(timeZone);
  const firstBucket = usageDayWindowStart(normalizedDays, formatter);
  // SQL 只做保守裁剪；精确窗口由 IANA 日历日键过滤，避免 DST 变更日误用当前偏移。
  const since = new Date(Date.now() - (normalizedDays + 2) * 86_400_000).toISOString();
  const result = await client.execute({
    sql: `WITH first_cache_requests AS (
        SELECT session_id, call_site, lane, MIN(created_at) AS first_created_at
        FROM llm_usage_events
        GROUP BY session_id, call_site, lane
      )
      SELECT usage.created_at,
        usage.session_id,
        COALESCE(document.id, usage.session_id) AS document_id,
        NULLIF(document.title, '') AS document_title,
        usage.call_site,
        usage.model_id,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_hit_tokens,
        usage.cache_miss_tokens,
        usage.cache_creation_tokens,
        usage.cache_accounting_state,
        usage.usage_state,
        usage.cost_cny,
        usage.pricing_tier,
        usage.pricing_multiplier,
        CASE WHEN usage.created_at = first_cache.first_created_at THEN 1 ELSE 0 END AS is_cold_start
      FROM llm_usage_events usage
      INNER JOIN first_cache_requests first_cache
        ON first_cache.session_id = usage.session_id
        AND first_cache.call_site = usage.call_site
        AND first_cache.lane IS usage.lane
      LEFT JOIN documents document
        ON document.thread_id = usage.session_id AND document.role = 'main'
      WHERE usage.created_at >= ?
      ORDER BY usage.created_at DESC`,
    args: [since],
  });
  const grouped = new Map<string, Record<string, unknown>>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const bucket = usageDayBucket(String(row.created_at ?? ""), formatter);
    if (!bucket || bucket < firstBucket) continue;
    const key = JSON.stringify([
      bucket,
      row.session_id,
      row.document_id,
      row.document_title,
      row.call_site,
      row.model_id,
    ]);
    const aggregate = grouped.get(key) ?? {
      bucket,
      session_id: row.session_id,
      document_id: row.document_id,
      document_title: row.document_title,
      call_site: row.call_site,
      model_id: row.model_id,
      input_tokens: 0,
      output_tokens: 0,
      cache_hit_tokens: 0,
      cache_miss_tokens: 0,
      cold_start_miss_tokens: 0,
      cache_creation_tokens: 0,
      known_cache_hit_tokens: 0,
      known_cache_total_tokens: 0,
      calls: 0,
      recorded_calls: 0,
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      estimated_cache_hit_tokens: 0,
      estimated_cache_miss_tokens: 0,
      estimated_calls: 0,
      missing_calls: 0,
      cost_cny: 0,
      estimated_cost_cny: 0,
      priced_recorded_calls: 0,
      priced_estimated_calls: 0,
      peak_priced_calls: 0,
      peak_pricing_multiplier_min: null,
      peak_pricing_multiplier_max: null,
      pricing_snapshot_calls: 0,
      legacy_pricing_calls: 0,
      legacy_input_tokens: 0,
      legacy_output_tokens: 0,
      legacy_cache_hit_tokens: 0,
      legacy_cache_miss_tokens: 0,
      legacy_estimated_input_tokens: 0,
      legacy_estimated_output_tokens: 0,
      legacy_estimated_cache_hit_tokens: 0,
      legacy_estimated_cache_miss_tokens: 0,
    };
    aggregate.calls = Number(aggregate.calls) + 1;
    if (row.pricing_tier == null) {
      aggregate.legacy_pricing_calls = Number(aggregate.legacy_pricing_calls) + 1;
    } else {
      aggregate.pricing_snapshot_calls = Number(aggregate.pricing_snapshot_calls) + 1;
    }
    if (
      row.pricing_tier === "peak" &&
      (row.usage_state === "recorded" || row.usage_state === "estimated")
    ) {
      const multiplier = Number(row.pricing_multiplier);
      aggregate.peak_priced_calls = Number(aggregate.peak_priced_calls) + 1;
      aggregate.peak_pricing_multiplier_min = aggregate.peak_pricing_multiplier_min == null
        ? multiplier
        : Math.min(Number(aggregate.peak_pricing_multiplier_min), multiplier);
      aggregate.peak_pricing_multiplier_max = aggregate.peak_pricing_multiplier_max == null
        ? multiplier
        : Math.max(Number(aggregate.peak_pricing_multiplier_max), multiplier);
    }
    if (row.usage_state === "recorded") {
      aggregate.recorded_calls = Number(aggregate.recorded_calls) + 1;
      aggregate.input_tokens = Number(aggregate.input_tokens) + Number(row.input_tokens ?? 0);
      aggregate.output_tokens = Number(aggregate.output_tokens) + Number(row.output_tokens ?? 0);
      aggregate.cache_hit_tokens =
        Number(aggregate.cache_hit_tokens) + Number(row.cache_hit_tokens ?? 0);
      aggregate.cache_miss_tokens =
        Number(aggregate.cache_miss_tokens) + Number(row.cache_miss_tokens ?? 0);
      aggregate.cache_creation_tokens =
        Number(aggregate.cache_creation_tokens) + Number(row.cache_creation_tokens ?? 0);
      if (row.cost_cny != null) {
        aggregate.priced_recorded_calls = Number(aggregate.priced_recorded_calls) + 1;
        aggregate.cost_cny = Number(aggregate.cost_cny) + Number(row.cost_cny);
      }
      if (row.pricing_tier == null) {
        aggregate.legacy_input_tokens =
          Number(aggregate.legacy_input_tokens) + Number(row.input_tokens ?? 0);
        aggregate.legacy_output_tokens =
          Number(aggregate.legacy_output_tokens) + Number(row.output_tokens ?? 0);
        aggregate.legacy_cache_hit_tokens =
          Number(aggregate.legacy_cache_hit_tokens) + Number(row.cache_hit_tokens ?? 0);
        aggregate.legacy_cache_miss_tokens =
          Number(aggregate.legacy_cache_miss_tokens) + Number(row.cache_miss_tokens ?? 0);
      }
      if (row.cache_accounting_state === "known") {
        aggregate.known_cache_hit_tokens =
          Number(aggregate.known_cache_hit_tokens) + Number(row.cache_hit_tokens ?? 0);
        aggregate.known_cache_total_tokens =
          Number(aggregate.known_cache_total_tokens) +
          Number(row.cache_hit_tokens ?? 0) +
          Number(row.cache_miss_tokens ?? 0);
        // attempt 随每轮 RequestContext 重置，不能识别会话冷启动。按 session/callSite/lane
        // 的最早 created_at 判定；不同 lane 各自首发，完全同时间戳的并列首发也都计入。
        if (Number(row.is_cold_start) === 1) {
          aggregate.cold_start_miss_tokens =
            Number(aggregate.cold_start_miss_tokens) + Number(row.cache_miss_tokens ?? 0);
        }
      }
    } else if (row.usage_state === "estimated") {
      aggregate.estimated_calls = Number(aggregate.estimated_calls) + 1;
      aggregate.estimated_input_tokens =
        Number(aggregate.estimated_input_tokens) + Number(row.input_tokens ?? 0);
      aggregate.estimated_output_tokens =
        Number(aggregate.estimated_output_tokens) + Number(row.output_tokens ?? 0);
      aggregate.estimated_cache_hit_tokens =
        Number(aggregate.estimated_cache_hit_tokens) + Number(row.cache_hit_tokens ?? 0);
      aggregate.estimated_cache_miss_tokens =
        Number(aggregate.estimated_cache_miss_tokens) + Number(row.cache_miss_tokens ?? 0);
      if (row.cost_cny != null) {
        aggregate.priced_estimated_calls = Number(aggregate.priced_estimated_calls) + 1;
        aggregate.estimated_cost_cny =
          Number(aggregate.estimated_cost_cny) + Number(row.cost_cny);
      }
      if (row.pricing_tier == null) {
        aggregate.legacy_estimated_input_tokens =
          Number(aggregate.legacy_estimated_input_tokens) + Number(row.input_tokens ?? 0);
        aggregate.legacy_estimated_output_tokens =
          Number(aggregate.legacy_estimated_output_tokens) + Number(row.output_tokens ?? 0);
        aggregate.legacy_estimated_cache_hit_tokens =
          Number(aggregate.legacy_estimated_cache_hit_tokens) + Number(row.cache_hit_tokens ?? 0);
        aggregate.legacy_estimated_cache_miss_tokens =
          Number(aggregate.legacy_estimated_cache_miss_tokens) + Number(row.cache_miss_tokens ?? 0);
      }
    } else if (row.usage_state === "missing") {
      aggregate.missing_calls = Number(aggregate.missing_calls) + 1;
    }
    grouped.set(key, aggregate);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...rowToAgg({
        ...row,
        cache_hit_rate: Number(row.known_cache_total_tokens) > 0
          ? Number(row.known_cache_hit_tokens) / Number(row.known_cache_total_tokens)
          : null,
      }),
    }))
    .sort((left, right) =>
      right.bucket.localeCompare(left.bucket) ||
      (left.documentTitle ?? "").localeCompare(right.documentTitle ?? "") ||
      (left.documentId ?? "").localeCompare(right.documentId ?? "") ||
      left.callSite.localeCompare(right.callSite) ||
      left.modelId.localeCompare(right.modelId)
    );
}

/** 会话级 × 模型聚合(默认最近 200 个会话桶)。 */
export async function aggregateUsageBySession(limit = 200): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute({
    sql: `WITH first_cache_requests AS (
        SELECT session_id, call_site, lane, MIN(created_at) AS first_created_at
        FROM llm_usage_events
        GROUP BY session_id, call_site, lane
      ), recent_sessions AS (
        SELECT session_id, MAX(created_at) AS last_at
        FROM llm_usage_events
        GROUP BY session_id
        ORDER BY last_at DESC, session_id
        LIMIT ?
      )
      SELECT usage.session_id AS bucket, usage.call_site, usage.model_id,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.input_tokens ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.input_tokens ELSE 0 END) AS estimated_input_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.output_tokens ELSE 0 END) AS estimated_output_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_hit_tokens ELSE 0 END) AS estimated_cache_hit_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_miss_tokens ELSE 0 END) AS estimated_cache_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded'
          AND usage.cache_accounting_state = 'known'
          AND usage.created_at = first_cache.first_created_at
          THEN usage.cache_miss_tokens ELSE 0 END) AS cold_start_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN COALESCE(usage.cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cost_cny IS NOT NULL THEN usage.cost_cny ELSE 0 END) AS cost_cny,
        SUM(CASE WHEN usage.usage_state = 'estimated' AND usage.cost_cny IS NOT NULL THEN usage.cost_cny ELSE 0 END) AS estimated_cost_cny,
        SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cost_cny IS NOT NULL THEN 1 ELSE 0 END) AS priced_recorded_calls,
        SUM(CASE WHEN usage.usage_state = 'estimated' AND usage.cost_cny IS NOT NULL THEN 1 ELSE 0 END) AS priced_estimated_calls,
        SUM(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN 1 ELSE 0 END) AS peak_priced_calls,
        MIN(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN usage.pricing_multiplier END) AS peak_pricing_multiplier_min,
        MAX(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN usage.pricing_multiplier END) AS peak_pricing_multiplier_max,
        SUM(CASE WHEN usage.pricing_tier IS NOT NULL THEN 1 ELSE 0 END) AS pricing_snapshot_calls,
        SUM(CASE WHEN usage.pricing_tier IS NULL THEN 1 ELSE 0 END) AS legacy_pricing_calls,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.input_tokens ELSE 0 END) AS legacy_input_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.output_tokens ELSE 0 END) AS legacy_output_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.cache_hit_tokens ELSE 0 END) AS legacy_cache_hit_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.cache_miss_tokens ELSE 0 END) AS legacy_cache_miss_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.input_tokens ELSE 0 END) AS legacy_estimated_input_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.output_tokens ELSE 0 END) AS legacy_estimated_output_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.cache_hit_tokens ELSE 0 END) AS legacy_estimated_cache_hit_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.cache_miss_tokens ELSE 0 END) AS legacy_estimated_cache_miss_tokens,
        1.0 * SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known' THEN usage.cache_hit_tokens ELSE 0 END) /
          NULLIF(SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known' THEN usage.cache_hit_tokens + usage.cache_miss_tokens ELSE 0 END), 0) AS cache_hit_rate,
        COUNT(*) AS calls,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls,
        SUM(CASE WHEN usage.usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls,
        MAX(usage.created_at) AS last_at
      FROM llm_usage_events usage
      INNER JOIN recent_sessions recent ON recent.session_id = usage.session_id
      INNER JOIN first_cache_requests first_cache
        ON first_cache.session_id = usage.session_id
        AND first_cache.call_site = usage.call_site
        AND first_cache.lane IS usage.lane
      GROUP BY usage.session_id, usage.call_site, usage.model_id, recent.last_at
      ORDER BY recent.last_at DESC, usage.session_id, usage.call_site, usage.model_id`,
    args: [limit],
  });
  return result.rows.map((r) => rowToAgg(r as unknown as Record<string, unknown>));
}

/** 全局总量 × 模型。 */
export async function aggregateUsageTotal(): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute(
    `WITH first_cache_requests AS (
        SELECT session_id, call_site, lane, MIN(created_at) AS first_created_at
        FROM llm_usage_events
        GROUP BY session_id, call_site, lane
      )
      SELECT 'total' AS bucket, usage.call_site, usage.model_id,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.input_tokens ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.input_tokens ELSE 0 END) AS estimated_input_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.output_tokens ELSE 0 END) AS estimated_output_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_hit_tokens ELSE 0 END) AS estimated_cache_hit_tokens,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_miss_tokens ELSE 0 END) AS estimated_cache_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded'
          AND usage.cache_accounting_state = 'known'
          AND usage.created_at = first_cache.first_created_at
          THEN usage.cache_miss_tokens ELSE 0 END) AS cold_start_miss_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN COALESCE(usage.cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
        SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cost_cny IS NOT NULL THEN usage.cost_cny ELSE 0 END) AS cost_cny,
        SUM(CASE WHEN usage.usage_state = 'estimated' AND usage.cost_cny IS NOT NULL THEN usage.cost_cny ELSE 0 END) AS estimated_cost_cny,
        SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cost_cny IS NOT NULL THEN 1 ELSE 0 END) AS priced_recorded_calls,
        SUM(CASE WHEN usage.usage_state = 'estimated' AND usage.cost_cny IS NOT NULL THEN 1 ELSE 0 END) AS priced_estimated_calls,
        SUM(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN 1 ELSE 0 END) AS peak_priced_calls,
        MIN(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN usage.pricing_multiplier END) AS peak_pricing_multiplier_min,
        MAX(CASE WHEN usage.pricing_tier = 'peak' AND usage.usage_state IN ('recorded', 'estimated') THEN usage.pricing_multiplier END) AS peak_pricing_multiplier_max,
        SUM(CASE WHEN usage.pricing_tier IS NOT NULL THEN 1 ELSE 0 END) AS pricing_snapshot_calls,
        SUM(CASE WHEN usage.pricing_tier IS NULL THEN 1 ELSE 0 END) AS legacy_pricing_calls,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.input_tokens ELSE 0 END) AS legacy_input_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.output_tokens ELSE 0 END) AS legacy_output_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.cache_hit_tokens ELSE 0 END) AS legacy_cache_hit_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'recorded' THEN usage.cache_miss_tokens ELSE 0 END) AS legacy_cache_miss_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.input_tokens ELSE 0 END) AS legacy_estimated_input_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.output_tokens ELSE 0 END) AS legacy_estimated_output_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.cache_hit_tokens ELSE 0 END) AS legacy_estimated_cache_hit_tokens,
        SUM(CASE WHEN usage.pricing_tier IS NULL AND usage.usage_state = 'estimated' THEN usage.cache_miss_tokens ELSE 0 END) AS legacy_estimated_cache_miss_tokens,
        1.0 * SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known' THEN usage.cache_hit_tokens ELSE 0 END) /
          NULLIF(SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known' THEN usage.cache_hit_tokens + usage.cache_miss_tokens ELSE 0 END), 0) AS cache_hit_rate,
        COUNT(*) AS calls,
        SUM(CASE WHEN usage.usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
        SUM(CASE WHEN usage.usage_state = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls,
        SUM(CASE WHEN usage.usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls
      FROM llm_usage_events usage
      INNER JOIN first_cache_requests first_cache
        ON first_cache.session_id = usage.session_id
        AND first_cache.call_site = usage.call_site
        AND first_cache.lane IS usage.lane
      GROUP BY usage.call_site, usage.model_id
      ORDER BY usage.call_site, usage.model_id`,
  );
  return result.rows.map((r) => rowToAgg(r as unknown as Record<string, unknown>));
}

/** 单会话最近一次 agent 调用的 usage(F6 上下文 debug 用)。 */
export async function latestAgentUsageForSession(
  sessionId: string,
): Promise<{ inputTokens: number; outputTokens: number; modelId: string; createdAt: string } | null> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute({
    sql: `SELECT model_id, input_tokens, output_tokens, created_at
      FROM llm_usage_events WHERE session_id = ? AND call_site = 'agent'
      ORDER BY created_at DESC LIMIT 1`,
    args: [sessionId],
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    modelId: String(row.model_id ?? ""),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    createdAt: String(row.created_at ?? ""),
  };
}
