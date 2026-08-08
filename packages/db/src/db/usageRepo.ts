// F1 usage 事实账本。写端只记录原始量；金额由 core 按 schedule 在读端纯派生。

import { randomUUID } from "node:crypto";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import { isCanonicalUsageTimestamp } from "./usageTimestamp.js";

type ApiKeyOrigin = "visitor" | "global-db" | "env" | "vision" | "none";
export type UsageState = "recorded" | "estimated" | "missing" | "billing_unknown";
export type CacheAccountingState = "known" | "unknown";

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
  cacheAccountingState?: CacheAccountingState;
  /** recorded=provider 实测；estimated=本地估算；missing=未接 wire；billing_unknown=收费结果未知。 */
  usageState?: UsageState;
  reason?: string | null;
  /** 并发赛马 lane；非赛马调用可为空。 */
  lane?: number | null;
  /** 同一 lane/call site 内的真实 provider 请求序号，从 1 开始。 */
  attempt?: number | null;
  /** provider 请求实际开始时刻；事件日历归属与读端计价统一使用这一时刻。 */
  occurredAt?: string | number | Date;
}

function toCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function toOccurredAt(value: string | number | Date | undefined): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** 写一条 usage 事件；失败只 console.warn，绝不抛（主链优先）。 */
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

  try {
    const client = getDocumentsClient();
    await ensureMigrated();
    await withWriteRetry(() =>
      client.execute({
        sql: `INSERT INTO llm_usage_events
          (id, session_id, run_id, call_site, model_id, key_origin,
           input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
           cache_creation_tokens, cache_accounting_state, usage_state, reason, lane, attempt,
           created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          toOccurredAt(input.occurredAt),
        ],
      }),
    );
  } catch (err) {
    console.warn("[usage] 记录 usage 事件失败（不影响主链）", {
      callSite: input.callSite,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface PricingSliceWindowSpec {
  start: string;
  end: string;
}

export interface PricingSliceEpochSpec {
  effectiveFrom: string;
  peak?: {
    windows: readonly PricingSliceWindowSpec[];
    models: readonly string[];
  };
}

/** db 只认识切片边界，不认识单价。 */
export interface PricingSliceSpec {
  epochs: readonly PricingSliceEpochSpec[];
}

export interface PricingSliceCase {
  sql: string;
  args: Array<string | number>;
}

const MAX_PRICING_EPOCHS = 64;
const MAX_PEAK_WINDOWS_PER_EPOCH = 32;
const MAX_PEAK_MODELS_PER_EPOCH = 128;
const MAX_PRICING_SLICE_PARAMS = 900;
const CLOCK_SQL = "strftime('%H:%M', usage.created_at, '+8 hours')";
const CANONICAL_CREATED_AT_SQL = `(
  usage.created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', usage.created_at) = usage.created_at
  AND substr(usage.created_at, 12, 2) BETWEEN '00' AND '23'
)`;
const PRICING_SLICE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function clockMinute(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : null;
}

function validatePricingSliceSpec(spec: PricingSliceSpec): void {
  if (!Array.isArray(spec.epochs) || spec.epochs.length === 0) {
    throw new Error("pricing slice spec 必须至少包含一个 epoch");
  }
  if (spec.epochs.length > MAX_PRICING_EPOCHS) {
    throw new Error(`pricing slice epoch 数量不得超过 ${MAX_PRICING_EPOCHS}`);
  }
  let previous = "";
  let parameterCount = 0;
  for (const [index, epoch] of spec.epochs.entries()) {
    if (!isCanonicalUsageTimestamp(epoch.effectiveFrom)) {
      throw new Error(`pricing slice epoch[${index}] effectiveFrom 非 canonical ISO`);
    }
    if (index === 0 && epoch.effectiveFrom !== "1970-01-01T00:00:00.000Z") {
      throw new Error("pricing slice epoch[0] 必须从 1970-01-01T00:00:00.000Z 生效");
    }
    if (previous && epoch.effectiveFrom <= previous) {
      throw new Error("pricing slice epochs 必须按 effectiveFrom 严格递增");
    }
    previous = epoch.effectiveFrom;
    parameterCount += 1;
    if (!epoch.peak) continue;
    if (
      !Array.isArray(epoch.peak.windows) ||
      epoch.peak.windows.length === 0 ||
      epoch.peak.windows.length > MAX_PEAK_WINDOWS_PER_EPOCH
    ) {
      throw new Error(`pricing slice peak windows 数量必须为 1..${MAX_PEAK_WINDOWS_PER_EPOCH}`);
    }
    if (
      !Array.isArray(epoch.peak.models) ||
      epoch.peak.models.length === 0 ||
      epoch.peak.models.length > MAX_PEAK_MODELS_PER_EPOCH ||
      epoch.peak.models.some((model: unknown) =>
        typeof model !== "string" || !PRICING_SLICE_MODEL_ID.test(model))
    ) {
      throw new Error(`pricing slice peak models 数量必须为 1..${MAX_PEAK_MODELS_PER_EPOCH}`);
    }
    parameterCount += epoch.peak.models.length + epoch.peak.windows.length * 2;
    for (const window of epoch.peak.windows) {
      const start = clockMinute(window.start);
      const end = clockMinute(window.end);
      if (start === null || end === null || start === end) {
        throw new Error("pricing slice peak window 必须是 start≠end 的 HH:mm");
      }
    }
  }
  if (parameterCount > MAX_PRICING_SLICE_PARAMS) {
    throw new Error(`pricing slice SQL 参数不得超过 ${MAX_PRICING_SLICE_PARAMS}`);
  }
}

/**
 * 唯一切片 CASE builder。SQL 结构与 epoch 下标只来自代码常量；边界时间、模型 ID
 * 全部通过参数绑定，非法 created_at 首分支固定落到 -1 哨兵。
 */
export function buildPricingSliceCase(spec: PricingSliceSpec): PricingSliceCase {
  validatePricingSliceSpec(spec);
  const args: Array<string | number> = [];
  const branches: string[] = [];
  for (let index = spec.epochs.length - 1; index >= 0; index -= 1) {
    const epoch = spec.epochs[index]!;
    args.push(epoch.effectiveFrom);
    let peakSql = "0";
    if (epoch.peak) {
      const modelSql = epoch.peak.models.map(() => "?").join(", ");
      args.push(...epoch.peak.models);
      const windowParts: string[] = [];
      for (const window of epoch.peak.windows) {
        const start = clockMinute(window.start)!;
        const end = clockMinute(window.end)!;
        args.push(window.start, window.end);
        windowParts.push(start < end
          ? `(${CLOCK_SQL} >= ? AND ${CLOCK_SQL} < ?)`
          : `(${CLOCK_SQL} >= ? OR ${CLOCK_SQL} < ?)`);
      }
      peakSql = `(usage.model_id IN (${modelSql}) AND (${windowParts.join(" OR ")}))`;
    }
    branches.push(
      `WHEN usage.created_at >= ? THEN ${index * 2} + CASE WHEN ${peakSql} THEN 1 ELSE 0 END`,
    );
  }
  return {
    sql: `CASE WHEN NOT ${CANONICAL_CREATED_AT_SQL} THEN -1 ${branches.join(" ")} ELSE -1 END`,
    args,
  };
}

export interface UsagePricingSliceRow {
  bucket: string;
  sessionId?: string;
  callSite: string;
  modelId: string;
  pricingSlice: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  billableMissTokens: number;
  cacheCreationTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCacheHitTokens: number;
  estimatedCacheMissTokens: number;
  estimatedBillableMissTokens: number;
  knownCacheHitTokens: number;
  knownCacheTotalTokens: number;
  coldStartMissTokens: number;
  calls: number;
  recordedCalls: number;
  estimatedCalls: number;
  missingCalls: number;
  billingUnknownCalls: number;
  lastAt: string;
}

export interface UsageDayRow {
  bucket: string;
  occurredAt: string;
  sessionId: string;
  documentId: string;
  documentTitle?: string;
  callSite: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  cacheAccountingState: CacheAccountingState;
  usageState: UsageState;
  isColdStart: boolean;
}

/** core 计价后的内部公开聚合形状；server 再映射为 contract。 */
export interface UsageAggRow {
  bucket: string;
  sessionId?: string;
  documentId?: string;
  documentTitle?: string;
  callSite: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCacheHitTokens?: number;
  estimatedCacheMissTokens?: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  coldStartMissTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number | null;
  calls: number;
  recordedCalls: number;
  estimatedCalls?: number;
  missingCalls: number;
  billingUnknownCalls?: number;
  coverageRate: number;
  costCny?: number;
  estimatedCostCny?: number;
  pricedCalls: number;
  unpricedCalls: number;
  estimatedPricedCalls: number;
  estimatedUnpricedCalls: number;
  peakPricedCalls?: number;
  peakPricingMultiplierMin?: number;
  peakPricingMultiplierMax?: number;
  /** 仅供 core 恢复 SQL 聚合前既有排序，server 不向外暴露。 */
  lastAt?: string;
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

function usageDayBucket(value: string, formatter: Intl.DateTimeFormat): string | null {
  if (!isCanonicalUsageTimestamp(value)) return null;
  const parts = formatter.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function usageDayWindowStart(days: number, formatter: Intl.DateTimeFormat): string {
  const now = new Date().toISOString();
  const today = usageDayBucket(now, formatter);
  if (!today) throw new Error("无法计算用量统计日历窗口");
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(
    year!,
    month! - 1,
    day! - Math.max(0, Math.round(days) - 1),
  )).toISOString().slice(0, 10);
}

/**
 * 天视图保持窗口内原始行，由 core 逐行计价后在 JS 聚合。不可解析或非 canonical
 * created_at 无法归入 IANA 日历桶，按既有日历语义跳过。
 */
export async function queryUsageByDay(
  days = 30,
  timeZone = "UTC",
): Promise<UsageDayRow[]> {
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

  return result.rows.flatMap((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const occurredAt = String(row.created_at ?? "");
    const bucket = usageDayBucket(occurredAt, formatter);
    if (!bucket || bucket < firstBucket) return [];
    return [{
      bucket,
      occurredAt,
      sessionId: String(row.session_id ?? ""),
      documentId: String(row.document_id ?? ""),
      ...(row.document_title == null || String(row.document_title) === ""
        ? {}
        : { documentTitle: String(row.document_title) }),
      callSite: String(row.call_site ?? ""),
      modelId: String(row.model_id ?? ""),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheHitTokens: Number(row.cache_hit_tokens ?? 0),
      cacheMissTokens: Number(row.cache_miss_tokens ?? 0),
      cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
      cacheAccountingState: row.cache_accounting_state === "known" ? "known" : "unknown",
      usageState: row.usage_state === "estimated" || row.usage_state === "missing" ||
        row.usage_state === "billing_unknown"
        ? row.usage_state
        : "recorded",
      isColdStart: Number(row.is_cold_start) === 1,
    } satisfies UsageDayRow];
  });
}

const SLICE_AGG_COLUMNS = `
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.input_tokens ELSE 0 END) AS input_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.output_tokens ELSE 0 END) AS output_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN usage.cache_miss_tokens +
    MAX(0, usage.input_tokens - usage.cache_hit_tokens - usage.cache_miss_tokens) ELSE 0 END) AS billable_miss_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN COALESCE(usage.cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.input_tokens ELSE 0 END) AS estimated_input_tokens,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.output_tokens ELSE 0 END) AS estimated_output_tokens,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_hit_tokens ELSE 0 END) AS estimated_cache_hit_tokens,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_miss_tokens ELSE 0 END) AS estimated_cache_miss_tokens,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN usage.cache_miss_tokens +
    MAX(0, usage.input_tokens - usage.cache_hit_tokens - usage.cache_miss_tokens) ELSE 0 END) AS estimated_billable_miss_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known'
    THEN usage.cache_hit_tokens ELSE 0 END) AS known_cache_hit_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded' AND usage.cache_accounting_state = 'known'
    THEN usage.cache_hit_tokens + usage.cache_miss_tokens ELSE 0 END) AS known_cache_total_tokens,
  SUM(CASE WHEN usage.usage_state = 'recorded'
    AND usage.cache_accounting_state = 'known'
    AND usage.created_at = first_cache.first_created_at
    THEN usage.cache_miss_tokens ELSE 0 END) AS cold_start_miss_tokens,
  COUNT(*) AS calls,
  SUM(CASE WHEN usage.usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
  SUM(CASE WHEN usage.usage_state = 'estimated' THEN 1 ELSE 0 END) AS estimated_calls,
  SUM(CASE WHEN usage.usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls,
  SUM(CASE WHEN usage.usage_state = 'billing_unknown' THEN 1 ELSE 0 END) AS billing_unknown_calls`;

function rowToPricingSlice(row: Record<string, unknown>): UsagePricingSliceRow {
  return {
    bucket: String(row.bucket ?? ""),
    ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
    callSite: String(row.call_site ?? ""),
    modelId: String(row.model_id ?? ""),
    pricingSlice: Number(row.pricing_slice ?? -1),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheHitTokens: Number(row.cache_hit_tokens ?? 0),
    cacheMissTokens: Number(row.cache_miss_tokens ?? 0),
    billableMissTokens: Number(row.billable_miss_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    estimatedInputTokens: Number(row.estimated_input_tokens ?? 0),
    estimatedOutputTokens: Number(row.estimated_output_tokens ?? 0),
    estimatedCacheHitTokens: Number(row.estimated_cache_hit_tokens ?? 0),
    estimatedCacheMissTokens: Number(row.estimated_cache_miss_tokens ?? 0),
    estimatedBillableMissTokens: Number(row.estimated_billable_miss_tokens ?? 0),
    knownCacheHitTokens: Number(row.known_cache_hit_tokens ?? 0),
    knownCacheTotalTokens: Number(row.known_cache_total_tokens ?? 0),
    coldStartMissTokens: Number(row.cold_start_miss_tokens ?? 0),
    calls: Number(row.calls ?? 0),
    recordedCalls: Number(row.recorded_calls ?? 0),
    estimatedCalls: Number(row.estimated_calls ?? 0),
    missingCalls: Number(row.missing_calls ?? 0),
    billingUnknownCalls: Number(row.billing_unknown_calls ?? 0),
    lastAt: String(row.last_at ?? ""),
  };
}

/** 会话级 × 模型 × pricing slice 聚合（默认最近 200 个会话桶）。 */
export async function aggregateUsageBySession(
  spec: PricingSliceSpec,
  limit = 200,
): Promise<UsagePricingSliceRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const slice = buildPricingSliceCase(spec);
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
      SELECT usage.session_id AS bucket, usage.session_id, usage.call_site, usage.model_id,
        ${slice.sql} AS pricing_slice,
        ${SLICE_AGG_COLUMNS},
        recent.last_at AS last_at
      FROM llm_usage_events usage
      INNER JOIN recent_sessions recent ON recent.session_id = usage.session_id
      INNER JOIN first_cache_requests first_cache
        ON first_cache.session_id = usage.session_id
        AND first_cache.call_site = usage.call_site
        AND first_cache.lane IS usage.lane
      GROUP BY usage.session_id, usage.call_site, usage.model_id, pricing_slice, recent.last_at
      ORDER BY recent.last_at DESC, usage.session_id, usage.call_site, usage.model_id, pricing_slice`,
    args: [limit, ...slice.args],
  });
  return result.rows.map((row) => rowToPricingSlice(row as unknown as Record<string, unknown>));
}

/** 全局总量 × 模型 × pricing slice。 */
export async function aggregateUsageTotal(
  spec: PricingSliceSpec,
): Promise<UsagePricingSliceRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const slice = buildPricingSliceCase(spec);
  const result = await client.execute({
    sql: `WITH first_cache_requests AS (
        SELECT session_id, call_site, lane, MIN(created_at) AS first_created_at
        FROM llm_usage_events
        GROUP BY session_id, call_site, lane
      )
      SELECT 'total' AS bucket, usage.call_site, usage.model_id,
        ${slice.sql} AS pricing_slice,
        ${SLICE_AGG_COLUMNS},
        MAX(usage.created_at) AS last_at
      FROM llm_usage_events usage
      INNER JOIN first_cache_requests first_cache
        ON first_cache.session_id = usage.session_id
        AND first_cache.call_site = usage.call_site
        AND first_cache.lane IS usage.lane
      GROUP BY usage.call_site, usage.model_id, pricing_slice
      ORDER BY usage.call_site, usage.model_id, pricing_slice`,
    args: slice.args,
  });
  return result.rows.map((row) => rowToPricingSlice(row as unknown as Record<string, unknown>));
}

/** 单会话最近一次 agent 调用的 usage（F6 上下文 debug 用）。 */
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
