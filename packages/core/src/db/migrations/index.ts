import type { Migration } from "../migrations.js";
import { migration0001Baseline } from "./0001_baseline.js";
import { migration0002OrphanCleanup } from "./0002_orphan_cleanup.js";
import { migration0003UsageRequestObservability } from "./0003_usage_request_observability.js";
import { migration0004UsageCacheAccountingState } from "./0004_usage_cache_accounting_state.js";

// 迁移注册表:id 必须从 1 严格连续递增(runner 启动即断言)。
// 新增迁移追加到数组尾部,写确定性 DDL(禁用 baseline 的 catch-正则幂等技),
// 并配 fixture 矩阵测试。历史迁移一经发布不可修改。
export const MIGRATIONS: readonly Migration[] = [
  migration0001Baseline,
  migration0002OrphanCleanup,
  migration0003UsageRequestObservability,
  migration0004UsageCacheAccountingState,
];
