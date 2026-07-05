import type { Migration } from "../migrations.js";
import { migration0001Baseline } from "./0001_baseline.js";

// 迁移注册表:id 必须从 1 严格连续递增(runner 启动即断言)。
// 新增迁移追加到数组尾部,写确定性 DDL(禁用 baseline 的 catch-正则幂等技),
// 并配 fixture 矩阵测试。历史迁移一经发布不可修改。
export const MIGRATIONS: readonly Migration[] = [migration0001Baseline];
