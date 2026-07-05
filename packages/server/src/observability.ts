import { SpanType } from "@mastra/core/observability";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import {
  Observability,
  MastraStorageExporter,
} from "@mastra/observability";
import {
  configureObservability,
  mastra,
} from "@qingagent/core";
import {
  OBSERVABILITY_RETENTION_INTERVAL_MS,
  enforceObservabilityTraceRetention,
  readObservabilityMaxTraces,
  type ObservabilityTraceRetentionStore,
  type RetentionConnection,
} from "./observabilityRetention.js";

/**
 * Bootstrap observability for the server process.
 *
 * This wires DuckDB-backed composite storage and the Observability
 * entrypoint into the shared Mastra instance exported from @qingagent/core.
 * The desktop app never imports this module, so @mastra/duckdb native
 * bindings stay out of the Electron bundle.
 */

const libsqlStore = new LibSQLStore({
  id: "qingagent-storage",
  url: process.env.DATABASE_URL ?? "file:./qingagent.db",
});

const duckdbStore = new DuckDBStore({
  id: "qingagent-observability",
  // 默认 ./observability.duckdb；允许 env 覆盖，便于临时实例（崩溃验证等）用独立
  // DB 文件，避免与正在跑的主实例抢 DuckDB 单写锁。
  path: process.env.OBSERVABILITY_DUCKDB_PATH ?? "./observability.duckdb",
});

const compositeStorage = new MastraCompositeStore({
  id: "qingagent-composite",
  default: libsqlStore,
  domains: {
    observability: duckdbStore.observability,
  },
});

const observability = new Observability({
  configs: {
    local: {
      serviceName: "qingagent",
      exporters: [new MastraStorageExporter()],
      logging: { enabled: true, level: "info" },
      // 只丢逐 token 的流式 chunk；MODEL_STEP 带每步模型原始响应和 tool_calls，必须保留。
      excludeSpanTypes: [SpanType.MODEL_CHUNK],
    },
  },
  sensitiveDataFilter: true,
});

configureObservability({
  storage: compositeStorage,
  observability,
});

const logger = mastra.getLogger();

const observabilityMaxTraces = readObservabilityMaxTraces(process.env, logger);

// 运行时实测(introspect)的真实挂载点:getConnection/closeConnection 在底层连接器
// duckdbStore.db 上(不在 facade/observability),batchDeleteTraces 在 observability 域上。
// 这些字段不在 server 包暴露的类型里,用结构化 cast 适配。
const duckStoreDb = (duckdbStore as unknown as {
  db: {
    getConnection(): Promise<RetentionConnection>;
    closeConnection(connection: RetentionConnection): void;
  };
}).db;

const retentionStore: ObservabilityTraceRetentionStore = {
  getConnection: () => duckStoreDb.getConnection(),
  closeConnection: (connection) => duckStoreDb.closeConnection(connection),
  batchDeleteTraces: (args) => duckdbStore.observability.batchDeleteTraces(args),
};

function runObservabilityTraceRetention(): void {
  void enforceObservabilityTraceRetention({
    store: retentionStore,
    maxTraces: observabilityMaxTraces,
    logger,
  }).catch((err) => {
    logger.warn("observability trace retention failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

runObservabilityTraceRetention();

const observabilityRetentionInterval = setInterval(
  runObservabilityTraceRetention,
  OBSERVABILITY_RETENTION_INTERVAL_MS,
);
observabilityRetentionInterval.unref?.();

process.once("exit", () => {
  clearInterval(observabilityRetentionInterval);
});
