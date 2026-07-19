export type DocumentWriteOperation =
  | "document.save"
  | "document.saveMany"
  | "document.commit"
  | "document.derivative.create"
  | "documentDraft.savePending"
  | "documentDraft.saveCandidate"
  | "documentSuggestion.insertAnnotations"
  | "documentSuggestion.replaceAnnotations"
  | "documentSuggestion.upsert";

export interface DocumentWriteTarget {
  docId: string;
  threadId?: string | null;
  operation: DocumentWriteOperation;
}

export type DocumentWriteGuard = (target: DocumentWriteTarget) => void;

export class DocumentWriteBlockedError extends Error {
  readonly code = "DOCUMENT_WRITE_BLOCKED";

  constructor(readonly target: DocumentWriteTarget) {
    super(`Document write blocked after session deletion: ${target.operation}`);
    this.name = "DocumentWriteBlockedError";
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
