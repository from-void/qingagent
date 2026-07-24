import { commitTransaction, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import {
  restoreQuarantinedDocumentFamilies0002,
  type Quarantine0002RecoveryReport,
} from "./migrations/0023_restore_quarantine_0002.js";
import {
  migration0024DocumentRestoreLineageAndOpsIndex,
} from "./migrations/0024_document_restore_lineage_and_ops_index.js";
import {
  migration0025QuarantineLineageAndPmCompat,
} from "./migrations/0025_quarantine_lineage_and_pm_compat.js";

/** F13 运维恢复命令入口：先升级 schema，再在单事务内幂等重放 0002 隔离恢复。 */
export async function runQuarantine0002Recovery(): Promise<Quarantine0002RecoveryReport> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const report = await restoreQuarantinedDocumentFamilies0002(client);
    // 历史 0023 必须保持不可变；运维手工重放后立刻重跑 0025 补救，
    // 防止再次把异 docId 子表暴露回活跃家族。
    await migration0024DocumentRestoreLineageAndOpsIndex.up(client);
    await migration0025QuarantineLineageAndPmCompat.up(client);
    return commitTransaction(report);
  });
}
