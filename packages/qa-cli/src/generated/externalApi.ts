// 生成物勿手改：由 @qingagent/contract-ts 生成。
// 源：packages/contract-ts/src/ExternalApi.ts（contract-ts@0.1.0）

/**
 * External API v1 的公开契约源。
 *
 * 这里的 `version` 是运行中青简应用/qa-cli 的产品版本，不是 API schema 版本。
 * `/api/v1/external` 的 `v1` 才是兼容边界：同一 major 路径内只能做向后兼容变更；
 * 破坏性响应变更必须迁移到新的 API major，并同步发布能够识别该 major 的 qa-cli。
 */

import type { BridgeFrame } from "@qingagent/contract-ts";
import type { DocDiffReady } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/contract-ts";

export type ExternalClient = "claudecode" | "codex" | "agent";

export type ExternalErrorCode =
  | "AUTH_FAILED"
  | "AGENT_BUSY"
  | "REVIEW_PENDING"
  | "CONFLICT"
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

/** GET /sessions 的可选分页参数；不传时保留默认首页响应。 */
export interface ExternalSessionsListQuery {
  /** 单页数量，服务端当前接受 1–500。 */
  limit?: number;
  /** 普通稳定排序分页的零基偏移。与 cursor 二选一。 */
  offset?: number;
  /** 快照游标；首请求传 `start`，后续传响应中的 nextCursor。 */
  cursor?: string;
}

export interface ExternalSessionsListResponse {
  sessions: ExternalSession[];
  total: number;
  hasMore: boolean;
  nextCursor?: string | null;
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
  qingml?: string;
  title: string | null;
}

/** GET /sessions/:id/doc?format=pm：可直接作为 updateDoc 基线的权威 PM 快照。 */
export interface ExternalPmDocReadResponse {
  sessionId: string;
  docVersion: number;
  contentHash: string;
  state: ExternalDocumentState;
  agentBusy: boolean;
  title: string | null;
  ts: string;
  pmDoc: PmDoc | null;
}

/** PUT /sessions/:id/doc：用户直接保存，不进入 proposal/review 语义。 */
export interface ExternalDocReplaceRequest {
  expectedDocumentSnapshot: number;
  baseContentHash: string;
  clientMutationId: string;
  doc: PmDoc;
}

export type ExternalDocReplaceResponse =
  | {
      ok: true;
      clientMutationId: string;
      docVersion: number;
      contentHash: string;
      ts: string;
    }
  | {
      ok: false;
      clientMutationId: string;
      code: "VERSION_CONFLICT";
      conflict: { expected: number; actual: number };
      actualContentHash: string;
    };

export interface ExternalChatMessage {
  id: string;
  role: { kind: "user" | "agent" | "system" };
  ts: string;
  text: string;
}

export interface ExternalChatLogResponse { sessionId: string; messages: ExternalChatMessage[] }
export interface ExternalChatSendRequest { text: string }
export interface ExternalChatSendResponse { queued: true; note: string }

/**
 * POST /sessions/:id/assets 的 JSON 请求体。multipart/form-data 形态使用单一 `file` 字段。
 * `base64` 是纯 RFC 4648 内容，不含 data URL 前缀；mimeType 缺省时按常见图片扩展名推断。
 */
export interface ExternalAssetUploadJsonRequest {
  filename: string;
  mimeType?: string;
  base64: string;
}

/**
 * POST /sessions/:id/assets：字段与内部 upload 响应一致，并补充可直接写入 PmDoc image.attrs.src 的 src。
 * GET /sessions/:id/assets/:ref 中的 ref 即 fileId；外部宿主渲染 src 时可据此代理带 Bearer 的读取。
 */
export interface ExternalAssetUploadResponse {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  src: string;
}

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
  | { kind: "qingmlDraft"; qingml: string }
  | { kind: "setTitle"; title: string }
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

export interface ExternalValidationDiagnostic {
  failureKind: string;
  warningKinds: string[];
  tagSkeleton: string;
  errorLocations: Array<{
    kind: string;
    startOffset?: number;
    endOffset?: number;
    path?: Array<string | number>;
  }>;
}

export type ExternalProposalErrorResponse =
  | (ExternalErrorResponse & { seq?: number; diagnostic?: ExternalValidationDiagnostic })
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

/**
 * GET /sessions/:id/review?format=render-model。
 * 渲染字段直接复用 DocDiffReady，避免 summary/detail DTO 丢失 PM steps、marks 与 textHash。
 */
export type ExternalReviewRenderModelResponse = {
  sessionId: string;
  docVersion: number;
  state: ExternalDocumentState;
  agentBusy: boolean;
} & DocDiffReady;

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
}

export interface ExternalAnnotationIgnoreResponse {
  status: "ignored";
  annotationIds: string[];
  remainingAnnotationCount: number;
  seq: number | null;
}

export type ExternalReviewType =
  | "sensitive" | "deai" | "source" | "consistency"
  | "privacy" | "format" | "role" | "custom";

export interface ExternalReviewTemplate {
  id: string;
  type: ExternalReviewType;
  name: string;
  prompt: string;
  builtin: boolean;
  selected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalReviewTemplatesResponse { templates: ExternalReviewTemplate[] }
export interface ExternalReviewTemplateResponse { template: ExternalReviewTemplate }
export interface ExternalReviewTemplateCreateRequest {
  type: ExternalReviewType;
  name: string;
  prompt: string;
}
export interface ExternalReviewTemplateUpdateRequest {
  name?: string;
  prompt?: string;
  expectedUpdatedAt: string;
}
export interface ExternalReviewTemplateDeleteResponse { deleted: true; id: string }
export interface ExternalReviewTemplateSelectResponse {
  selected: true;
  id: string;
  type: ExternalReviewType;
}
export interface ExternalReviewSupplementResponse {
  sessionId: string;
  type: ExternalReviewType;
  supplement: string;
}
export interface ExternalReviewRunRequest {
  type: ExternalReviewType;
  templateId?: string;
  supplement?: string;
}
export interface ExternalReviewRunResponse extends ExternalChatSendResponse {
  type: ExternalReviewType;
  templateId: string;
  /** 本次审查命令入队前的事件游标，等待方从下一帧开始回放，避免漏掉快速启动事件。 */
  afterSeq: number;
}

export type ExternalSkillSource =
  | "builtin"
  | "installed"
  | "external-claude"
  | "external-codex"
  | "external-shared";
export interface ExternalSkill {
  name: string;
  description: string;
  label?: string;
  summary?: string;
  icon?: string;
  source: ExternalSkillSource;
  userInvocable: boolean;
  placeholder?: string;
  config?: unknown;
  tools?: string[];
  enabled: boolean;
  connectorId?: string;
  body?: string;
  children: ExternalSkill[];
}
export interface ExternalSkillsResponse { skills: ExternalSkill[] }
export interface ExternalSkillResponse { skill: ExternalSkill }
export interface ExternalSkillFile { path: string; content: string }
export type ExternalSkillInstallRequest =
  | { skillMd: string; files?: never }
  | { files: ExternalSkillFile[]; skillMd?: never };
export interface ExternalSkillMutationResponse {
  name: string;
  installed?: true;
  updated?: true;
  deleted?: true;
  enabled?: boolean;
}

export interface ExternalEventsMeta { epoch: number; minSeq: number; nextSeq: number; gap: boolean }

export type ExternalBridgeFrameKind =
  | "restoreReset" | "sessionMeta" | "chatMessageAdded" | "chatMessageAppended"
  | "toolCallUpdated" | "documentSnapshotWritten" | "docGenerationEvent" | "docCommitted"
  | "docDiffReady" | "docWriteResult" | "docStateChanged" | "todosChanged"
  | "resourceUpserted" | "resourceUpdated" | "resourceRemoved" | "folderSourcesChanged"
  | "folderSourceOperationResult" | "annotationGroupsReady" | "stream";

/** external SSE 的公开判别 union；kind 收窄后 data 自动得到对应 BridgeFrame 的完整类型。 */
export type ExternalBridgeFrame = { seq: number } & Extract<
  BridgeFrame,
  { kind: ExternalBridgeFrameKind }
>;

export type ExternalSuccessResponse =
  | ExternalHealthResponse | ExternalSessionsListResponse | ExternalSessionCreateResponse
  | ExternalDocReadResponse | ExternalPmDocReadResponse | ExternalDocReplaceResponse
  | ExternalChatLogResponse | ExternalChatSendResponse
  | ExternalAssetUploadResponse
  | ExternalFilesListResponse | ExternalFileTextResponse | ExternalProposalResponse
  | ExternalReviewListResponse | ExternalReviewRenderModelResponse
  | ExternalReviewPatchResponse | ExternalAnnotationResponse
  | ExternalReviewVerdictResponse | ExternalReviewCommitResponse
  | ExternalAnnotationIgnoreResponse
  | ExternalReviewTemplatesResponse | ExternalReviewTemplateResponse
  | ExternalReviewTemplateDeleteResponse | ExternalReviewTemplateSelectResponse
  | ExternalReviewSupplementResponse | ExternalReviewRunResponse
  | ExternalSkillsResponse | ExternalSkillResponse | ExternalSkillMutationResponse;
