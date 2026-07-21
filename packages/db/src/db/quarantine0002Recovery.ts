import { commitTransaction, withTransaction } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import {
  restoreQuarantinedDocumentFamilies0002,
  type Quarantine0002RecoveryReport,
} from "./migrations/0023_restore_quarantine_0002.js";

/** F13 运维恢复命令入口：先升级 schema，再在单事务内幂等重放 0002 隔离恢复。 */
export async function runQuarantine0002Recovery(): Promise<Quarantine0002RecoveryReport> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const report = await restoreQuarantinedDocumentFamilies0002(client);
    return commitTransaction(report);
  });
}
