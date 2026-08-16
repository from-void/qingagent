import type { ChatMessage } from "./ChatMessage";
import type { DerivativeItem, StyleTemplateItem } from "./Derivatives";
import type { DocCommitted } from "./DocCommitted";
import type { DocDiffReady } from "./DocDiffReady";
import type { DocGenerationEvent } from "./DocGenerationEvent";
import type { ContentDocState, WireActiveOverlay } from "./DocState";
import type { DocumentSnapshot } from "./DocumentSnapshot";
import type { FolderSourceOperationResult, FolderSourcesChanged } from "./FolderSource";
import type { LexiconEntrySummary, LexiconResourceSummary } from "./ListLexicons";
import type { MessagePart } from "./MessagePart";
import type { Resource } from "./Resource";
import type { ResourceRef } from "./ResourceRef";
import type { StreamFrame } from "./StreamFrame";
import type { TodoItem } from "./TodoItem";
import type { ToolCallSpec } from "./ToolCallSpec";
import type { AnnotationGroup } from "./DocSuggestion";
import type { SuggestionAnchor } from "./DocSuggestion";
import type { ReviewTemplateItem } from "./ReviewTemplates";
import type { DraftTemplateResult } from "./DraftTemplate";
import type { ConfirmRequested, ConfirmResolved } from "./Confirm";
import type { WriteDraftFailureDiagnostic } from "./WriteDraftCardBody";

export type BridgeFrame =
  | { kind: "templateDrafted"; data: DraftTemplateResult & { requestId: string } }
  | { kind: "reviewTemplatesListed"; data: { requestId: string; items: ReviewTemplateItem[]; selectedTemplateId: string | null } }
  | { kind: "reviewTemplateSaved"; data: { requestId: string; item: ReviewTemplateItem } }
  | { kind: "reviewTemplateDeleted"; data: { requestId: string; id: string; selectedTemplateId: string | null; error?: string } }
  | { kind: "reviewTemplateSelected"; data: { requestId: string; type: string; templateId: string } }
  | { kind: "reviewSupplementLoaded"; data: { requestId: string; type: string; templateId?: string; supplement: string } }
  | { kind: "reviewSupplementSaved"; data: { requestId: string; type: string; templateId?: string; supplement: string } }
  | { kind: "styleTemplatesListed"; data: { requestId: string; items: StyleTemplateItem[] } }
  | { kind: "styleTemplateLoaded"; data: { requestId: string; item: StyleTemplateItem } }
  | { kind: "styleTemplateSaved"; data: { requestId: string; item: StyleTemplateItem } }
  | { kind: "styleTemplateDeleted"; data: { requestId: string; id: string; error?: string } }
  | { kind: "derivativeParamsUpdated"; data: { requestId: string; item: DerivativeItem } }
  | { kind: "derivativesListed"; data: { requestId: string; items: DerivativeItem[] } }
  | { kind: "derivativeCreated"; data: { requestId: string; item: DerivativeItem } }
  | { kind: "derivativeGenFinished"; data: { docId: string; generatedAt: string; docVersion: number } }
  | { kind: "derivativeDeleted"; data: { requestId: string; docId: string } }
  | { kind: "derivativeDocLoaded"; data: { requestId: string; meta: DerivativeItem; docPm: string; docVersion: number; title: string } }
  | { kind: "lexiconsListed"; data: { lexicons: LexiconResourceSummary[] } }
  | { kind: "enabledLexiconsSet"; data: { requestId: string; lexicons: LexiconResourceSummary[] } }
  | { kind: "lexiconEntriesListed"; data: { resourceId: string; entries: LexiconEntrySummary[] } }
  | { kind: "restoreReset"; data: { epoch: number; snapshotSeq: number } }
  | { kind: "sessionRestoreCompleted"; data: { sessionId: string } }
  | { kind: "sessionMeta"; data: { title: string; sessionId: string; notice?: { kind: "title_truncated"; maxChars: number } } }
  | { kind: "chatMessageAdded"; data: { message: ChatMessage; appendSeq?: number } }
  | { kind: "chatMessageAppended"; data: { messageId: string; seq: number; part: MessagePart } }
  | { kind: "actionCardUpdated"; data: { messageId: string; card: Extract<MessagePart, { kind: "actionCard" }>["data"] } }
  | { kind: "confirmRequested"; data: ConfirmRequested }
  | { kind: "confirmResolved"; data: ConfirmResolved }
  | { kind: "toolCallUpdated"; data: { messageId: string; toolCallId: string; spec: ToolCallSpec } }
  | { kind: "documentSnapshotWritten"; data: { doc: DocumentSnapshot } }
  | { kind: "docGenerationEvent"; data: DocGenerationEvent }
  | { kind: "docCommitted"; data: DocCommitted }
  | { kind: "docDiffReady"; data: DocDiffReady }
  | {
      kind: "annotationGroupsReady";
      /** 仅替换这些来源的批注；未列出的来源继续共存。空数组兼容旧的全量清空帧。 */
      data: {
        groups: AnnotationGroup[];
        replacedOrigins?: string[];
        /** 无法在新正文中可靠重定位、已停止展示的锚点数。 */
        invalidatedAnchorCount?: number;
      };
    }
  | {
      kind: "annotationPreview";
      data: { previewId: string; summary: string; anchors: SuggestionAnchor[] };
    }
  | { kind: "annotationPreviewCleared"; data: Record<string, never> }
  | { kind: "docWriteResult"; data:
      | { ok: true; clientMutationId: string; docVersion: number }
      | { ok: false; clientMutationId: string; reason: "agent_busy" | "not_editable" | "not_found" | "validation_error"; diagnostic?: WriteDraftFailureDiagnostic; validationMessage?: string }
      | { ok: false; clientMutationId: string; conflict: { expectedDocumentSnapshot: number; actualDocumentSnapshot: number } } }
  | {
      kind: "docStateChanged";
      data: {
        state: ContentDocState;
        activeOverlay: WireActiveOverlay;
        agentBusy: boolean;
        /** 审阅目标已由其它请求结算；调用方不得把它当成本次写入成功。 */
        reviewCompletion?: "noop";
      };
    }
  | { kind: "todosChanged"; data: { todos: TodoItem[] } }
  | { kind: "resourceUpserted"; data: { resource: Resource } }
  | { kind: "resourceUpdated"; data: { resourceRef: ResourceRef; summary: string | null; metadata: unknown | null } }
  | { kind: "resourceRemoved"; data: { resourceRef: ResourceRef } }
  | { kind: "folderSourcesChanged"; data: FolderSourcesChanged }
  | { kind: "folderSourceOperationResult"; data: FolderSourceOperationResult }
  | { kind: "stream"; data: StreamFrame };
