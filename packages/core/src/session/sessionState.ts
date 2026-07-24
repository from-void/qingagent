import type { CoreMessage } from "ai";
import type {
  ChatChip,
  ChatMessage,
  FolderSourceRecord,
  DiffHunk,
  DocSuggestion,
  AnnotationGroup,
  LegacySection,
  MessagePart,
  DocState,
  ConfirmSpec,
  TodoItem,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import type { Material } from "../types/material.js";
import type { ModelOverrides } from "../llm/modelConfig.js";
import type { QingagentToolSearchProcessor } from "../agents/toolSearch.js";
import { isQuestionnaireTool } from "../agent-run/questionnaireTools.js";

export interface PatchValidationResult {
  ok: boolean;
  applied: boolean;
  unconfirmed?: boolean;
  error?: string;
  blockIndex?: number;
  suggestionId?: string;
  conflictKind?: string;
  hint?: string;
  before_excerpt?: string;
  serverReanchorEnabled?: boolean;
  reanchorAttempted?: boolean;
  reanchorApplied?: boolean;
  confidence?: number;
  matchCount?: number;
  draftStatus?: DraftStatus;
  retryPolicy?: DraftRetryPolicy;
  draftApplied?: boolean;
  canonicalApplied?: boolean;
  draftViewHash?: string;
  draftProtocolVersion?: 1;
  changedRegion?: DraftChangedRegion;
}

export type DraftStatus =
  | "draftUpdated"
  | "pendingReview"
  | "anchorNotFound"
  | "invalidInput"
  | "unsupported"
  | "infraUnconfirmed";

export type DraftRetryPolicy =
  | "doNotRetry"
  | "retryOnceWithLatestDraft"
  | "askUser";

export interface DraftChangedRegion {
  blockIds: string[];
  blockPath: number[];
  order: number;
  afterText: string;
  quoteHash: string;
  changedRegionTruncated: boolean;
}

/** Server-side suggestion record stored during a review cycle. */
export interface SuggestionRecord {
  messageId: string;
  toolCallId: string;
  before: string;
  after: string;
  blockIndex: number;
  suggestion: DocSuggestion;
  /** Candidate-diff hunk backing this suggestion. */
  diffHunk?: DiffHunk;
}

export type SuspensionToolName = "askUser" | "planDraft" | "askUserQuestion";

export interface SuspensionOwner {
  streamId: string;
  runId: string;
  toolCallId: string;
  toolName: SuspensionToolName;
}

/** confirm 专用挂起记录；与 askUser 的 SuspensionOwner/runId/toolCallId 完全独立。 */
export interface PendingConfirm {
  confirmId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  commandDigest: string;
  spec: ConfirmSpec;
  requestedAt: string;
  expiresAt: string;
  status: "pending" | "resuming";
  decisionId?: string;
}

/** Mutable server-side session state. One per active session. */
export interface SessionState {
  sessionId: string;
  /** 稳定文档身份。阶段1保持 docId 与 sessionId 相等。 */
  docId: string;
  /** Thread ID in Mastra Memory storage. Same as sessionId when persisted. */
  threadId: string | null;
  /** Resource ID used by Mastra Memory for this session's thread. */
  resourceId: string;
  /** Monotonic user turn counter. Incremented once when a turn starts and persisted. */
  turnCounter: number;
  /** Last message cursor successfully handed to the OM sidecar. */
  omSidecarCursor?: OmSidecarCursor | null;
  /** Stable OM message ids that have been covered by active observations. */
  omObservedMessageIds?: string[];
  /** Single-way latch: once true, model input uses the compressed OM projection. */
  omCompressionActive?: boolean;
  /** 压缩快照代际：首次激活及每次成功观察/反思后单调递增。 */
  omCompressionEpoch?: number;
  /** 观察周期之间冻结的头部替换，保证同一代投影字节稳定。 */
  omCompressionSnapshot?: {
    epoch: number;
    observations: string;
    removedMessageIds: string[];
  } | null;
  /** 首次成功落稿后的 BranchCall 标题已经结算；重写不再重复起题。 */
  branchTitleGenerated?: boolean;
  title: string;
  /** 用户手动指定标题后锁定，正文 H1 与首稿起题不再覆盖。 */
  titlePinned: boolean;
  docState: DocState;
  messages: CoreMessage[];
  /** Canonical PM document. During transition, legacySections remains the legacy derived mirror. */
  doc?: PmDoc;
  legacySections: LegacySection[];
  docVersion: number;
  /** 内存态：模型最后一次确知的正文版本；服务重启后重置为 null。 */
  modelKnownDocVersion: number | null;
  /** 仅成功创建新文档版本时推进；首页按此字段排序。 */
  lastContentEditedAt: string | null;
  streamId: string | null;
  runId: string | null;
  toolCallId: string | null;
  previousDocState: DocState | null;
  /** Runtime-only cache for projected wire docState de-duplication. */
  _lastEmittedWireKind: string | null;
  /** Runtime-only abort controller for the active agent turn. Not persisted. */
  _abortController: AbortController | null;
  /** Runtime-only completion promise for the active turn's finally block. Not persisted. */
  _activeTurnPromise: Promise<void> | null;
  /** Runtime-only creation promise for the backing Mastra thread. Not persisted. */
  threadCreatePromise?: Promise<void>;
  /** PM-native review suggestions keyed by suggestion id. */
  suggestions: Map<string, SuggestionRecord>;
  /** 待用户裁决的问题中心批注组；独立于 revision，绝不驱动 pendingReview。 */
  annotationGroups: AnnotationGroup[];
  /** Runtime-only：本轮 create_annotation_groups 要在前端按来源换代的 origin 集合。 */
  _annotationOriginsReplacedThisTurn?: Set<string>;
  /** Verdict per patch: "accepted" | "rejected". Set by updatePatchVerdict. */
  patchVerdicts: Map<string, "accepted" | "rejected">;
  /** Legacy draft mutation result cache. Kept for persisted-session compatibility. */
  patchValidationResults: Map<string, PatchValidationResult>;
  /** Turn-scoped baseline for churn-governance confirmation. */
  docDraftBaseSections: LegacySection[] | null;
  docDraftBaseVersion: number | null;
  /** PM snapshot captured when a candidate-diff draft sandbox starts. */
  docDraftBaseDoc: PmDoc | null;
  /** Turn-scoped candidate. Never canonical until natural settle/commit. */
  docDraftCandidateSections: LegacySection[] | null;
  /** PM canonical for the turn-scoped whole-document candidate. */
  docDraftCandidateDoc: PmDoc | null;
  /** PM-native review-cycle baseline for suggestion restore/debugging. */
  suggestionBaseDoc: PmDoc | null;
  suggestionBaseVersion: number | null;
  /** Tracks the seq counter per message for chatMessageAppended */
  seqCounters: Map<string, number>;
  /** Uploaded and parsed materials, keyed by material ID. */
  materials: Map<string, Material>;
  /** 本地文件夹资料库绑定记录；真实路径只在服务端/持久化记录中使用，不下发模型提示。 */
  folderSources: Map<string, FolderSourceRecord>;
  /** 当前会话 AI 维护的任务清单；会话内 + restore 回放,不持久化 DB。 */
  todos: TodoItem[];
  /** Tracks the last doc version synced into the message history. */
  lastSyncedDocumentSnapshot: number;
  /** Resolved capability skill names from the current turn. */
  selectedSkills: string[];
  /** Whether the current turn had an explicit skill selection. */
  selectedSkillsHadSelection: boolean;
  /** Selection chips from the current turn, used by validatePatch for position-based matching. */
  _currentChips?: ChatChip[] | null;
  /** 素材正文引用缓存(会话级,跨轮存活):parseFile 按 filename 建键,抓取类按 url+title 建键。
   *  storeMaterial 落库时按键精确绑定正文,根治"单槽最近一次提取"被覆盖导致的多素材串台(p08)。 */
  _extractedTexts?: Map<string, { text: string; sourceUrl: string | null; fileId: string | null; sourceKind?: "github" }>;
  /** Maps section index to line number, built when doc snapshot is injected into messages. */
  _sectionToLine?: Map<number, number>;
  /** 用户**真正提交**过 askUser 问卷答案(tool-result 带 answers)才置真。守卫据此
   *  抑制重复 askUser——中途放弃(弹了没提交)不置真,允许重新交互时再问。 */
  _askUserCompleted?: boolean;
  /** askUser 问卷**弹出过**(suspend)即置真,跨会话持久;仅用于渲染形态判断
   *  (首轮→大表单 / 问过→左侧浮层),与"是否真提交"解耦。 */
  _askUserAsked?: boolean;
  /** Runtime-only:上一份已完成的 directionChange 问卷之后尚未出现有效草稿/文档写入。 */
  _directionChangeAskedSinceLastWrite?: boolean;
  /** Runtime-only guard against repeated askUser suspends without generation progress. */
  _askUserSuspendCount?: number;
  /** Runtime-only:每会话复用的 ToolSearch processor,不持久化。 */
  _toolSearchProcessor?: QingagentToolSearchProcessor;
  /** Runtime-only:创建 _toolSearchProcessor 时的可检索工具快照签名。 */
  _toolSearchToolSignature?: string;
  /** Runtime-only:ToolSearch 动态加载过的工具名,会话内只增不减。 */
  _toolSearchLoadedToolNames?: string[];
  /** Runtime-only:会话开始时冻结的 Working Memory 快照。会话内不随 updateWorkingMemory 改变。 */
  _workingMemorySnapshot?: string | null;
  /** Runtime-only:是否已尝试读取本会话 Working Memory 冻结快照。 */
  _workingMemorySnapshotLoaded?: boolean;
  /** Runtime-only:读取成功(含真实空记忆)的快照才允许持久化为 loaded。 */
  _workingMemorySnapshotPersistable?: boolean;
  /** Runtime-only:本会话是否写过 Working Memory；更新只给下个会话读取。 */
  _workingMemoryUpdatedThisSession?: boolean;
  /** Runtime-only:用户在 askUser 仍在生成(running、未挂起)时点了「放弃本轮」的 toolCallId 集合。
   *  abort 与 Mastra 挂起会抢跑——挂起若在 abort 后才落地,会被错投影成"新问卷"。挂起处理处
   *  命中本集合即丢弃该挂起、回 idle,避免"放弃后问卷又冒出来"。仅本轮生命周期内有效,不持久。 */
  _abandonedAskUserToolCallIds?: Set<string>;
  /** Runtime-only marker that this turn ended in a genuine resumable suspension. */
  _suspendedThisTurn?: boolean;
  /** Runtime-only owner for the currently resumable suspension. */
  _suspensionOwner?: SuspensionOwner | null;
  /** 独立 confirm 通道，以 toolCallId 为键；绝不参与 askUser suspension owner。 */
  pendingConfirms: Map<string, PendingConfirm>;
  /** Rich chat history (ChatMessage[]) for session restore.
   *  Captures full parts (text, thinking, toolCall) so tool bubbles survive restore. */
  chatHistory: ChatMessage[];
  /**
   * 阶段4a — clientTraceId 透传协议关联 id。前端为「一次用户动作」生成
   * 32hex，经请求头 `x-client-trace-id` 透传到后端（见设计文档 §十）。
   * 命令 span（②）/ db_write span（④）/ 流式模型 span（③）的 metadata 都带上它，
   * 便于按单次动作聚合四层。后端入口（stream 路由）读不到 header 时会兜底生成，
   * 所以通常非空，但仍标可选以兼容内部直接构造 SessionState 的路径（恢复/测试）。
   * 纯观测用途，不持久化进 thread.metadata。
   */
  clientTraceId?: string;
  /**
   * 0603 — 触发来源（日志可观测）：manual=真人前端 / agent=AI 经 agent-browser 等触发 /
   * e2e=自动化测试。由 server 入口读 `x-origin` header 绑定；command(②)/db_write(④)/
   * state_change span 的 metadata 继承之，供日志控制台按来源区分真人与 AI 触发。
   * 缺省视为 manual。纯观测用途，不持久化进 thread.metadata。
   */
  origin?: SpanOrigin;
  /**
   * F1 — 本请求模型覆盖(visitor key / global-db key / params)。
   * 只存在内存 SessionState,不持久化到 thread.metadata,避免 key 落盘。
   */
  modelOverrides?: ModelOverrides;
  /**
   * 阶段4 — db_write 审计用：上次成功持久化时关键字段的摘要快照，用于 diff 出
   * changedFields + before→after。仅含摘要 / 计数 / id（绝不含文档正文），由
   * persistSessionMetadata 维护。运行期缓存，不持久化。
   */
  _lastPersistSnapshot?: PersistAuditSnapshot;
}

/**
 * 0603 — 触发来源三态（日志可观测）。manual=真人前端操作；agent=AI 经 agent-browser 等触发；
 * e2e=自动化（Playwright）。
 */
export type SpanOrigin = "manual" | "agent" | "e2e" | "external";

export interface OmSidecarCursor {
  turnIndex: number;
  seqInTurn: number;
}

/**
 * 阶段4 — db_write 审计快照：persistSessionMetadata 落库前后用来对比的关键字段
 * 摘要。只存摘要 / 计数 / id，绝不存文档正文。
 */
export interface PersistAuditSnapshot {
  docStateKind: string;
  docVersion: number;
  suggestionCount: number;
  suggestionIds: string[];
  patchVerdictCount: number;
  folderSourceCount: number;
  folderSourceIds: string[];
  /**
   * 阶段4 follow-up — patchVerdict 内容签名（不仅比数量）。把 patchId→verdict 映射
   * 按 patchId 排序后拼成稳定小字符串（如 `id1:accepted|id2:rejected`），使「同数量但
   * verdict 变化」（accept→reject）也能被识别为变更。verdict 值域仅 accepted/rejected，
   * 体积可控；空映射为空串。
   */
  patchVerdictSig: string;
}

/** Create a fresh session with initial state. */
export function createSession(
  sessionId: string,
  createdAt = new Date().toISOString(),
): SessionState {
  return {
    sessionId,
    docId: sessionId,
    threadId: null,
    resourceId: "qingagent-user",
    turnCounter: 0,
    omSidecarCursor: null,
    omObservedMessageIds: [],
    omCompressionActive: false,
    omCompressionEpoch: 0,
    omCompressionSnapshot: null,
    branchTitleGenerated: false,
    title: "",
    titlePinned: false,
    docState: { kind: "empty" },
    messages: [],
    doc: undefined,
    legacySections: [],
    docVersion: 0,
    modelKnownDocVersion: null,
    lastContentEditedAt: createdAt,
    streamId: null,
    runId: null,
    toolCallId: null,
    previousDocState: null,
    _lastEmittedWireKind: null,
    _abortController: null,
    _activeTurnPromise: null,
    suggestions: new Map(),
    annotationGroups: [],
    patchVerdicts: new Map(),
    patchValidationResults: new Map(),
    docDraftBaseSections: null,
    docDraftBaseVersion: null,
    docDraftBaseDoc: null,
    docDraftCandidateSections: null,
    docDraftCandidateDoc: null,
    suggestionBaseDoc: null,
    suggestionBaseVersion: null,
    seqCounters: new Map(),
    materials: new Map(),
    folderSources: new Map(),
    todos: [],
    lastSyncedDocumentSnapshot: 0,
    selectedSkills: [],
    selectedSkillsHadSelection: false,
    _directionChangeAskedSinceLastWrite: false,
    _askUserSuspendCount: 0,
    _workingMemorySnapshot: null,
    _workingMemorySnapshotLoaded: false,
    _workingMemorySnapshotPersistable: false,
    _workingMemoryUpdatedThisSession: false,
    _suspendedThisTurn: false,
    _suspensionOwner: null,
    pendingConfirms: new Map(),
    chatHistory: [],
  };
}

export function recordSuspension(
  state: SessionState,
  owner: SuspensionOwner,
): void {
  state.runId = owner.runId;
  state.toolCallId = owner.toolCallId;
  state._suspendedThisTurn = true;
  state._suspensionOwner = owner;
}

export function clearSuspension(state: SessionState): void {
  state.runId = null;
  state.toolCallId = null;
  state._suspendedThisTurn = false;
  state._suspensionOwner = null;
}

export type SuspensionLiveness =
  | { kind: "none"; owner: null; spec: null }
  | { kind: "active"; owner: SuspensionOwner; spec: ToolCallSpec }
  | { kind: "orphan"; owner: SuspensionOwner; spec: null }
  | { kind: "absent"; owner: SuspensionOwner; spec: null }
  | { kind: "terminal"; owner: SuspensionOwner; spec: ToolCallSpec };

function findSuspensionOwnerToolCall(
  state: SessionState,
  owner: SuspensionOwner,
): ToolCallSpec | null {
  for (const message of state.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === owner.toolCallId &&
        part.data.name === owner.toolName
      ) {
        return part.data;
      }
    }
  }
  return null;
}

function isLiveSuspensionToolCall(spec: ToolCallSpec): boolean {
  // pending / running 的挂起工具都算 live(含 askUser)。askUser 不再额外要求 questions>0:
  // getSuspensionLiveness 已先用 runId/toolCallId 与 owner 匹配排除孤儿/旧残留,活跃挂起即使
  // questions 暂空(挂起瞬间问卷未回写/流式中断)也应保持 live → 前端渲染骨架卡,否则恢复时
  // 活跃反问会被判 terminal 清掉(刷新丢卡回归)。
  return spec.status.kind === "pending" || spec.status.kind === "running";
}

export function getSuspensionLiveness(state: SessionState): SuspensionLiveness {
  const owner = state._suspensionOwner;
  if (!owner) return { kind: "none", owner: null, spec: null };

  if (state.runId !== owner.runId || state.toolCallId !== owner.toolCallId) {
    return { kind: "orphan", owner, spec: null };
  }

  const spec = findSuspensionOwnerToolCall(state, owner);
  if (!spec) return { kind: "absent", owner, spec: null };
  if (isLiveSuspensionToolCall(spec)) return { kind: "active", owner, spec };
  return { kind: "terminal", owner, spec };
}

export function clearStaleSuspensionIfInactive(state: SessionState): boolean {
  const liveness = getSuspensionLiveness(state);
  if (liveness.kind === "active" || liveness.kind === "none") return false;
  clearSuspension(state);
  return true;
}

export function hasActiveSuspension(state: SessionState): boolean {
  return getSuspensionLiveness(state).kind === "active";
}

export function getActiveSuspensionOwner(state: SessionState): SuspensionOwner | null {
  return hasActiveSuspension(state) ? state._suspensionOwner ?? null : null;
}

export function activeSuspensionOwnedBy(
  state: SessionState,
  streamId: string,
): boolean {
  return hasActiveSuspension(state) && state._suspensionOwner?.streamId === streamId;
}

/**
 * Append a MessagePart to an existing ChatMessage in chatHistory.
 * For thinking parts, merges steps into the existing thinking part
 * with the same id (since thinking arrives as deltas).
 */
export function appendPartToChatHistory(
  state: SessionState,
  messageId: string,
  part: MessagePart,
): void {
  const msg = state.chatHistory.find((m) => m.id === messageId);
  if (!msg) return;

  if (part.kind === "thinking") {
    // Merge thinking deltas: find existing thinking part with same id
    const existing = msg.parts.find(
      (p) => p.kind === "thinking" && p.data.id === part.data.id,
    );
    if (existing && existing.kind === "thinking") {
      existing.data.steps.push(...part.data.steps);
    } else {
      msg.parts.push(part);
    }
  } else if (part.kind === "text") {
    // Merge consecutive text parts (streaming deltas) into one
    const last = msg.parts[msg.parts.length - 1];
    if (last && last.kind === "text") {
      last.data.body += part.data.body;
    } else {
      msg.parts.push({ kind: "text", data: { body: part.data.body } });
    }
  } else if (part.kind === "toolCall") {
    upsertToolCallPartInMessage(msg, part);
  } else {
    msg.parts.push(part);
  }
}

function replaceToolCallPartInMessage(
  msg: ChatMessage,
  part: Extract<MessagePart, { kind: "toolCall" }>,
): boolean {
  let replaced = false;
  const nextParts: MessagePart[] = [];
  for (const existing of msg.parts) {
    if (existing.kind === "toolCall" && existing.data.id === part.data.id) {
      if (!replaced) {
        nextParts.push(part);
        replaced = true;
      }
      continue;
    }
    nextParts.push(existing);
  }
  if (replaced) {
    msg.parts = nextParts;
  }
  return replaced;
}

function upsertToolCallPartInMessage(
  msg: ChatMessage,
  part: Extract<MessagePart, { kind: "toolCall" }>,
): void {
  if (!replaceToolCallPartInMessage(msg, part)) {
    msg.parts.push(part);
  }
}

/**
 * Update a toolCall part in chatHistory to reflect its final status/result.
 */
export function updateToolCallInChatHistory(
  state: SessionState,
  messageId: string,
  toolCallId: string,
  spec: import("@qingagent/contract-ts").ToolCallSpec,
): void {
  // miss 不再静默吞:找不到目标消息/toolCall part 时 warn(H2)。前端 toolCallUpdated
  // 同样"只更新不新建",静默 miss 会埋掉"药丸没 append 却发了 update"这类协议破绽
  // (P6 的 dup-result 防御对未 append 的 toolCallId 发 update 正是常态场景)。
  const msg = state.chatHistory.find((m) => m.id === messageId);
  if (!msg) {
    console.warn("updateToolCallInChatHistory: message not found", {
      messageId,
      toolCallId,
      toolName: spec.name,
    });
    return;
  }

  if (replaceToolCallPartInMessage(msg, { kind: "toolCall", data: spec })) {
    return;
  }
  console.warn("updateToolCallInChatHistory: toolCall part not found", {
    messageId,
    toolCallId,
    toolName: spec.name,
  });
}

/**
 * 把审阅提交终态写回原 patchSummary，而不是只依赖本次页面内 reducer。
 * chatHistory 会随 thread metadata 持久化，因此 reload 后仍能区分“已写入”与
 * “冲突回滚”；同时 fail-closed，迟到的失败结算不得覆盖已确认成功的摘要。
 */
export function updatePatchSummaryOutcomeInChatHistory(
  state: SessionState,
  hunkIds: readonly string[],
  reviewOutcome: "failed" | "committed",
  appliedCount?: number,
  conflictCount?: number,
): boolean {
  const targetIds = new Set(hunkIds);
  if (targetIds.size === 0) return false;

  for (let messageIndex = state.chatHistory.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = state.chatHistory[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex]!;
      if (part.kind !== "patchSummary") continue;
      if (!part.data.hunkIds.some((id) => targetIds.has(id))) continue;
      if (reviewOutcome === "failed" && part.data.reviewOutcome === "committed") {
        return false;
      }
      part.data.reviewOutcome = reviewOutcome;
      if (reviewOutcome === "committed" && appliedCount !== undefined) {
        part.data.appliedCount = appliedCount;
      } else {
        delete part.data.appliedCount;
      }
      if (reviewOutcome === "committed" && conflictCount !== undefined) {
        part.data.conflictCount = conflictCount;
      } else {
        delete part.data.conflictCount;
      }
      return true;
    }
  }
  return false;
}

export interface ToolCallUpdate {
  messageId: string;
  toolCallId: string;
  spec: ToolCallSpec;
}

export function terminalizeAskUserToolCall(
  state: SessionState,
  toolCallId: string,
  reason: string,
): ToolCallUpdate | null {
  for (const msg of state.chatHistory) {
    for (let i = 0; i < msg.parts.length; i++) {
      const part = msg.parts[i]!;
      if (
        part.kind !== "toolCall" ||
        part.data.id !== toolCallId ||
        !isQuestionnaireTool(part.data.name)
      ) {
        continue;
      }
      if (part.data.status.kind === "done" || part.data.status.kind === "failed") {
        return null;
      }
      const spec: ToolCallSpec = {
        ...part.data,
        status: {
          kind: "failed",
          data: { retriable: false, reason },
        },
      };
      msg.parts[i] = { kind: "toolCall", data: spec };
      return { messageId: msg.id, toolCallId, spec };
    }
  }
  return null;
}

/** Get the next seq number for a given message. */
export function nextSeq(state: SessionState, messageId: string): number {
  const current = state.seqCounters.get(messageId) ?? 0;
  const next = current + 1;
  state.seqCounters.set(messageId, next);
  return next;
}
