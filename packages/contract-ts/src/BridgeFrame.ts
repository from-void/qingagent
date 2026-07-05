import type { ChatMessage } from "./ChatMessage";
import type { DocCommitted } from "./DocCommitted";
import type { DocDiffReady } from "./DocDiffReady";
import type { DocGenerationEvent } from "./DocGenerationEvent";
import type { WireActiveOverlay, WireDocState } from "./DocState";
import type { DocumentSnapshot } from "./DocumentSnapshot";
import type { FolderSourceOperationResult, FolderSourcesChanged } from "./FolderSource";
import type { MessagePart } from "./MessagePart";
import type { Resource } from "./Resource";
import type { ResourceRef } from "./ResourceRef";
import type { StreamFrame } from "./StreamFrame";
import type { TodoItem } from "./TodoItem";
import type { ToolCallSpec } from "./ToolCallSpec";

/**
 * `chatMessageAdded.appendSeq`(可选,向后兼容):该消息快照时刻已计入的
 * `chatMessageAppended` seq 基线。restore 快照(restoreReset 后重放 chatHistory)
 * 对"进行中仍在流式追加的消息"必须携带它:前端 restoreReset 会清空 appendCursor,
 * 而直播增量的 seq 延续服务端计数(如 48、49…),若缺基线,前端"仅应用严格连续
 * seq === cursor+1"的守卫会把后续增量永久滞留 → 消息冻结。消费方应以
 * `appendCursor[message.id] = appendSeq ?? 0` 初始化游标。直播新消息(刚创建、
 * 尚无增量)可省略,语义等价于 0。
 */
export type BridgeFrame = { "kind": "restoreReset", "data": { epoch: number, snapshotSeq: number, } } | { "kind": "sessionMeta", "data": { title: string, sessionId: string, } } | { "kind": "chatMessageAdded", "data": { message: ChatMessage, appendSeq?: number, } } | { "kind": "chatMessageAppended", "data": { messageId: string, seq: number, part: MessagePart, } } | { "kind": "toolCallUpdated", "data": { messageId: string, toolCallId: string, spec: ToolCallSpec, } } | { "kind": "documentSnapshotWritten", "data": { doc: DocumentSnapshot, } } | { "kind": "docGenerationEvent", "data": DocGenerationEvent } | { "kind": "docCommitted", "data": DocCommitted } | { "kind": "docDiffReady", "data": DocDiffReady } | { "kind": "docWriteResult", "data": { ok: true, clientMutationId: string, docVersion: number, } | { ok: false, clientMutationId: string, reason: "agent_busy" | "not_editable" | "not_found" | "validation_error", } | { ok: false, clientMutationId: string, conflict: { expectedDocumentSnapshot: number, actualDocumentSnapshot: number, }, } } | { "kind": "docStateChanged", "data": { state: WireDocState, activeOverlay: WireActiveOverlay, agentBusy: boolean, } } | { "kind": "todosChanged", "data": { todos: TodoItem[] } } | { "kind": "resourceUpserted", "data": { resource: Resource, } } | { "kind": "resourceUpdated", "data": { resourceRef: ResourceRef, summary: string | null, metadata: unknown | null, } } | { "kind": "resourceRemoved", "data": { resourceRef: ResourceRef, } } | { "kind": "folderSourcesChanged", "data": FolderSourcesChanged } | { "kind": "folderSourceOperationResult", "data": FolderSourceOperationResult } | { "kind": "stream", "data": StreamFrame };
