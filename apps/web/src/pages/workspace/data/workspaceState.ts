import { produce, enableMapSet } from "immer";
import type {
  ChatMessage,
  DocGenerationEvent,
  DocDiffReady,
  DocSuggestion,
  DocState,
  FolderSource,
  ResourceRef,
  StreamFrame,
  ToolCallSpec,
  WireActiveOverlay,
  WorkspaceAction,
  WorkspaceFrame,
} from "./protocol";
import {
  pmDocToViewDocumentSnapshot,
  wireDocToView,
  type StreamError,
  type ViewDocumentSnapshot,
} from "./protocol";
import { resources } from "../../../system/resources";
import {
  annotationMutationKey,
  resourceMutationKey,
  workspaceMutations,
} from "./revisionedMutation";
import {
  maskSensitiveAnnotationGroup,
  type AiRun,
  type AiTextRun,
  type AnnotationGroup,
  type BridgeFrame,
  type TodoItem,
} from "@qingagent/contract-ts";
import {
  getDeterministicId,
  type PmBlockNode,
  type PmDoc,
  type PmInlineNode,
  type PmMark,
} from "@qingagent/pm-schema";

// Enable Map/Set support for immer (toolCalls is a Map)
enableMapSet();

// Re-export so consumers can import the action type from a single
// module alongside the reducer.
export type { WorkspaceAction };

/** Append-frame extracted for the seq-based dedupe / ordering helpers. */
type ChatAppendFrame = Extract<WorkspaceFrame, { kind: "chatMessageAppended" }>;

/** 在 chatHistory(messages.parts)里按 id 找一条 toolCall 的当前快照——给乐观清浮层判旧态用。 */
function findToolCallInMessages(
  messages: readonly ChatMessage[],
  toolCallId: string,
): ToolCallSpec | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === "toolCall" && p.data.id === toolCallId) {
        return p.data;
      }
    }
  }
  return undefined;
}

export interface GenerationDraftBlock {
  blockId: string;
  index: number;
  blockType: string | null;
  runs: AiRun[];
  appendOffset: number;
}

export interface GenerationDraft {
  generationId: string;
  lastSeq: number;
  gapDetected: boolean;
  baseVersion: number;
  doc: ViewDocumentSnapshot;
  blocks: Array<PmBlockNode | null>;
  openBlocks: Record<string, GenerationDraftBlock>;
}

export interface WorkspaceState {
  title: string;
  sessionId: string | null;
  docState: DocState;
  activeOverlay: WireActiveOverlay;
  agentBusy: boolean;
  /** 仅由服务端 docStateChanged 驱动；本地 stop 不得乐观清除。 */
  externalEditing: boolean;
  /** Chat messages in order of arrival (wire `ChatMessage` shape). */
  messages: ChatMessage[];
  /** Highest applied append `seq` per messageId. */
  appendCursor: Record<string, number>;
  /** Append frames waiting on their target message or earlier seq. */
  pendingAppends: Record<string, ChatAppendFrame[]>;
  /**
   * Canonical per-tool-call store. Replaces the Stage A.5 separate
   * state.askUser / state.patches / state.subAgents / state.planTasks
   * fields. Selectors filter this map by `body.kind`.
   */
  toolCalls: Map<string, ToolCallSpec>;
  /** Refs only; full Resource records live in system/resources/ registry. */
  resourceRefs: ResourceRef[];
  /** 当前会话已连接的文件夹资料库。 */
  folderSources: FolderSource[];
  /** AI 当前任务清单，仅用于输入框外侧轻量进度提示。 */
  todos: TodoItem[];
  /** Latest doc version (view shape with span overlays). */
  doc: ViewDocumentSnapshot | null;
  /** Frontend-only generated draft; never treated as canonical. */
  generationDraft: GenerationDraft | null;
  /** Frontend-only history viewing mode; orthogonal to wire content/editor state. */
  viewingVersion: number | null;
  viewingVersionId: string | null;
  viewingSnapshotDoc: ViewDocumentSnapshot | null;
  /** Latest final diff payload for the review/apply stage. */
  docDiff: DocDiffReady | null;
  annotationGroups: AnnotationGroup[];
  previewGroups: Array<Extract<BridgeFrame, { kind: "annotationPreview" }>["data"]>;
  /** Doc revision counter. */
  version: number;
  progressPct: number;
  etaSec: number | null;
  /** 当前是否有服务端流仍在进行。 */
  streamActive: boolean;
  /** 内部跟踪 active streamId,避免多个流交错时提前清空。 */
  activeStreamIds: string[];
  streamError: StreamError | null;
  /** 仅用于阻止同一流的低信息 end:error 覆盖 draftingFailed。 */
  streamErrorStreamId: string | null;
}

type PatchSummaryPart = Extract<ChatMessage["parts"][number], { kind: "patchSummary" }>;
type PatchSummaryDataWithReviewOutcome = PatchSummaryPart["data"] & {
  reviewOutcome?: "abandoned" | "failed" | "committed";
  appliedCount?: number;
  conflictCount?: number;
};

export const initialWorkspaceState: WorkspaceState = {
  title: "未命名草稿",
  sessionId: null,
  docState: { kind: "empty" },
  activeOverlay: null,
  agentBusy: false,
  externalEditing: false,
  messages: [],
  appendCursor: {},
  pendingAppends: {},
  toolCalls: new Map(),
  resourceRefs: [],
  folderSources: [],
  todos: [],
  doc: null,
  generationDraft: null,
  viewingVersion: null,
  viewingVersionId: null,
  viewingSnapshotDoc: null,
  docDiff: null,
  annotationGroups: [],
  previewGroups: [],
  // 空文档基线版本 0(此前残留 12 不合理:doc=null 却 version 12,会让空文档首写的 updateDoc
  // 带错 expectedDocumentSnapshot → createIfMissing 不触发)。真实 session 加载后由回流覆盖。
  version: 0,
  progressPct: 0,
  etaSec: null,
  streamActive: false,
  activeStreamIds: [],
  streamError: null,
  streamErrorStreamId: null,
};

function pmDocHasContent(pmDoc: PmDoc): boolean {
  return Array.isArray(pmDoc.content) && pmDoc.content.length > 0;
}

/**
 * Pure reducer. The page wraps this in `useReducer`; the stream
 * dispatches each frame as it arrives. Frame ordering and duplicate
 * delivery are absorbed here so Stage C reconnect / retry logic
 * doesn't need to sanitize before dispatch.
 *
 * Wrapped with immer's `produce` so case branches can use mutable
 * syntax while still producing structurally shared immutable output.
 */
export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  return produce(state, (draft) => {
    workspaceReducerMut(draft, action);
  });
}

/**
 * Mutable-style reducer (runs inside immer's produce).
 * Returns void — mutations on `draft` are automatically applied.
 */
function workspaceReducerMut(
  draft: WorkspaceState,
  action: WorkspaceAction,
): void {
  switch (action.kind) {
    case "lexiconsListed":
    case "enabledLexiconsSet":
      // 命令调用方通过 ServerStream waiter 消费，工作区持久状态无需保存。
      return;
    case "derivativeGenFinished":
      return;
    case "restoreReset":
      resetSessionScopedStateMut(draft);
      resources.reset();
      return;
    case "sessionRestoreCompleted":
      // 仅供呈现层结束首批水合门控；业务 state 已由此前的恢复帧完整重建。
      return;
    case "turn-rejected":
      draft.streamError = {
        kind: "draftingFailed",
        reason: action.data.message,
        retriable: true,
      };
      draft.streamErrorStreamId = null;
      draft.streamActive = false;
      draft.activeStreamIds = [];
      terminalizeInFlightToolCallsMut(draft, "failed");
      return;
    case "sessionMeta": {
      // Only reset session-scoped state when switching between two real
      // sessions (e.g. navigating from one existing session to another).
      // When transitioning from null (initial state) to a new session,
      // skip the reset — optimistic user messages may already be in
      // draft.messages and clearing them causes the user bubble to vanish.
      const isSessionSwitch =
        draft.sessionId !== null &&
        draft.sessionId !== action.data.sessionId;
      draft.title = action.data.title;
      draft.sessionId = action.data.sessionId;
      if (isSessionSwitch) {
        resetSessionScopedStateMut(draft);
        resources.reset();
      }
      return;
    }
    case "docStateChanged": {
      const nextDocState = action.data.state;
      if (nextDocState.kind !== "pendingReview") {
        markRejectedOnlyPatchSummariesAbandonedMut(draft);
        settleReviewToolCallsMut(draft);
      }
      draft.docState = nextDocState;
      draft.activeOverlay = action.data.activeOverlay;
      draft.externalEditing = action.data.externalEditing ?? false;
      reduceAgentBusyMut(draft, {
        kind: "projection",
        busy: action.data.agentBusy,
      });
      if (draft.docState.kind !== "pendingReview") {
        draft.docDiff = null;
      }
      return;
    }
    case "todosChanged":
      draft.todos = action.data.todos;
      return;
    case "docCommitted":
      markLatestPatchSummaryCommittedMut(
        draft,
        action.data.appliedCount,
        action.data.conflictCount,
      );
      return;
    case "chatMessageAdded": {
      const msg = action.data.message;
      if (draft.messages.some((m) => m.id === msg.id)) return;
      // Deep-copy the incoming message so we own its parts array.
      // Without this, a frozen (previously produced) message object
      // would cause "object is not extensible" when draining appends.
      draft.messages.push({
        ...msg,
        parts: msg.parts.slice(),
      });
      draft.appendCursor[msg.id] = action.data.appendSeq ?? 0;
      drainAppendQueueMut(draft, msg.id, []);
      reduceAgentBusyMut(draft, { kind: "activityObserved" });
      return;
    }
    case "chatMessageAppended":
      drainAppendQueueMut(draft, action.data.messageId, [action]);
      reduceAgentBusyMut(draft, { kind: "activityObserved" });
      return;
    case "actionCardUpdated": {
      const message = draft.messages.find((item) => item.id === action.data.messageId);
      if (!message) return;
      const partIndex = message.parts.findIndex((part) => part.kind === "actionCard");
      if (partIndex < 0) return;
      message.parts[partIndex] = { kind: "actionCard", data: action.data.card };
      return;
    }
    case "toolCallUpdated": {
      // 这条 update 之前该 toolCall 的旧态——既要看 toolCalls 缓存(流式 running/pending 进来的),
      // 也要看 chatHistory(冷恢复 / 历史卡只在 messages 里)。乐观清浮层要判它是否就是当前开着的那张卡。
      const prevSpec =
        draft.toolCalls.get(action.data.toolCallId) ??
        findToolCallInMessages(draft.messages, action.data.toolCallId);
      if (action.data.spec.status.kind === "committed") {
        markRejectedOnlyPatchSummariesAbandonedMut(draft);
      }
      if (
        action.data.spec.body.kind === "docSuggestion" &&
        action.data.spec.status.kind === "failed"
      ) {
        markPatchSummaryFailedMut(draft, [action.data.toolCallId]);
      }
      draft.toolCalls.set(action.data.toolCallId, action.data.spec);
      // 问卷被作答(askUser → done/failed)时,乐观清掉 askUser overlay:否则问卷卡(用 fullpageAsk)
      // 已消失、但 overlay 仍是 "askUser",输入框会一直锁在「请先完成右侧问卷」、视图也保持 locked,
      // 即便右侧已经在生成草稿。后端的 docStateChanged 随后会再确认。
      //
      // 但乐观清只能针对【这一刻正开着的那张卡】被作答:必须是它从 open(pending/running)
      // 翻成 done/failed。否则——典型在冷恢复重放里——历史上早已 done/failed 的旧 askUser 卡(首次
      // 见到即终态,prevSpec 不是 open)会被当作"刚作答"再次触发清浮层,把后端刚发来的、属于另一张
      // 【仍 pending】反问卡的活跃 overlay 误清掉,导致前端不显示卡、不锁输入框,而后端
      // hasActiveSuspension 仍为 true → 发消息被拒"请先完成问卷"的前后端死锁。要求 prev 为 open 即排除之。
      {
        const s = action.data.spec;
        const wasOpen =
          prevSpec !== undefined &&
          (prevSpec.status.kind === "pending" ||
            prevSpec.status.kind === "running");
        if (
          s.body.kind === "askUser" &&
          (s.status.kind === "done" ||
            s.status.kind === "failed" ||
            s.status.kind === "aborted") &&
          wasOpen &&
          draft.activeOverlay === "askUser"
        ) {
          draft.activeOverlay = null;
        }
      }
      pruneCommittedDocDiffSuggestionMut(draft, action.data.toolCallId, action.data.spec);
      const msgIdx = draft.messages.findIndex(
        (m) => m.id === action.data.messageId,
      );
      if (msgIdx >= 0) {
        const m = draft.messages[msgIdx]!;
        for (let i = 0; i < m.parts.length; i++) {
          const p = m.parts[i]!;
          if (p.kind === "toolCall" && p.data.id === action.data.toolCallId) {
            m.parts[i] = { ...p, data: action.data.spec };
          }
        }
      }
      reduceAgentBusyMut(draft, { kind: "activityObserved" });
      return;
    }
    case "documentSnapshotWritten":
      markRejectedOnlyPatchSummariesAbandonedMut(draft);
      draft.doc = wireDocToView(action.data.doc);
      // 服务端 canonical 快照本身就是“文档已存在”的权威事实。恢复流偶发把
      // docStateChanged(empty) 留在前面且没有后续 editing 帧时，若这里不收敛，
      // 页面会有正文/版本却只挂静态 article，编辑器与审查/导出入口一起消失。
      // overlay / agentBusy 是独立锁维度，推进 content state 不会擅自解锁交互。
      if (draft.docState.kind === "empty") {
        draft.docState = { kind: "editing" };
      }
      draft.generationDraft = null;
      draft.docDiff = null;
      draft.version = action.data.doc.version;
      draft.progressPct = 1;
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      return;
    case "viewingVersionSet":
      draft.viewingVersion = action.version;
      draft.viewingVersionId = action.versionId ?? null;
      if (action.version === null) draft.viewingSnapshotDoc = null;
      return;
    case "historySnapshotSet":
      draft.viewingSnapshotDoc = action.doc;
      return;
    case "docDiffReady":
      draft.generationDraft = null;
      draft.docDiff = action.data;
      // 诊断 p01/p03:审阅基线必须用服务端"候选生成时刻的真实文档"。前端
      // state.doc 可能落后(手动编辑保存只回版本号);previewDoc 协议早已在发,
      // 此前被忽略。用它对齐基线,审阅 overlay 不再叠在陈旧文档上。
      if (action.data.previewDoc) {
        draft.doc = pmDocToViewDocumentSnapshot(
          action.data.previewDoc as PmDoc,
          action.data.baseVersion ?? draft.version,
        );
        draft.version = action.data.baseVersion ?? draft.version;
      }
      return;
    case "annotationGroupsReady": {
      draft.previewGroups = [];
      const groups = action.data.groups.map(maskSensitiveAnnotationGroup);
      if (draft.sessionId) {
        for (const group of groups) {
          workspaceMutations.reconcile(
            annotationMutationKey(draft.sessionId, group.id),
          );
        }
      }
      if (groups.length === 0 && !action.data.replacedOrigins?.length) {
        draft.annotationGroups = [];
        return;
      }
      const replacedOrigins = new Set(
        action.data.replacedOrigins ?? groups.map((group) => group.origin),
      );
      const retained = draft.annotationGroups.filter((group) => !replacedOrigins.has(group.origin));
      // 这是服务端权威状态，不能保留同 id 的本地乐观 accepted/ignored；
      // 否则命令失败后的 reviewing 回帧无法自愈。
      draft.annotationGroups = [...retained, ...groups];
      return;
    }
    case "annotationPreview": {
      const index = draft.previewGroups.findIndex((group) => group.previewId === action.data.previewId);
      if (index >= 0) draft.previewGroups[index] = action.data;
      else draft.previewGroups.push(action.data);
      return;
    }
    case "annotationPreviewCleared":
      draft.previewGroups = [];
      return;
    case "annotationGroupsChanged":
      draft.annotationGroups = action.groups.map(maskSensitiveAnnotationGroup);
      return;
    case "manualDocSaved":
      draft.doc = pmDocToViewDocumentSnapshot(action.pmDoc, action.version);
      draft.version = action.version;
      // 空文档首写(本地空白起稿/模板填充):仅在静默态(无 overlay、agent 不忙)本地推进 editing,
      // 让编辑器立即可用。overlay 挂起/agent 忙时绝不本地翻转、更不清 overlay——服务端 suspension
      // 仍在,本地清会造成前后端状态分叉(问卷从 UI 消失但保存全被拒,review #1);以后端
      // docStateChanged 投影为准。
      if (
        draft.docState.kind === "empty" &&
        pmDocHasContent(action.pmDoc) &&
        draft.activeOverlay === null &&
        !draft.agentBusy
      ) {
        draft.docState = { kind: "editing" };
      }
      return;
    case "docGenerationEvent":
      reduceDocGenerationEventMut(draft, action.data);
      return;
    case "docWriteResult":
      if (action.data.ok) {
        draft.version = action.data.docVersion;
        draft.streamError = null;
        draft.streamErrorStreamId = null;
        return;
      }
      if ("conflict" in action.data) {
        // 审阅提交会推进文档版本；此前编辑态已发出的防抖保存可能稍后才返回 conflict。
        // 若 pendingReview 已经观测到 actual 版本，这只是迟到回执，不能再弹“重载”。
        // actual 高于本地 version 仍是真外部并发，保留原提示。
        if (
          draft.docState.kind === "pendingReview" &&
          action.data.conflict.actualDocumentSnapshot <= draft.version
        ) {
          return;
        }
        draft.streamError = {
          kind: "docWriteConflict",
          reason: "文档已被更新，请重载后继续编辑。",
          retriable: true,
          actualDocumentSnapshot: action.data.conflict.actualDocumentSnapshot,
        };
        draft.streamErrorStreamId = null;
        return;
      }
      draft.streamError = {
        kind: "draftingFailed",
        reason:
          action.data.reason === "agent_busy"
            ? "正在写入内容，请稍后再编辑。"
            : action.data.reason === "lock_lost"
              ? "本回合编辑锁已失效，请稍后重新开始。"
            : action.data.reason === "not_editable"
              ? "当前文档状态不可编辑。"
              : action.data.reason === "validation_error"
                ? "保存校验失败，请检查文档内容后重试。"
                : "文档不存在，请刷新后重试。",
        retriable: action.data.reason === "not_found",
      };
      draft.streamErrorStreamId = null;
      return;
    case "resourceUpserted": {
      // Side-effect: update the external resource registry (outside immer)
      resources.upsert(action.data.resource);
      const ref = action.data.resource.resourceRef;
      const exists = draft.resourceRefs.some(
        (r) => r.id === ref.id && r.domain.kind === ref.domain.kind,
      );
      if (!exists) {
        draft.resourceRefs.push(ref);
      }
      return;
    }
    case "resourceUpdated":
      // Side-effect: update the external resource registry (outside immer)
      workspaceMutations.reconcile(
        resourceMutationKey(
          action.data.resourceRef.domain.kind,
          action.data.resourceRef.id,
        ),
      );
      resources.applyUpdate(
        action.data.resourceRef,
        action.data.summary === null ? "" : action.data.summary,
        action.data.metadata ?? undefined,
      );
      return;
    case "resourceRemoved": {
      // Side-effect: drop from external registry, and prune the stale ref so
      // 状态里不残留已删素材的引用(否则 resourceRefs 里留 dangling ref)。
      const ref = action.data.resourceRef;
      workspaceMutations.reconcile(
        resourceMutationKey(ref.domain.kind, ref.id),
      );
      resources.remove(ref);
      draft.resourceRefs = draft.resourceRefs.filter(
        (r) => !(r.id === ref.id && r.domain.kind === ref.domain.kind),
      );
      return;
    }
    case "folderSourcesChanged":
      if (action.data.sessionId !== draft.sessionId) return;
      draft.folderSources = action.data.sources;
      return;
    case "folderSourceOperationResult":
      return;
    case "stream":
      reduceStreamMut(draft, action.data);
      return;
    case "streamErrorCleared":
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      return;
    case "streamErrorSet":
      draft.streamError = action.error;
      draft.streamErrorStreamId = null;
      draft.streamActive = false;
      draft.activeStreamIds = [];
      terminalizeInFlightToolCallsMut(draft, "failed");
      reduceAgentBusyMut(draft, { kind: "turnTerminated" });
      return;
    case "documentFrameConflict":
      draft.streamError = {
        kind: "docWriteConflict",
        reason: "文档已生成新版本，本地未保存编辑已保留；可重载查看服务器版本。",
        retriable: true,
        action: "reload",
        actualDocumentSnapshot: action.actualDocumentSnapshot,
      };
      draft.streamErrorStreamId = null;
      return;
    case "retryDrafting":
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      return;
    case "streamTerminated":
      reduceStreamTerminatedMut(draft, action.streamIds, action.reason);
      return;
    case "restoreAskUser": {
      draft.toolCalls.set(action.toolCall.id, action.toolCall);
      const msgIdx = draft.messages.findIndex((m) => m.id === action.messageId);
      if (msgIdx >= 0) {
        const message = draft.messages[msgIdx]!;
        for (let i = 0; i < message.parts.length; i++) {
          const part = message.parts[i]!;
          if (part.kind === "toolCall" && part.data.id === action.toolCall.id) {
            message.parts[i] = { ...part, data: action.toolCall };
          }
        }
      }
      draft.activeOverlay = action.overlay;
      draft.docState = action.docState;
      reduceAgentBusyMut(draft, {
        kind: "projection",
        busy: action.agentBusy,
      });
      return;
    }
    case "forceUnlockReview":
      if (draft.docState.kind === "pendingReview") {
        draft.docState = draft.doc ? { kind: "editing" } : { kind: "empty" };
      }
      markRejectedOnlyPatchSummariesAbandonedMut(draft);
      settleReviewToolCallsMut(draft);
      draft.docDiff = null;
      draft.activeOverlay = null;
      reduceAgentBusyMut(draft, { kind: "reset" });
      return;
    case "rewindChat":
      draft.messages.splice(action.keepMessageCount);
      return;
  }
}

function reviewBatchIdFromSuggestion(suggestion: DocSuggestion): string {
  return suggestion.reviewBatchId ?? suggestion.diffHunk?.reviewBatchId ?? suggestion.id;
}

function reviewBatchIdFromToolCall(spec: ToolCallSpec): string | null {
  if (spec.body.kind !== "docSuggestion" || spec.body.data.kind !== "suggestion") {
    return null;
  }
  const suggestion = spec.body.data.data;
  return reviewBatchIdFromSuggestion(suggestion);
}

function pruneCommittedDocDiffSuggestionMut(
  draft: WorkspaceState,
  toolCallId: string,
  spec: ToolCallSpec,
): void {
  if (!draft.docDiff || spec.status.kind !== "committed") return;
  const reviewBatchId = reviewBatchIdFromToolCall(spec);
  const suggestions = draft.docDiff.suggestions.filter((suggestion) => {
    if (suggestion.id === toolCallId) return false;
    return reviewBatchId === null || reviewBatchIdFromSuggestion(suggestion) !== reviewBatchId;
  });
  draft.docDiff = suggestions.length > 0 ? { ...draft.docDiff, suggestions } : null;
}

function markRejectedOnlyPatchSummariesAbandonedMut(draft: WorkspaceState): void {
  if (!draft.docDiff || draft.docDiff.suggestions.length === 0) return;
  const reviewIds = new Set<string>();
  const rejectedIds = new Set<string>();

  for (const suggestion of draft.docDiff.suggestions) {
    reviewIds.add(suggestion.id);
    const status = effectiveDocSuggestionStatus(draft, suggestion);
    if (status.kind === "rejected") {
      rejectedIds.add(suggestion.id);
    }
  }
  if (rejectedIds.size === 0) return;

  for (const message of draft.messages) {
    for (const part of message.parts) {
      if (part.kind !== "patchSummary") continue;
      const hunkIds = part.data.hunkIds;
      if (hunkIds.length === 0) continue;
      if (!hunkIds.every((id) => reviewIds.has(id))) continue;
      if (!hunkIds.every((id) => rejectedIds.has(id))) continue;
      (part.data as PatchSummaryDataWithReviewOutcome).reviewOutcome = "abandoned";
    }
  }
}

function markPatchSummaryFailedMut(
  draft: WorkspaceState,
  hunkIds: readonly string[],
): void {
  const failedIds = new Set(hunkIds);
  if (failedIds.size === 0) return;
  for (let messageIndex = draft.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = draft.messages[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!;
      if (part.kind !== "patchSummary") continue;
      if (!part.data.hunkIds.some((id) => failedIds.has(id))) continue;
      const data = part.data as PatchSummaryDataWithReviewOutcome;
      // 成功是不可逆终态，禁止迟到的失败帧反向覆盖已落库摘要。
      if (data.reviewOutcome === "committed") return;
      data.reviewOutcome = "failed";
      delete data.appliedCount;
      delete data.conflictCount;
      return;
    }
  }
}

function markLatestPatchSummaryCommittedMut(
  draft: WorkspaceState,
  appliedCount: number | undefined,
  conflictCount: number | undefined,
): void {
  for (let messageIndex = draft.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = draft.messages[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!;
      if (part.kind !== "patchSummary") continue;
      const data = part.data as PatchSummaryDataWithReviewOutcome;
      if (data.reviewOutcome === "abandoned") return;
      // 单项失效帧可能先于部分成功的 docCommitted 到达；仅正数 appliedCount
      // 可以把整批摘要从 failed 纠正为 committed，旧协议未知计数仍 fail-closed。
      if (data.reviewOutcome === "failed" && !(appliedCount !== undefined && appliedCount > 0)) return;
      data.reviewOutcome = "committed";
      if (appliedCount !== undefined) data.appliedCount = appliedCount;
      if (conflictCount !== undefined) data.conflictCount = conflictCount;
      return;
    }
  }
}

function settleReviewToolCallsMut(draft: WorkspaceState): void {
  const settledById = new Map<string, ToolCallSpec>();
  for (const [id, spec] of draft.toolCalls.entries()) {
    const settled = settleReviewToolCall(spec);
    if (!settled) continue;
    draft.toolCalls.set(id, settled);
    settledById.set(id, settled);
  }

  for (const message of draft.messages) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      const settled = settledById.get(part.data.id) ?? settleReviewToolCall(part.data);
      if (!settled) continue;
      draft.toolCalls.set(settled.id, settled);
      settledById.set(settled.id, settled);
      message.parts[i] = { ...part, data: settled };
    }
  }
}

function settleReviewToolCall(spec: ToolCallSpec): ToolCallSpec | null {
  if (spec.body.kind !== "docSuggestion") return null;
  if (!isReviewablePatchStatus(spec.status)) return null;
  return {
    ...spec,
    status: { kind: "committed" },
  };
}

function effectiveDocSuggestionStatus(
  draft: WorkspaceState,
  suggestion: DocSuggestion,
): ToolCallSpec["status"] {
  const existing = draft.toolCalls.get(suggestion.id);
  if (existing?.body.kind === "docSuggestion" && existing.body.data.kind === "suggestion") {
    return existing.status;
  }
  return toolStatusFromSuggestion(suggestion);
}

type AgentBusyEvent =
  | { kind: "projection"; busy: boolean }
  | { kind: "activityObserved" }
  | { kind: "turnTerminated" }
  | { kind: "reset" };

function hasRunningToolCall(draft: WorkspaceState): boolean {
  for (const spec of draft.toolCalls.values()) {
    if (spec.status.kind !== "running") continue;
    // 这两类 running 工具有各自覆盖层；把它们并入通用 agentBusy 会抢走
    // askUser/imageProgress 的专属提示与视觉状态。
    if (spec.body.kind === "askUser" || spec.name === "generateSvg") continue;
    return true;
  }
  return false;
}

/**
 * `agentBusy` 的唯一状态转换入口。
 *
 * 后端投影、活跃 stream 和 running tool 都能证明本轮仍在工作；其中任一为真都不能
 * 被文档生成等子事件清掉。反过来，stream 的最终结束/本地终止才是整轮结束的权威
 * 信号，此时忽略可能迟到的 running 卡快照，避免编辑锁永久卡住。
 */
function reduceAgentBusyMut(
  draft: WorkspaceState,
  event: AgentBusyEvent,
): void {
  const hasActiveStream = draft.activeStreamIds.length > 0;
  switch (event.kind) {
    case "projection":
      draft.agentBusy =
        event.busy || hasActiveStream || hasRunningToolCall(draft);
      return;
    case "activityObserved":
      if (hasActiveStream || hasRunningToolCall(draft)) {
        draft.agentBusy = true;
      }
      return;
    case "turnTerminated":
      draft.agentBusy = hasActiveStream;
      return;
    case "reset":
      draft.agentBusy = false;
      return;
  }
}

function resetSessionScopedStateMut(draft: WorkspaceState): void {
  draft.docState = { kind: "empty" };
  draft.activeOverlay = null;
  draft.externalEditing = false;
  reduceAgentBusyMut(draft, { kind: "reset" });
  draft.messages = [];
  draft.appendCursor = {};
  draft.pendingAppends = {};
  draft.toolCalls = new Map();
  draft.resourceRefs = [];
  draft.folderSources = [];
  draft.todos = [];
  draft.doc = null;
  draft.generationDraft = null;
  draft.viewingVersion = null;
  draft.viewingVersionId = null;
  draft.viewingSnapshotDoc = null;
  draft.docDiff = null;
  draft.annotationGroups = [];
  draft.previewGroups = [];
  draft.version = initialWorkspaceState.version;
  draft.progressPct = 0;
  draft.etaSec = null;
  draft.streamActive = false;
  draft.activeStreamIds = [];
  draft.streamError = null;
  draft.streamErrorStreamId = null;
}

function reduceStreamMut(draft: WorkspaceState, s: StreamFrame): void {
  switch (s.kind) {
    case "start":
      markStreamActiveMut(draft, s.data.streamId);
      reduceAgentBusyMut(draft, { kind: "activityObserved" });
      return;
    case "end":
      if (s.data.finalDocument) {
        throw new Error(
          "契约违规：stream end.finalDocument 必须先经 splitStreamEndFinalDocument 拆分",
        );
      }
      markStreamInactiveMut(draft, s.data.streamId);
      // generationDraft 是流生命周期内的瞬态投影。最后一条流已经终止就是它失效的
      // 权威事实；不能只清 busy 却留下 draft 对象，否则 presentation 收尾后 RightPane
      // 会把残留草稿误当成“仍在生成”，把已落库终稿降级成静态只读快照。
      if (!draft.streamActive) {
        draft.generationDraft = null;
      }
      reduceAgentBusyMut(draft, { kind: "turnTerminated" });
      if (s.data.reason.kind === "cancelled") {
        terminalizeInFlightToolCallsMut(draft, "aborted");
        draft.streamError = { kind: "cancelled", reason: "" };
        draft.streamErrorStreamId = s.data.streamId;
      } else if (s.data.reason.kind === "error") {
        terminalizeInFlightToolCallsMut(draft, "failed");
        const hasSpecificFailureForThisStream =
          draft.streamError?.kind === "draftingFailed" &&
          draft.streamErrorStreamId === s.data.streamId;
        if (!hasSpecificFailureForThisStream) {
          draft.streamError = { kind: "failed", reason: s.data.reason.data };
          draft.streamErrorStreamId = s.data.streamId;
        }
      }
      return;
    case "draftingFailed":
      markStreamInactiveMut(draft, s.data.streamId);
      terminalizeInFlightToolCallsMut(draft, "failed");
      reduceAgentBusyMut(draft, { kind: "turnTerminated" });
      draft.generationDraft = null;
      draft.streamError = {
        kind: "draftingFailed",
        reason: s.data.userMessage ?? s.data.reason,
        retriable: s.data.retriable,
        statusCode: s.data.statusCode,
        category: s.data.category,
        userMessage: s.data.userMessage,
        action: s.data.action,
      };
      draft.streamErrorStreamId = s.data.streamId;
      return;
  }
}

function markStreamActiveMut(draft: WorkspaceState, streamId: string): void {
  if (!draft.activeStreamIds.includes(streamId)) {
    draft.activeStreamIds.push(streamId);
  }
  draft.streamActive = true;
}

function markStreamInactiveMut(draft: WorkspaceState, streamId: string): void {
  draft.activeStreamIds = draft.activeStreamIds.filter((id) => id !== streamId);
  draft.streamActive = draft.activeStreamIds.length > 0;
}

function reduceStreamTerminatedMut(
  draft: WorkspaceState,
  streamIds: string[] | undefined,
  reason: "stop" | "abort" | "error" | "completed",
): void {
  if (reason !== "completed") {
    terminalizeInFlightToolCallsMut(
      draft,
      reason === "error" ? "failed" : "aborted",
    );
  }
  if (!streamIds || streamIds.length === 0) {
    draft.activeStreamIds = [];
    draft.streamActive = false;
    draft.generationDraft = null;
    reduceAgentBusyMut(draft, { kind: "turnTerminated" });
    return;
  }
  const terminated = new Set(streamIds);
  draft.activeStreamIds = draft.activeStreamIds.filter(
    (id) => !terminated.has(id),
  );
  draft.streamActive = draft.activeStreamIds.length > 0;
  if (!draft.streamActive) {
    draft.generationDraft = null;
  }
  reduceAgentBusyMut(draft, { kind: "turnTerminated" });
}

/** 本地断线/停止兜底：即使终态帧尚未抵达，也不能让任何工具卡继续 loading。 */
function terminalizeInFlightToolCallsMut(
  draft: WorkspaceState,
  terminal: "aborted" | "failed",
): void {
  const settle = (spec: ToolCallSpec): ToolCallSpec => {
    if (spec.status.kind !== "pending" && spec.status.kind !== "running") return spec;
    return {
      ...spec,
      status: terminal === "aborted"
        ? { kind: "aborted" }
        : { kind: "failed", data: { retriable: true, reason: "未完成" } },
    };
  };

  for (const [id, spec] of draft.toolCalls.entries()) {
    draft.toolCalls.set(id, settle(spec));
  }
  for (const message of draft.messages) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index]!;
      if (part.kind !== "toolCall") continue;
      const settled = settle(part.data);
      if (settled !== part.data) {
        message.parts[index] = { kind: "toolCall", data: settled };
        draft.toolCalls.set(settled.id, settled);
      }
    }
  }
}

/* ───────────── helpers ───────────── */

function reduceDocGenerationEventMut(
  draft: WorkspaceState,
  event: DocGenerationEvent,
): void {
  switch (event.kind) {
    case "generation_started": {
      if (
        draft.generationDraft?.generationId === event.data.generationId &&
        event.data.seq <= draft.generationDraft.lastSeq
      ) {
        return;
      }
      draft.generationDraft = createGenerationDraft(
        event.data.generationId,
        event.data.seq,
        event.data.baseVersion,
      );
      draft.progressPct = Math.max(draft.progressPct, 0.02);
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      return;
    }
    case "generation_finished":
      draft.doc = pmDocToViewDocumentSnapshot(event.data.doc as PmDoc, event.data.finalVersion);
      // generation_finished 与 documentSnapshotWritten 都是 canonical 正文已经存在的
      // 权威事实。若恢复/换线漏掉了前置 editing 投影，不能留下“有正文但 content=empty”
      // 的只读壳；pendingReview 则必须保留，不能被终稿回执越权退出审阅。
      if (draft.docState.kind === "empty") {
        draft.docState = { kind: "editing" };
      }
      draft.generationDraft = null;
      draft.docDiff = null;
      draft.version = event.data.finalVersion;
      draft.progressPct = 1;
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      // terminal-* 是服务端 stream terminal 携带的 canonical finalDocument 标识。
      // 生命周期帧正常会先清 busy；这里再按同一服务端终态事实收敛一次，吸收
      // 两帧之间迟到的 running tool 快照，避免挂尾。
      if (event.data.generationId.startsWith("terminal-")) {
        reduceAgentBusyMut(draft, { kind: "turnTerminated" });
      }
      return;
    case "generation_failed":
      if (
        !draft.generationDraft ||
        draft.generationDraft.generationId === event.data.generationId
      ) {
        draft.generationDraft = null;
        draft.streamError = {
          kind: "draftingFailed",
          reason: event.data.reason,
          retriable: true,
        };
        draft.streamErrorStreamId = null;
      }
      return;
    case "candidate_snapshot":
    case "block_started":
    case "inline_appended":
    case "block_finished":
      break;
  }

  let generationDraft = draft.generationDraft;
  if (!generationDraft) {
    generationDraft = createGenerationDraft(
      event.data.generationId,
      0,
      draft.version,
    );
    draft.generationDraft = generationDraft;
  }
  if (generationDraft.generationId !== event.data.generationId) return;
  if (event.data.seq <= generationDraft.lastSeq) return;
  if (generationDraft.gapDetected) return;
  if (event.data.prevSeq !== generationDraft.lastSeq) {
    generationDraft.gapDetected = true;
    return;
  }

  generationDraft.lastSeq = event.data.seq;
  switch (event.kind) {
    case "candidate_snapshot":
      generationDraft.baseVersion = event.data.baseVersion;
      generationDraft.blocks = event.data.doc.content.slice() as PmBlockNode[];
      generationDraft.openBlocks = {};
      generationDraft.doc = pmDocToViewDocumentSnapshot(
        event.data.doc as PmDoc,
        event.data.baseVersion,
      );
      draft.progressPct = Math.max(draft.progressPct, 0.95);
      draft.streamError = null;
      draft.streamErrorStreamId = null;
      return;
    case "block_started":
      generationDraft.openBlocks[event.data.blockId] = {
        blockId: event.data.blockId,
        index: event.data.index,
        blockType: event.data.blockType,
        runs: [],
        appendOffset: 0,
      };
      ensureDraftBlockSlot(generationDraft, event.data.index);
      return;
    case "inline_appended": {
      const block = generationDraft.openBlocks[event.data.blockId] ?? {
        blockId: event.data.blockId,
        index: event.data.index,
        blockType: null,
        runs: [],
        appendOffset: 0,
      };
      if (event.data.appendOffset !== block.appendOffset) {
        generationDraft.gapDetected = true;
        return;
      }
      block.runs.push(event.data.run);
      block.appendOffset += "text" in event.data.run ? event.data.run.text.length : 1;
      generationDraft.openBlocks[event.data.blockId] = block;
      generationDraft.blocks[event.data.index] = partialBlockNode(block);
      refreshGenerationDraftDocMut(generationDraft);
      draft.progressPct = Math.max(draft.progressPct, 0.08);
      return;
    }
    case "block_finished":
      generationDraft.blocks[event.data.index] = event.data.pmNode as PmBlockNode;
      delete generationDraft.openBlocks[event.data.blockId];
      refreshGenerationDraftDocMut(generationDraft);
      draft.progressPct = Math.max(
        draft.progressPct,
        Math.min(0.95, 0.15 + compactDraftBlocks(generationDraft).length * 0.08),
      );
      return;
  }
}

function createGenerationDraft(
  generationId: string,
  lastSeq: number,
  baseVersion: number,
): GenerationDraft {
  const doc = emptyPmDoc();
  return {
    generationId,
    lastSeq,
    gapDetected: false,
    baseVersion,
    doc: pmDocToViewDocumentSnapshot(doc, baseVersion),
    blocks: [],
    openBlocks: {},
  };
}

function emptyPmDoc(): PmDoc {
  return { type: "doc", attrs: { schemaVersion: 1 }, content: [] };
}

function ensureDraftBlockSlot(draft: GenerationDraft, index: number): void {
  while (draft.blocks.length <= index) draft.blocks.push(null);
}

function compactDraftBlocks(draft: GenerationDraft): PmBlockNode[] {
  return draft.blocks.filter((node): node is PmBlockNode => node !== null);
}

function refreshGenerationDraftDocMut(draft: GenerationDraft): void {
  const doc: PmDoc = {
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: compactDraftBlocks(draft),
  };
  draft.doc = pmDocToViewDocumentSnapshot(doc, draft.baseVersion);
}

function partialBlockNode(block: GenerationDraftBlock): PmBlockNode {
  const content = block.runs.flatMap((run, runIndex) =>
    runToInlineNodes(run, block.blockId, runIndex),
  );
  if (block.blockType === "heading") {
    return {
      type: "heading",
      attrs: { blockId: block.blockId, level: 1 },
      content,
    };
  }
  if (block.blockType === "codeBlock") {
    return {
      type: "codeBlock",
      attrs: { blockId: block.blockId, language: "plaintext" },
      content: content.filter((node): node is Extract<PmInlineNode, { type: "text" }> => node.type === "text"),
    };
  }
  return {
    type: "paragraph",
    attrs: { blockId: block.blockId },
    content,
  };
}

function runToInlineNodes(run: AiRun, blockId: string, runIndex: number): PmInlineNode[] {
  if (!("text" in run)) {
    return [{
      type: "footnoteReference",
      attrs: {
        id: run.id ?? getDeterministicId("footnote", { blockId, runIndex, note: run.note }),
        note: run.note,
      },
    }];
  }
  if (run.marks?.some((mark) => mark.type === "math")) {
    return [{ type: "inlineMath", attrs: { latex: run.text } }];
  }
  const marks = aiMarksToPmMarks(run.marks);
  const parts = run.text.split("\n");
  const nodes: PmInlineNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (part.length > 0) {
      nodes.push(marks.length > 0 ? { type: "text", text: part, marks } : { type: "text", text: part });
    }
  });
  return nodes;
}

function aiMarksToPmMarks(marks: AiTextRun["marks"]): PmMark[] {
  if (!marks || marks.length === 0) return [];
  return marks.flatMap((mark): PmMark[] => {
    switch (mark.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
      case "code":
        return [{ type: mark.type }];
      case "strikeThrough":
        return [{ type: "strike" }];
      case "link":
        return [{
          type: "link",
          attrs: { href: mark.href, title: mark.title ?? null },
        }];
      case "textColor":
        return [{ type: "textColor", attrs: { color: mark.color } }];
      case "highlight":
        return [{ type: "highlight", attrs: { color: mark.color } }];
      case "math":
        return [];
    }
  });
}

/**
 * Apply / buffer chat-message-appended frames using their `seq` for
 * idempotent replay + out-of-order tolerance. Mutates `draft` directly
 * (runs inside immer's produce).
 */
function drainAppendQueueMut(
  draft: WorkspaceState,
  messageId: string,
  incoming: ChatAppendFrame[],
): void {
  const cursor = draft.appendCursor[messageId] ?? 0;
  const buffered = draft.pendingAppends[messageId] ?? [];

  const merged: ChatAppendFrame[] = [];
  const seen = new Set<number>();
  for (const f of [...buffered, ...incoming]) {
    if (f.data.seq <= cursor) continue;
    if (seen.has(f.data.seq)) continue;
    seen.add(f.data.seq);
    merged.push(f);
  }
  merged.sort((a, b) => a.data.seq - b.data.seq);

  const msgIdx = draft.messages.findIndex((m) => m.id === messageId);
  if (msgIdx < 0) {
    if (
      merged.length === buffered.length &&
      merged.every((f, i) => f === buffered[i])
    ) {
      return;
    }
    draft.pendingAppends[messageId] = merged;
    return;
  }

  const target = draft.messages[msgIdx];
  if (!target) return;

  let nextCursor = cursor;
  let touched = false;
  const remaining: ChatAppendFrame[] = [];
  // Track the original parts length before appending — used for
  // tool-call mirroring below.
  const originalPartsLen = target.parts.length;

  for (const f of merged) {
    if (f.data.seq === nextCursor + 1) {
      // Coalesce adjacent text parts so per-character streaming
      // doesn't produce one DOM block per char.
      // Also coalesce adjacent thinking parts for streaming reasoning.
      const incomingPart = f.data.part;
      const last = target.parts[target.parts.length - 1];
      if (
        incomingPart.kind === "text" &&
        last &&
        last.kind === "text"
      ) {
        target.parts[target.parts.length - 1] = {
          kind: "text",
          data: { body: last.data.body + incomingPart.data.body },
        };
      } else if (
        incomingPart.kind === "thinking" &&
        last &&
        last.kind === "thinking"
      ) {
        target.parts[target.parts.length - 1] = {
          kind: "thinking",
          data: {
            id: last.data.id,
            steps: [...last.data.steps, ...incomingPart.data.steps],
          },
        };
      } else {
        target.parts.push(incomingPart);
      }
      nextCursor = f.data.seq;
      touched = true;
    } else {
      remaining.push(f);
    }
  }

  if (!touched && remaining.length === buffered.length) {
    return;
  }

  // Side-effect: mirror tool-call parts into the toolCalls map so the
  // canonical store contains every spec that exists on a message.
  // Race protection: if a `toolCallUpdated` arrived before the
  // `chatMessageAppended` carrying this tool-call lands, the canonical
  // toolCalls map already has a NEWER snapshot — never overwrite it
  // with the older snapshot from the appended part. Mirror only when
  // the spec is fresh (id absent) and let toolCallUpdated own
  // subsequent updates.
  if (touched) {
    for (let i = originalPartsLen; i < target.parts.length; i++) {
      const p = target.parts[i];
      if (p && p.kind === "toolCall") {
        const existing = draft.toolCalls.get(p.data.id);
        if (!existing) {
          draft.toolCalls.set(p.data.id, p.data);
        } else {
          // Canonical store already has a (likely-newer) entry — also
          // upgrade the part in the message to that canonical spec.
          target.parts[i] = { ...p, data: existing };
        }
      }
    }
  }

  if (remaining.length === 0) {
    delete draft.pendingAppends[messageId];
  } else {
    draft.pendingAppends[messageId] = remaining;
  }
  if (nextCursor !== cursor) {
    draft.appendCursor[messageId] = nextCursor;
  }
}

/* ───────────── selectors ───────────── */

/** Open AskUser tool-call (mode-agnostic), or null. */
export function selectOpenAskUser(state: WorkspaceState): ToolCallSpec | null {
  for (const tc of state.toolCalls.values()) {
    if (tc.body.kind !== "askUser") continue;
    const s = tc.status.kind;
    if (s === "done" || s === "failed" || s === "aborted") continue;
    // running = 正在流式产题(逐题渐进展示;此刻尚未 suspend、后端 overlay 还不是 askUser),
    // 必须显示以保留"边输出边展示"的问卷流式效果;
    // overlay==="askUser" = 已 suspend 待用户作答。此处不再要求 questions>0:
    //   activeOverlay 由后端 deriveActiveOverlay 派生,只在【活跃挂起 owner(runId 匹配)】或
    //   running 时才为 "askUser"(旧会话残留无 owner→不会为 askUser),已天然排除"旧会话空卡重开"。
    //   反之,活跃挂起但 questions 暂空(流式刚起/恢复中)也必须放行,让浮层渲染骨架 loading,
    //   否则刷新后活跃反问卡会凭空消失(回归)。
    if (s === "running") return tc;
    if (state.activeOverlay === "askUser") return tc;
  }
  return null;
}

/** Running generateSvg tool-call drives the imageProgress overlay, not agentBusy. */
export function selectGenerateSvgRunning(state: WorkspaceState): ToolCallSpec | null {
  for (const tc of state.toolCalls.values()) {
    if (tc.name === "generateSvg" && tc.status.kind === "running") {
      return tc;
    }
  }
  return null;
}

/** 统一后的轮次忙碌态；挂起等待及专属工具覆盖层不计入通用 busy。 */
export function selectAgentBusy(state: WorkspaceState): boolean {
  return state.agentBusy;
}

/** Reviewable docSuggestion tool-calls for the current round. */
export function selectPatches(state: WorkspaceState): ToolCallSpec[] {
  if (state.docState.kind !== "pendingReview") return [];
  const out: ToolCallSpec[] = [];
  const toolCallsById = new Map<string, ToolCallSpec>();
  for (const tc of state.toolCalls.values()) {
    toolCallsById.set(tc.id, tc);
  }

  if (state.docDiff) {
    for (const suggestion of state.docDiff.suggestions) {
      const existing = toolCallsById.get(suggestion.id);
      const status = docDiffSuggestionToolStatus(suggestion, existing);
      if (!isReviewablePatchStatus(status)) continue;
      out.push(buildSuggestionPatchToolCall(
        mergeDocDiffSuggestionStatus(suggestion, existing),
        status,
      ));
    }
  }

  const emittedDocDiffIds = new Set(state.docDiff?.suggestions.map((s) => s.id) ?? []);
  for (const tc of state.toolCalls.values()) {
    if (emittedDocDiffIds.has(tc.id)) continue;
    if (
      tc.body.kind === "docSuggestion" &&
      isReviewablePatchStatus(tc.status)
    ) {
      out.push(tc);
    }
  }
  return out;
}

function isReviewablePatchStatus(status: ToolCallSpec["status"]): boolean {
  return (
    status.kind === "reviewing" ||
    status.kind === "accepted" ||
    status.kind === "rejected"
  );
}

function docDiffSuggestionToolStatus(
  suggestion: DocSuggestion,
  existing: ToolCallSpec | undefined,
): ToolCallSpec["status"] {
  const suggestionStatus = toolStatusFromSuggestion(suggestion);
  if (!existing) return suggestionStatus;
  if (existing.status.kind === "committed") return existing.status;
  if (isReviewablePatchStatus(existing.status)) return existing.status;
  return suggestionStatus;
}

function toolStatusFromSuggestion(suggestion: DocSuggestion): ToolCallSpec["status"] {
  switch (suggestion.status) {
    case "accepted":
      return { kind: "accepted" };
    case "rejected":
      return { kind: "rejected" };
    case "committed":
      return { kind: "committed" };
    case "conflict":
    case "reviewing":
    case "ignored":
      return { kind: "reviewing" };
  }
}

function suggestionStatusFromToolStatus(status: ToolCallSpec["status"]): DocSuggestion["status"] | null {
  switch (status.kind) {
    case "reviewing":
      return "reviewing";
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "committed":
      return "committed";
    default:
      return null;
  }
}

function mergeDocDiffSuggestionStatus(
  suggestion: DocSuggestion,
  existing: ToolCallSpec | undefined,
): DocSuggestion {
  if (existing?.body.kind !== "docSuggestion" || existing.body.data.kind !== "suggestion") {
    return suggestion;
  }
  const status = suggestionStatusFromToolStatus(existing.status);
  return {
    ...suggestion,
    status: status ?? suggestion.status,
    ...(existing.body.data.data.conflict ? { conflict: existing.body.data.data.conflict } : {}),
  };
}

function buildSuggestionPatchToolCall(
  suggestion: DocSuggestion,
  status: ToolCallSpec["status"],
): ToolCallSpec {
  return {
    id: suggestion.id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status,
    body: {
      kind: "docSuggestion",
      data: {
        kind: "suggestion",
        data: suggestion,
      },
    },
    result: suggestion.conflict ? { kind: "genericText", data: suggestion.conflict.message } : null,
  };
}

/** Sub-agents derived from spawnSubAgent tool-calls (Round 3 fix #2). */
export function selectSubAgents(state: WorkspaceState): Array<{
  id: string;
  spawnedBy: string;
  rootTaskId: string;
  name: string;
  description: string;
  status: "pending" | "running" | "done" | "failed";
}> {
  const out: ReturnType<typeof selectSubAgents> = [];
  for (const tc of state.toolCalls.values()) {
    if (tc.body.kind !== "spawnSubAgent") continue;
    const status: "pending" | "running" | "done" | "failed" =
      tc.status.kind === "pending"
        ? "pending"
        : tc.status.kind === "running"
          ? "running"
          : tc.status.kind === "done"
            ? "done"
            : tc.status.kind === "failed" || tc.status.kind === "aborted"
              ? "failed"
              : (() => {
                  throw new Error(
                    `patch-only ToolCallStatus "${tc.status.kind}" is illegal on a spawnSubAgent tool-call`,
                  );
                })();
    out.push({
      id: tc.body.data.subAgentId,
      spawnedBy: tc.id,
      rootTaskId: tc.body.data.rootTaskId,
      name: tc.body.data.name,
      description: tc.body.data.description,
      status,
    });
  }
  return out;
}
