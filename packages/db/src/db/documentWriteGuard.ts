import type { Client } from "@libsql/client";

export type DocumentWriteOperation =
  | "document.save"
  | "document.saveMany"
  | "document.commit"
  | "document.derivative.create"
  | "documentDraft.savePending"
  | "documentDraft.saveCandidate"
  | "documentDraft.markConflict"
  | "documentDraft.clear"
  | "documentSuggestion.insertAnnotations"
  | "documentSuggestion.replaceAnnotations"
  | "documentSuggestion.ignoreAnnotations"
  | "documentSuggestion.persistMappedAnnotations"
  | "documentSuggestion.upsert"
  | "documentSuggestion.updateStatus"
  | "documentSuggestion.ignoreRebased";

export interface DocumentWriteTarget {
  docId: string;
  threadId?: string | null;
  operation: DocumentWriteOperation;
}

export type DocumentWriteGuard = (target: DocumentWriteTarget) => void;

export interface DocumentRecoveryWriteBlock {
  sourceDocId: string;
  sourceThreadId: string;
  versionId: string;
}

export class DocumentWriteBlockedError extends Error {
  readonly code = "DOCUMENT_WRITE_BLOCKED";

  constructor(readonly target: DocumentWriteTarget) {
    super(`Document write blocked after session deletion: ${target.operation}`);
    this.name = "DocumentWriteBlockedError";
  }
}

export class DocumentRecoveryRequiredError extends Error {
  readonly code = "DOCUMENT_RECOVERY_REQUIRED";

  constructor(
    readonly target: DocumentWriteTarget,
    readonly evidence: {
      sourceDocId: string;
      sourceThreadId: string;
      versionId: string;
    },
  ) {
    super(
      `文档 ${target.docId} 已阻断写入：检测到 0023 将异源隔离快照覆盖到当前正文。`
      + ` 无法安全猜测原正文，请按 quarantine-0002-recovery-guide 从运行 0023`
      + ` 前的数据库备份恢复并核验该文档，再清除恢复阻断。`,
    );
    this.name = "DocumentRecoveryRequiredError";
  }
}

let documentWriteGuard: DocumentWriteGuard | null = null;

/** 由上层生命周期模块注入，DB 包不反向依赖 core。 */
export function setDocumentWriteGuard(guard: DocumentWriteGuard | null): void {
  documentWriteGuard = guard;
}

/** 必须在写重试闭包内、紧贴 SQL 执行前调用。 */
export function assertDocumentWriteAllowed(target: DocumentWriteTarget): void {
  documentWriteGuard?.(target);
}

/** 0025 的持久化 fail-closed 门；必须在写事务内、SQL 落库前调用。 */
export async function getDocumentRecoveryWriteBlock(
  client: Client,
  docId: string,
): Promise<DocumentRecoveryWriteBlock | null> {
  const result = await client.execute({
    sql: `SELECT source_doc_id, source_thread_id, version_id
      FROM document_write_blocks
      WHERE doc_id = ? AND reason = 'quarantine_0002_foreign_snapshot'
      LIMIT 1`,
    args: [docId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    sourceDocId: String(row.source_doc_id),
    sourceThreadId: String(row.source_thread_id),
    versionId: String(row.version_id),
  };
}

/** 0025 的持久化 fail-closed 门；必须在写事务内、SQL 落库前调用。 */
export async function assertDocumentWriteAllowedPersisted(
  client: Client,
  target: DocumentWriteTarget,
): Promise<void> {
  const evidence = await getDocumentRecoveryWriteBlock(client, target.docId);
  if (!evidence) return;
  throw new DocumentRecoveryRequiredError(target, evidence);
}
