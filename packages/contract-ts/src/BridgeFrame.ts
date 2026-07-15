import type { ChatMessage } from "./ChatMessage";
import type { DerivativeItem, StyleTemplateItem } from "./Derivatives";
import type { DocCommitted } from "./DocCommitted";
import type { DocDiffReady } from "./DocDiffReady";
import type { DocGenerationEvent } from "./DocGenerationEvent";
import type { WireActiveOverlay, WireDocState } from "./DocState";
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

export type BridgeFrame =
  | { kind: "templateDrafted"; data: DraftTemplateResult }
  | { kind: "reviewTemplatesListed"; data: { items: ReviewTemplateItem[]; selectedTemplateId: string | null } }
  | { kind: "reviewTemplateSaved"; data: { item: ReviewTemplateItem } }
  | { kind: "reviewTemplateDeleted"; data: { id: string; selectedTemplateId: string | null; error?: string } }
  | { kind: "reviewTemplateSelected"; data: { type: string; templateId: string } }
  | { kind: "reviewSupplementLoaded"; data: { type: string; supplement: string } }
  | { kind: "reviewSupplementSaved"; data: { type: string; supplement: string } }
  | { kind: "styleTemplatesListed"; data: { items: StyleTemplateItem[] } }
  | { kind: "styleTemplateLoaded"; data: { item: StyleTemplateItem } }
  | { kind: "styleTemplateSaved"; data: { item: StyleTemplateItem } }
  | { kind: "styleTemplateDeleted"; data: { id: string; error?: string } }
  | { kind: "derivativeParamsUpdated"; data: { item: DerivativeItem } }
  | { kind: "derivativesListed"; data: { items: DerivativeItem[] } }
  | { kind: "derivativeCreated"; data: { item: DerivativeItem } }
  | { kind: "derivativeGenStarted"; data: { docId: string; targetLang: string } }
  | { kind: "derivativeGenDelta"; data: { docId: string; text: string } }
  | { kind: "derivativeGenFinished"; data: { docId: string; generatedAt: string; docVersion: number } }
  | { kind: "derivativeGenFailed"; data: { docId: string; reason: string } }
  | { kind: "derivativeDeleted"; data: { docId: string } }
  | { kind: "derivativeDocLoaded"; data: { meta: DerivativeItem; docPm: string; docVersion: number; title: string } }
  | { kind: "lexiconsListed"; data: { lexicons: LexiconResourceSummary[] } }
  | { kind: "lexiconEntriesListed"; data: { resourceId: string; entries: LexiconEntrySummary[] } }
  | { kind: "restoreReset"; data: { epoch: number; snapshotSeq: number } }
  | { kind: "sessionMeta"; data: { title: string; sessionId: string } }
  | { kind: "chatMessageAdded"; data: { message: ChatMessage; appendSeq?: number } }
  | { kind: "chatMessageAppended"; data: { messageId: string; seq: number; part: MessagePart } }
  | { kind: "toolCallUpdated"; data: { messageId: string; toolCallId: string; spec: ToolCallSpec } }
  | { kind: "documentSnapshotWritten"; data: { doc: DocumentSnapshot } }
  | { kind: "docGenerationEvent"; data: DocGenerationEvent }
  | { kind: "docCommitted"; data: DocCommitted }
  | { kind: "docDiffReady"; data: DocDiffReady }
  | {
      kind: "annotationGroupsReady";
      /** 仅替换这些来源的批注；未列出的来源继续共存。空数组兼容旧的全量清空帧。 */
      data: { groups: AnnotationGroup[]; replacedOrigins?: string[] };
    }
  | {
      kind: "annotationPreview";
      data: { previewId: string; summary: string; anchors: SuggestionAnchor[] };
    }
  | { kind: "annotationPreviewCleared"; data: Record<string, never> }
  | { kind: "docWriteResult"; data:
      | { ok: true; clientMutationId: string; docVersion: number }
      | { ok: false; clientMutationId: string; reason: "agent_busy" | "not_editable" | "not_found" | "validation_error" }
      | { ok: false; clientMutationId: string; conflict: { expectedDocumentSnapshot: number; actualDocumentSnapshot: number } } }
  | { kind: "docStateChanged"; data: { state: WireDocState; activeOverlay: WireActiveOverlay; agentBusy: boolean } }
  | { kind: "todosChanged"; data: { todos: TodoItem[] } }
  | { kind: "resourceUpserted"; data: { resource: Resource } }
  | { kind: "resourceUpdated"; data: { resourceRef: ResourceRef; summary: string | null; metadata: unknown | null } }
  | { kind: "resourceRemoved"; data: { resourceRef: ResourceRef } }
  | { kind: "folderSourcesChanged"; data: FolderSourcesChanged }
  | { kind: "folderSourceOperationResult"; data: FolderSourceOperationResult }
  | { kind: "stream"; data: StreamFrame };
