/**
 * External API v1 的公开契约源。
 *
 * 这里的 `version` 是运行中青简应用/qa-cli 的产品版本，不是 API schema 版本。
 * `/api/v1/external` 的 `v1` 才是兼容边界：同一 major 路径内只能做向后兼容变更；
 * 破坏性响应变更必须迁移到新的 API major，并同步发布能够识别该 major 的 qa-cli。
 */

export type ExternalClient = "claudecode" | "codex" | "agent";

export type ExternalErrorCode =
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "VERSION_CONFLICT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "MATERIAL_NOT_FOUND"
  | "RATE_LIMITED";

export interface ExternalErrorResponse {
  error: string;
  code: ExternalErrorCode;
  nextStep: string;
}

export interface ExternalHealthResponse {
  ok: true;
  version: string;
  pid: number;
  startedAt: string;
}

export type ExternalDocumentState = "empty" | "editing" | "pendingReview";

export interface ExternalSession {
  id: string;
  title: string;
  state: ExternalDocumentState;
  updatedAt: string;
}

export interface ExternalSessionsListResponse {
  sessions: ExternalSession[];
  total: number;
  hasMore: boolean;
}
export interface ExternalSessionCreateRequest {}
export interface ExternalSessionCreateResponse { sessionId: string; seq: number | null }

export interface ExternalDocReadResponse {
  sessionId: string;
  docVersion: number;
  state: ExternalDocumentState;
  agentBusy: boolean;
  markdown: string;
  markdownWithLineNumbers?: string;
}

export interface ExternalChatMessage {
  id: string;
  role: { kind: "user" | "agent" | "system" };
  ts: string;
  text: string;
}

export interface ExternalChatLogResponse { sessionId: string; messages: ExternalChatMessage[] }
export interface ExternalChatSendRequest { text: string }
export interface ExternalChatSendResponse { queued: true; note: string }

export interface ExternalMaterial {
  id: string;
  filename: string;
  mime: string;
  summary: string;
  wordCount: number;
  byteLen: number;
  parseState: string;
  sourceUrl: string | null;
  createdAt: string;
}

export interface ExternalFolderSource {
  id: string;
  displayName: string;
  provider: "desktop-local" | "browser-fs-access";
  status: "connected" | "offline" | "missing" | "permission_required" | "error";
}

export interface ExternalFilesListResponse {
  sessionId: string;
  materials: ExternalMaterial[];
  folderSources: ExternalFolderSource[];
}

export interface ExternalFileTextResponse {
  id: string;
  filename: string;
  mime: string;
  text: string;
  byteLen: number;
  truncated: boolean;
}

export type ExternalProposeOp =
  | { kind: "fullDraft"; markdown: string }
  | { kind: "strReplace"; old: string; new: string; nth?: number }
  | { kind: "insertAfterLine"; line: number; markdown: string }
  | { kind: "appendSection"; markdown: string };

export interface ExternalProposalRequest {
  expectedDocVersion: number;
  clientMutationId?: string;
  ops: ExternalProposeOp[];
}

export type ExternalProposalResponse =
  | { status: "review"; patchIds: string[]; count: number; seq?: number }
  | { status: "committed"; docVersion: number; seq?: number };

export type ExternalProposalErrorResponse =
  | (ExternalErrorResponse & { seq?: number })
  | { code: "VERSION_CONFLICT"; expected: number; actual: number; nextStep: string; seq?: number };

export type ExternalReviewPatchStatus =
  | "reviewing"
  | "accepted"
  | "rejected"
  | "committed"
  | "conflict"
  | "ignored";

export interface ExternalReviewConflict {
  kind: string;
  message: string;
  suggestionId?: string;
  blockId?: string;
  currentVersion?: number;
}

export interface ExternalReviewPatchSummary {
  id: string;
  reviewBatchId: string;
  groupMode: "atomic" | "independent" | null;
  status: ExternalReviewPatchStatus;
  baseVersion: number;
  summary: string;
  beforeText: string;
  afterText: string;
  conflict: ExternalReviewConflict | null;
}

export interface ExternalReviewAnchor {
  blockId: string;
  pmFrom: number;
  pmTo: number;
  quote: string;
  prefix?: string;
  suffix?: string;
}

export interface ExternalReviewDiff {
  op: "insert" | "delete" | "replace" | "markAdd" | "markRemove";
  blockPath: number[];
  summary: string;
  beforeText: string;
  afterText: string;
  anchor: {
    blockId?: string;
    quoteBefore?: string;
    quoteAfter?: string;
    pmFrom?: number;
    pmTo?: number;
    anchorKind?: "range" | "position";
    gravity?: "before" | "after";
  };
}

export interface ExternalReviewPatchDetail extends ExternalReviewPatchSummary {
  anchor: ExternalReviewAnchor;
  diff: ExternalReviewDiff | null;
}

export interface ExternalAnnotation {
  id: string;
  summary: string;
  note: string;
  origin: string;
  suggestion?: string;
  severity?: "error" | "warn" | "info";
  status: "reviewing" | "accepted" | "ignored";
  anchors: ExternalReviewAnchor[];
}

export interface ExternalReviewListResponse {
  sessionId: string;
  docVersion: number;
  state: ExternalDocumentState;
  agentBusy: boolean;
  patches: ExternalReviewPatchSummary[];
  annotations: ExternalAnnotation[];
}

export interface ExternalReviewPatchResponse {
  sessionId: string;
  patch: ExternalReviewPatchDetail;
}

export interface ExternalAnnotationResponse {
  sessionId: string;
  annotation: ExternalAnnotation;
}

export interface ExternalReviewVerdictRequest {
  expectedDocVersion: number;
  patchId: string;
  verdict: "accepted" | "rejected";
}

export interface ExternalReviewVerdictResponse {
  status: "marked";
  docVersion: number;
  patchIds: string[];
  verdict: "accepted" | "rejected";
  reviewingCount: number;
  seq: number | null;
}

export interface ExternalReviewCommitRequest {
  expectedDocVersion: number;
  action: "commit" | "accept_all" | "reject_all";
}

export interface ExternalReviewOutcomeHunk {
  verdict: "accepted" | "rejected";
  blockSummary: string;
  beforeText: string;
  afterText: string;
}

export interface ExternalReviewOutcome {
  acceptedCount: number;
  rejectedCount: number;
  hunks: ExternalReviewOutcomeHunk[];
}

export interface ExternalReviewCommitResponse {
  status: "reviewed";
  docVersion: number;
  acceptedCount: number;
  rejectedCount: number;
  remainingCount: number;
  outcomeQueued: boolean;
  outcome: ExternalReviewOutcome;
  seq: number | null;
}

export interface ExternalAnnotationIgnoreRequest {
  expectedDocVersion: number;
  annotationIds: string[];
  rememberDismissal?: boolean;
}

export interface ExternalAnnotationIgnoreResponse {
  status: "ignored";
  annotationIds: string[];
  remainingAnnotationCount: number;
  seq: number | null;
}

export interface ExternalEventsMeta { epoch: number; minSeq: number; nextSeq: number; gap: boolean }

/** qa-cli 消费的 BridgeFrame 子集只依赖公开 envelope；data 由 kind 对应的 v1 wire 契约承载。 */
export interface ExternalBridgeFrame {
  seq: number;
  kind:
    | "restoreReset" | "sessionMeta" | "chatMessageAdded" | "chatMessageAppended"
    | "toolCallUpdated" | "documentSnapshotWritten" | "docGenerationEvent" | "docCommitted"
    | "docDiffReady" | "docWriteResult" | "docStateChanged" | "todosChanged"
    | "resourceUpserted" | "resourceUpdated" | "resourceRemoved" | "folderSourcesChanged"
    | "folderSourceOperationResult" | "annotationGroupsReady" | "stream";
  data: unknown;
}

export type ExternalSuccessResponse =
  | ExternalHealthResponse | ExternalSessionsListResponse | ExternalSessionCreateResponse
  | ExternalDocReadResponse | ExternalChatLogResponse | ExternalChatSendResponse
  | ExternalFilesListResponse | ExternalFileTextResponse | ExternalProposalResponse
  | ExternalReviewListResponse | ExternalReviewPatchResponse | ExternalAnnotationResponse
  | ExternalReviewVerdictResponse | ExternalReviewCommitResponse
  | ExternalAnnotationIgnoreResponse;
