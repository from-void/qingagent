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
  /** recorded=provider 返回 usage；missing=真实请求发生但无法取得 usage。 */
  usageState?: "recorded" | "missing";
  reason?: string | null;
  /** 并发赛马 lane；非赛马调用可为空。 */
  lane?: number | null;
  /** 同一 lane/call site 内的真实 provider 请求序号，从 1 开始。 */
  attempt?: number | null;
}

function toCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 写一条 usage 事件;失败只 console.warn,绝不抛(主链优先)。
 *  正常事件 input/output 全 0 时跳过；missing 事件即使全零也保留，以统计覆盖率。 */
export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  const usageState = input.usageState ?? "recorded";
  const cacheAccountingState = input.cacheAccountingState ?? (
    input.cacheHitTokens !== undefined && input.cacheMissTokens !== undefined ? "known" : "unknown"
  );
  if (
    usageState !== "missing" &&
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
           cache_creation_tokens, cache_accounting_state, usage_state, reason, lane, attempt, created_at)
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
          new Date().toISOString(),
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
  callSite: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheCreationTokens: number;
  /** hit/(hit+miss)；provider 未给缓存拆分时为 null，而不是 0。 */
  cacheHitRate: number | null;
  calls: number;
  recordedCalls: number;
  missingCalls: number;
  /** 有 usage 的请求占全部真实请求比例；missing 计入分母但不计成本。 */
  coverageRate: number;
}

function rowToAgg(row: Record<string, unknown>): UsageAggRow {
  return {
    bucket: String(row.bucket ?? ""),
    callSite: String(row.call_site ?? ""),
    modelId: String(row.model_id ?? ""),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheHitTokens: Number(row.cache_hit_tokens ?? 0),
    cacheMissTokens: Number(row.cache_miss_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    cacheHitRate: row.cache_hit_rate == null ? null : Number(row.cache_hit_rate),
    calls: Number(row.calls ?? 0),
    recordedCalls: Number(row.recorded_calls ?? 0),
    missingCalls: Number(row.missing_calls ?? 0),
    coverageRate: Number(row.calls ?? 0) > 0
      ? Number(row.recorded_calls ?? 0) / Number(row.calls)
      : 0,
  };
}

/** 天级 × 模型聚合(默认最近 30 天)。 */
export async function aggregateUsageByDay(days = 30): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = await client.execute({
    sql: `SELECT date(created_at) AS bucket, call_site, model_id,
        SUM(CASE WHEN usage_state = 'recorded' THEN input_tokens ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN COALESCE(cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
        1.0 * SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens ELSE 0 END) /
          NULLIF(SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens + cache_miss_tokens ELSE 0 END), 0) AS cache_hit_rate,
        COUNT(*) AS calls,
        SUM(CASE WHEN usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
        SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls
      FROM llm_usage_events WHERE created_at >= ?
      GROUP BY date(created_at), call_site, model_id
      ORDER BY bucket DESC, call_site, model_id`,
    args: [since],
  });
  return result.rows.map((r) => rowToAgg(r as unknown as Record<string, unknown>));
}

/** 会话级 × 模型聚合(默认最近 200 个会话桶)。 */
export async function aggregateUsageBySession(limit = 200): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute({
    sql: `SELECT session_id AS bucket, call_site, model_id,
        SUM(CASE WHEN usage_state = 'recorded' THEN input_tokens ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN COALESCE(cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
        1.0 * SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens ELSE 0 END) /
          NULLIF(SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens + cache_miss_tokens ELSE 0 END), 0) AS cache_hit_rate,
        COUNT(*) AS calls,
        SUM(CASE WHEN usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
        SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls,
        MAX(created_at) AS last_at
      FROM llm_usage_events
      GROUP BY session_id, call_site, model_id
      ORDER BY last_at DESC
      LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((r) => rowToAgg(r as unknown as Record<string, unknown>));
}

/** 全局总量 × 模型。 */
export async function aggregateUsageTotal(): Promise<UsageAggRow[]> {
  const client = getDocumentsClient();
  await ensureMigrated();
  const result = await client.execute(
    `SELECT 'total' AS bucket, call_site, model_id,
        SUM(CASE WHEN usage_state = 'recorded' THEN input_tokens ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
        SUM(CASE WHEN usage_state = 'recorded' THEN COALESCE(cache_creation_tokens, 0) ELSE 0 END) AS cache_creation_tokens,
        1.0 * SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens ELSE 0 END) /
          NULLIF(SUM(CASE WHEN usage_state = 'recorded' AND cache_accounting_state = 'known' THEN cache_hit_tokens + cache_miss_tokens ELSE 0 END), 0) AS cache_hit_rate,
        COUNT(*) AS calls,
        SUM(CASE WHEN usage_state = 'recorded' THEN 1 ELSE 0 END) AS recorded_calls,
        SUM(CASE WHEN usage_state = 'missing' THEN 1 ELSE 0 END) AS missing_calls
      FROM llm_usage_events GROUP BY call_site, model_id
      ORDER BY call_site, model_id`,
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
