import type { BatchDeleteTracesArgs } from "@mastra/core/storage";

export const DEFAULT_OBSERVABILITY_MAX_TRACES = 50;
export const OBSERVABILITY_RETENTION_INTERVAL_MS = 120_000;

export type ObservabilityRetentionLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
};

// DuckDBStore.getConnection() 返回的是 @duckdb/node-api 连接;这里只用最小结构类型,
// 避免在 server 包直接依赖驱动类型。
export type RetentionConnection = {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
};

// ⚠️ 不用 listTracesLight —— DuckDBStore 运行时直接 throw
// "This storage provider does not support listing lightweight traces"(d.ts 声明了但实现是不支持的)。
// 改用 store 自己的 getConnection 跑原生 SQL 取 traceId(in-process,同实例,不撞单写锁),
// 删除仍走框架的 batchDeleteTraces(级联删 span/log/metric)。
export type ObservabilityTraceRetentionStore = {
  getConnection(): Promise<RetentionConnection>;
  closeConnection(connection: RetentionConnection): void;
  batchDeleteTraces(args: BatchDeleteTracesArgs): Promise<void>;
};

export type ObservabilityTraceRetentionResult = {
  total: number;
  deleted: number;
  remaining: number;
  traceIdsDeleted: string[];
};

export function readObservabilityMaxTraces(
  env: NodeJS.ProcessEnv = process.env,
  logger?: Pick<ObservabilityRetentionLogger, "warn">,
): number {
  const raw = env.OBSERVABILITY_MAX_TRACES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_OBSERVABILITY_MAX_TRACES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger?.warn("invalid OBSERVABILITY_MAX_TRACES; using default", {
      value: raw,
      defaultValue: DEFAULT_OBSERVABILITY_MAX_TRACES,
    });
    return DEFAULT_OBSERVABILITY_MAX_TRACES;
  }

  return parsed;
}

export async function enforceObservabilityTraceRetention(options: {
  store: ObservabilityTraceRetentionStore;
  maxTraces: number;
  logger: ObservabilityRetentionLogger;
}): Promise<ObservabilityTraceRetentionResult> {
  const maxTraces = Math.max(0, Math.floor(options.maxTraces));
  const orderedTraceIds = await listAllTraceIdsNewestFirst(options.store);
  const traceIdsDeleted = orderedTraceIds.slice(maxTraces);

  if (traceIdsDeleted.length === 0) {
    options.logger.info("observability trace retention skipped", {
      total: orderedTraceIds.length,
      deleted: 0,
      remaining: orderedTraceIds.length,
      maxTraces,
    });
    return {
      total: orderedTraceIds.length,
      deleted: 0,
      remaining: orderedTraceIds.length,
      traceIdsDeleted: [],
    };
  }

  await options.store.batchDeleteTraces({ traceIds: traceIdsDeleted });
  const remaining = orderedTraceIds.length - traceIdsDeleted.length;

  options.logger.info("observability trace retention completed", {
    total: orderedTraceIds.length,
    deleted: traceIdsDeleted.length,
    remaining,
    maxTraces,
  });

  return {
    total: orderedTraceIds.length,
    deleted: traceIdsDeleted.length,
    remaining,
    traceIdsDeleted,
  };
}

// 直接对 span_events 跑 SQL,按每个 trace 的最新 span 时间倒序拿全部 traceId。
async function listAllTraceIdsNewestFirst(
  store: ObservabilityTraceRetentionStore,
): Promise<string[]> {
  const connection = await store.getConnection();
  try {
    const reader = await connection.runAndReadAll(
      "SELECT traceId FROM span_events WHERE traceId IS NOT NULL " +
        "GROUP BY traceId ORDER BY max(timestamp) DESC",
    );
    return reader
      .getRowObjects()
      .map((row) => row.traceId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } finally {
    store.closeConnection(connection);
  }
}
