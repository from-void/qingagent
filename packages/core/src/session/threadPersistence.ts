import type { CoreMessage } from "ai";
import type {
  ChatMessage,
  DocSuggestion,
  FolderSourceRecord,
  LegacySection,
  DocState,
  MessagePart,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import { getPmContentHash, legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";
import type { StorageThreadType } from "@mastra/core/memory";
import { SpanType } from "@mastra/core/observability";
import { constants as fsConstants } from "node:fs";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { mastra, getObservability } from "../mastra.js";
import type {
  SuggestionRecord,
  SessionState,
  PersistAuditSnapshot,
  SuspensionOwner,
  OmSidecarCursor,
} from "./sessionState.js";
import { sessionIdToTraceId } from "../agent-run/agentSpans.js";
import type { Material } from "../types/material.js";
import { documentRepo, type DocumentRow } from "@qingagent/db";
import { deleteDocumentFamily } from "@qingagent/db";
import {
  getMinDocumentSnapshotVersion,
  getVersionSnapshot,
  insertVersion,
} from "@qingagent/db";
import { documentDraftRepo } from "@qingagent/db";
import { rehydratePendingDraft } from "../doc-engine/pendingDraftRehydrate.js";
import { getDocumentVersionCommittedAt } from "../doc-engine/commitDocumentOp.js";
import {
  normalizePersistedDocStateKind,
  normalizeRestoredDocStateKind,
} from "../doc-engine/docStateTransitions.js";
import {
  withWriteRetry,
} from "@qingagent/db";
import {
  appendMissingAskUserAnswerMessagesFromChatHistory,
  appendMissingVisibleAskUserAnswerMessagesFromChatHistory,
} from "../agent-run/askUserAnswerMessage.js";
import {
  browserFolderSourcesEnabled,
  localFolderSourcesEnabled,
  normalizeFolderSourceRecords,
  registerSessionFolderSources,
  unregisterSessionFolderSources,
} from "../folderSources/runtime.js";
import {
  isQuestionnaireTool,
  normalizeQuestionnaireSpecForRestore,
} from "../agent-run/questionnaireTools.js";
import { clearSessionSnapshot } from "../llm/modelConfig.js";
import { clearQuestionBranch } from "../services/genService.js";

const logger = mastra.getLogger();
export const QINGAGENT_RESOURCE_ID = "qingagent-user";
const LEGACY_RESOURCE_ID = "user-default";
const PRIMARY_METADATA_WRITE_MAX_ATTEMPTS = 5;
const PRIMARY_METADATA_WRITE_INITIAL_BACKOFF_MS = 50;
const SCHEDULE_PERSIST_MAX_ATTEMPTS = 3;
const SCHEDULE_PERSIST_INITIAL_BACKOFF_MS = 50;
const CONTENT_TIME_EPOCH = "1970-01-01T00:00:00.000Z";

/** 把任意日期输入收敛成可安全输出的 ISO 字符串；非法值返回 null。 */
function parseValidTimestamp(value: unknown): string | null {
  try {
    const timestamp = value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : typeof value === "number"
          ? value
          : Number.NaN;
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function frozenThreadUpdatedAt(thread: StorageThreadType): string {
  return parseValidTimestamp(thread.updatedAt)
    ?? parseValidTimestamp(thread.createdAt)
    ?? CONTENT_TIME_EPOCH;
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

/** Serialised material entry for JSON round-trip (Map -> Array). */
export interface MaterialRecord {
  id: string;
  filename: string;
  mimeType: string;
  text: string;
  summary: string | null;
  visionSummary?: string;
  fileId: string | null;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
    /** 抓取类素材的来源 URL(上传类为 null/缺省),溯源用。 */
    sourceUrl?: string | null;
    /** 缺省按 ready 处理，兼容旧会话数据。 */
    parseState?: "ready" | "error";
    /** 解析失败时的友好错误文案。 */
    parseError?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface SuggestionRecordJson extends SuggestionRecord {
  id: string;
}

/**
 * Shape of the JSON blob stored in thread.metadata.
 * Persists restorable session state; document body is mirrored from the documents table.
 */
export interface QingagentThreadMetadata {
  docId?: string;
  docState: DocState;
  docVersion: number;
  /** 仅文档 op 成功创建新版本时推进；首页排序不再依赖 thread.updatedAt。 */
  lastContentEditedAt?: string | null;
  lastSyncedDocumentSnapshot: number;
  doc?: PmDoc;
  legacySections: LegacySection[];
  materials: MaterialRecord[];
  folderSources?: FolderSourceRecord[];
  title: string;
  titlePinned?: boolean;
  runId: string | null;
  toolCallId: string | null;
  previousDocState?: DocState | null;
  /** Monotonic user turn counter for stable sidecar message ids. */
  turnCounter?: number;
  /** Last stable sidecar cursor persisted after OM message handoff. */
  omSidecarCursor?: OmSidecarCursor | null;
  /** Cumulative stable sidecar ids covered by active OM observations. */
  omObservedMessageIds?: string[];
  /** Single-way latch for compressed OM model projection. */
  omCompressionActive?: boolean;
  omCompressionEpoch?: number;
  omCompressionSnapshot?: {
    epoch: number;
    observations: string;
    removedMessageIds: string[];
  } | null;
  branchTitleGenerated?: boolean;
  askUserCompleted: boolean;
  askUserAsked?: boolean;
  directionChangeAskedSinceLastWrite?: boolean;
  selectedSkills?: string[];
  selectedSkillsHadSelection?: boolean;
  suggestions?: SuggestionRecordJson[];
  patchVerdicts?: Record<string, "accepted" | "rejected">;
  /** Fallback conversation history if Mastra memory recall is unavailable. */
  messages?: CoreMessage[];
  /** Frozen Working Memory snapshot for this session. Null is meaningful when loaded with no WM. */
  workingMemorySnapshot?: string | null;
  /** Whether the session has already frozen its Working Memory snapshot. */
  workingMemorySnapshotLoaded?: boolean;
  /** Rich chat history with full parts (text, thinking, toolCall) for session restore.
   *  Thinking content is stripped to word counts to save space. */
  chatHistory?: ChatMessage[];
  /** Lightweight summary for home page listing — avoids parsing full legacySections. */
  threadSummary?: {
    sectionCount: number;
    wordCount: number;
    status: string;
    materialCount: number;
  };
  /** Audit marker written by the documents migration; never used for branching. */
  migratedToDocumentsAt?: string;
  lastPersistedAt: string;
}

export interface ThreadSummary {
  sectionCount: number;
  wordCount: number;
  status: string;
  materialCount: number;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serializeMaterial(m: Material): MaterialRecord {
  return {
    id: m.id,
    filename: m.filename,
    mimeType: m.mimeType,
    text: m.text,
    summary: m.summary,
    ...(typeof m.visionSummary === "string" ? { visionSummary: m.visionSummary } : {}),
    fileId: m.fileId,
    metadata: m.metadata,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizeParseState(value: unknown): "ready" | "error" {
  return value === "error" ? "error" : "ready";
}

function deserializeMaterials(records: unknown): Map<string, Material> {
  const map = new Map<string, Material>();
  if (!Array.isArray(records)) return map;
  for (const r of records) {
    if (!isRecord(r)) continue;
    if (
      !isNonEmptyString(r.id) ||
      !isNonEmptyString(r.filename) ||
      !isNonEmptyString(r.mimeType) ||
      typeof r.text !== "string" ||
      !isNullableString(r.summary) ||
      !isNullableString(r.fileId) ||
      !isRecord(r.metadata) ||
      !isNonEmptyString(r.createdAt) ||
      !isNonEmptyString(r.updatedAt)
    ) {
      continue;
    }
    const metadata = r.metadata;
    const parseError = isNullableString(metadata.parseError) ? metadata.parseError : undefined;
    const visionSummary = typeof r.visionSummary === "string" ? r.visionSummary : undefined;
    map.set(r.id, {
      id: r.id,
      filename: r.filename,
      mimeType: r.mimeType,
      text: r.text,
      summary: r.summary,
      ...(visionSummary !== undefined ? { visionSummary } : {}),
      fileId: r.fileId,
      metadata: {
        ...metadata,
        pages: typeof metadata.pages === "number" || metadata.pages === null
          ? metadata.pages
          : null,
        wordCount: typeof metadata.wordCount === "number" ? metadata.wordCount : 0,
        title: typeof metadata.title === "string" || metadata.title === null
          ? metadata.title
          : null,
        sourceUrl: typeof metadata.sourceUrl === "string" || metadata.sourceUrl === null
          ? metadata.sourceUrl
          : undefined,
        parseState: normalizeParseState(metadata.parseState),
        ...(parseError !== undefined ? { parseError } : {}),
      },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return map;
}

function getSectionText(section: LegacySection): string {
  if (section.kind === "image") {
    return section.data.caption ?? section.data.alt;
  }
  if ("text" in section.data && typeof section.data.text === "string") {
    return section.data.text;
  }
  if ("body" in section.data && typeof section.data.body === "string") {
    return section.data.body;
  }
  return "";
}

function serializeSuggestions(
  suggestions: Map<string, SuggestionRecord>,
): SuggestionRecordJson[] {
  return Array.from(suggestions.entries()).map(([id, record]) => ({
    id,
    ...record,
  }));
}

function deserializeSuggestions(
  records: SuggestionRecordJson[] | undefined,
): Map<string, SuggestionRecord> {
  const map = new Map<string, SuggestionRecord>();
  for (const record of records ?? []) {
    const suggestion = record.suggestion as DocSuggestion | undefined;
    if (!suggestion?.id) continue;
    map.set(record.id, {
      messageId: record.messageId,
      toolCallId: record.toolCallId,
      before: record.before,
      after: record.after,
      blockIndex: record.blockIndex,
      suggestion,
      diffHunk: record.diffHunk,
    });
  }
  return map;
}

function serializePatchVerdicts(
  patchVerdicts: Map<string, "accepted" | "rejected">,
): Record<string, "accepted" | "rejected"> {
  return Object.fromEntries(patchVerdicts);
}

function deserializePatchVerdicts(
  verdicts: Record<string, "accepted" | "rejected"> | undefined,
): Map<string, "accepted" | "rejected"> {
  return new Map(Object.entries(verdicts ?? {}));
}

function deserializeOmSidecarCursor(value: unknown): OmSidecarCursor | null {
  if (!isRecord(value)) return null;
  const turnIndex = value.turnIndex;
  const seqInTurn = value.seqInTurn;
  if (!Number.isInteger(turnIndex) || !Number.isInteger(seqInTurn)) return null;
  if ((turnIndex as number) < 0 || (seqInTurn as number) < 0) return null;
  return { turnIndex: turnIndex as number, seqInTurn: seqInTurn as number };
}

function serializeOmObservedMessageIds(value: readonly string[] | undefined): string[] {
  if (!value || value.length === 0) return [];
  return Array.from(new Set(value.filter((id) => typeof id === "string" && id.length > 0)));
}

function deserializeOmObservedMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return serializeOmObservedMessageIds(value.filter((id): id is string => typeof id === "string"));
}

function serializeOmMetadata(state: SessionState): Partial<QingagentThreadMetadata> {
  const observedMessageIds = serializeOmObservedMessageIds(state.omObservedMessageIds);
  const hasOmState = state.turnCounter > 0 ||
    state.omSidecarCursor != null ||
    observedMessageIds.length > 0 ||
    state.omCompressionActive === true ||
    (state.omCompressionEpoch ?? 0) > 0;
  if (!hasOmState) return {};
  return {
    turnCounter: state.turnCounter,
    omSidecarCursor: state.omSidecarCursor ?? null,
    omObservedMessageIds: observedMessageIds,
    omCompressionActive: state.omCompressionActive === true,
    omCompressionEpoch: state.omCompressionEpoch ?? 0,
    omCompressionSnapshot: state.omCompressionSnapshot
      ? {
          epoch: state.omCompressionSnapshot.epoch,
          observations: state.omCompressionSnapshot.observations,
          removedMessageIds: [...state.omCompressionSnapshot.removedMessageIds],
        }
      : null,
  };
}

/**
 * Strip thinking content to save space but preserve word count
 * so "▸思考中 · N 字" renders correctly on restore.
 */
function stripThinkingContent(parts: MessagePart[]): MessagePart[] {
  return parts.map((p) => {
    if (p.kind !== "thinking") return p;
    const fullText = p.data.steps.join("");
    const wordCount = fullText.length;
    // Keep the part structure with a single step containing word count marker
    return {
      kind: "thinking" as const,
      data: {
        id: p.data.id,
        steps: [`[${wordCount}字]`],
      },
    };
  });
}

/**
 * Prepare chatHistory for persistence: strip thinking content to save space.
 */
function serializeChatHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: stripThinkingContent(m.parts),
  }));
}

function isRestorableMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value) || typeof value.kind !== "string" || !isRecord(value.data)) {
    return false;
  }
  if (value.kind === "text") {
    return typeof value.data.body === "string";
  }
  if (value.kind === "thinking") {
    return isNonEmptyString(value.data.id) &&
      Array.isArray(value.data.steps) &&
      value.data.steps.every((step) => typeof step === "string");
  }
  if (value.kind === "toolCall") {
    const spec = value.data;
    return isNonEmptyString(spec.id) &&
      isNonEmptyString(spec.name) &&
      isRecord(spec.status) &&
      typeof spec.status.kind === "string" &&
      isRecord(spec.body) &&
      typeof spec.body.kind === "string" &&
      isRecord(spec.body.data);
  }
  // 其余合法 part 种类（code / citation / image / patchSummary）只要结构上是
  // 带 string kind + record data 的对象就保留——只在这里对 text/thinking/toolCall 做
  // 额外严格校验,绝不能因为没枚举到某个合法 kind 就在恢复时静默丢弃真实历史。
  return true;
}

function deserializeChatHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || !isRecord(item.role) || !isNonEmptyString(item.ts)) {
      continue;
    }
    if (!Array.isArray(item.parts)) continue;
    const parts = item.parts
      .filter(isRestorableMessagePart)
      .map((part) => part.kind === "toolCall"
        ? { kind: "toolCall" as const, data: normalizeQuestionnaireSpecForRestore(part.data) }
        : part);
    if (parts.length === 0) continue;
    messages.push({
      ...(item as unknown as ChatMessage),
      parts,
    });
  }
  return messages;
}

interface RestoreToolCallFacts {
  hasOpenAskUserToolCall: boolean;
  openAskUserToolCallId: string | null;
  openAskUserToolCallIds: string[];
  openAskUserToolNamesById: Map<string, SuspensionOwner["toolName"]>;
}

function isOpenAskUserToolCall(spec: ToolCallSpec): boolean {
  return (
    isQuestionnaireTool(spec.name) &&
    (spec.status.kind === "pending" || spec.status.kind === "running")
  );
}

function scanRestoreToolCallFacts(messages: ChatMessage[]): RestoreToolCallFacts {
  let hasOpenAskUserToolCall = false;
  let openAskUserToolCallId: string | null = null;
  const openAskUserToolCallIds: string[] = [];
  const openAskUserToolNamesById = new Map<string, SuspensionOwner["toolName"]>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "toolCall") continue;
      if (isOpenAskUserToolCall(part.data)) {
        hasOpenAskUserToolCall = true;
        openAskUserToolCallId ??= part.data.id;
        openAskUserToolCallIds.push(part.data.id);
        openAskUserToolNamesById.set(part.data.id, part.data.name as SuspensionOwner["toolName"]);
      }
    }
  }

  return {
    hasOpenAskUserToolCall,
    openAskUserToolCallId,
    openAskUserToolCallIds,
    openAskUserToolNamesById,
  };
}

function staleRestoreStatus(
  spec: ToolCallSpec,
  opts: { preserveOpenAskUserToolCallId?: string | null } = {},
): ToolCallSpec["status"] | null {
  if (isOpenAskUserToolCall(spec)) {
    if (spec.id === opts.preserveOpenAskUserToolCallId) {
      return null;
    }
    return {
      kind: "failed",
      data: { retriable: false, reason: "上次的确认已结束，请重新发起。" },
    };
  }

  // 兜底自愈:持久化里仍停在 running/pending 的非 askUser 工具——进程早结束了不可能还在跑
  // (典型成因:tool-error 没收口留下的卡死 spec)。恢复时切 done,旧会话重开 spinner 不再永久转。
  if (spec.status.kind === "running" || spec.status.kind === "pending") {
    return { kind: "done" };
  }

  return null;
}

function terminalizeStaleRestoreToolCalls(
  messages: ChatMessage[],
  opts: { preserveOpenAskUserToolCallId?: string | null } = {},
): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.kind !== "toolCall") return part;
      const status = staleRestoreStatus(part.data, opts);
      if (!status) return part;
      changed = true;
      messageChanged = true;
      return {
        kind: "toolCall" as const,
        data: { ...part.data, status },
      };
    });

    return messageChanged ? { ...message, parts } : message;
  });

  return changed ? next : messages;
}

export function summarizeDoc(state: SessionState): ThreadSummary {
  const wordCount = state.legacySections.reduce((acc, s) => {
    return acc + getSectionText(s).length;
  }, 0);

  const docStateKind = normalizePersistedDocStateKind(state);

  return {
    sectionCount: state.legacySections.length,
    wordCount: Math.round(wordCount / 1.5),
    status: docStateKind,
    materialCount: state.materials.size,
  };
}

function serializeMetadata(state: SessionState): QingagentThreadMetadata {
  const materialRecords = Array.from(state.materials.values()).map(serializeMaterial);
  const threadSummary = summarizeDoc(state);

  return {
    docId: state.docId,
    docState: { kind: normalizePersistedDocStateKind(state) },
    docVersion: state.docVersion,
    lastContentEditedAt: state.lastContentEditedAt,
    lastSyncedDocumentSnapshot: state.lastSyncedDocumentSnapshot,
    doc: state.doc,
    legacySections: state.legacySections,
    materials: materialRecords,
    folderSources: Array.from(state.folderSources.values()),
    title: state.title,
    ...(state.titlePinned ? { titlePinned: true } : {}),
    runId: state.runId,
    toolCallId: state.toolCallId,
    previousDocState: state.previousDocState,
    ...serializeOmMetadata(state),
    ...(state.branchTitleGenerated === true ? { branchTitleGenerated: true } : {}),
    askUserCompleted: state._askUserCompleted ?? false,
    askUserAsked: state._askUserAsked ?? false,
    directionChangeAskedSinceLastWrite: state._directionChangeAskedSinceLastWrite ?? false,
    selectedSkills: state.selectedSkills,
    selectedSkillsHadSelection: state.selectedSkillsHadSelection,
    suggestions: serializeSuggestions(state.suggestions),
    patchVerdicts: serializePatchVerdicts(state.patchVerdicts),
    messages: state.messages,
    workingMemorySnapshot: state._workingMemorySnapshot ?? null,
    workingMemorySnapshotLoaded:
      state._workingMemorySnapshotLoaded === true &&
      state._workingMemorySnapshotPersistable === true,
    chatHistory: serializeChatHistory(state.chatHistory),
    threadSummary,
    lastPersistedAt: new Date().toISOString(),
  };
}

function deserializeFolderSources(value: unknown): FolderSourceRecord[] {
  return Array.isArray(value) ? normalizeFolderSourceRecords(value) : [];
}

function filterFolderSourcesForSession(
  sessionId: string,
  sources: FolderSourceRecord[],
): FolderSourceRecord[] {
  return sources.filter((source) => {
    if (source.sessionId === sessionId) return true;
    logger.warn("Dropped restored folder source for mismatched session", {
      sessionId,
      sourceId: source.id,
      sourceSessionId: source.sessionId,
      provider: source.provider,
    });
    return false;
  });
}

async function verifyRestoredFolderSources(sources: FolderSourceRecord[]): Promise<FolderSourceRecord[]> {
  return Promise.all(sources.map(async (source) => {
    if (source.provider === "browser-fs-access" && source.status === "connected" && !browserFolderSourcesEnabled()) {
      return {
        ...source,
        status: "error",
        error: "当前环境不支持浏览器文件夹资料库",
        updatedAt: new Date().toISOString(),
      };
    }
    if (source.provider !== "desktop-local" || source.status !== "connected" || !source.desktopRootPath) {
      return source;
    }
    if (!localFolderSourcesEnabled()) {
      return {
        ...source,
        status: "error",
        error: "当前环境不支持本地文件夹资料库",
        updatedAt: new Date().toISOString(),
      };
    }
    try {
      const stats = await fsStat(source.desktopRootPath);
      if (!stats.isDirectory()) throw new Error("not_directory");
      await fsAccess(source.desktopRootPath, fsConstants.R_OK);
      return source;
    } catch {
      return {
        ...source,
        status: "missing",
        error: "本地文件夹不存在或无法访问",
        updatedAt: new Date().toISOString(),
      };
    }
  }));
}

type DocRowReadOutcome = "hit" | "miss" | "error";

const docRowReadStats: Record<DocRowReadOutcome, number> & { lastLoggedAt: number } = {
  hit: 0,
  miss: 0,
  error: 0,
  lastLoggedAt: Number.NEGATIVE_INFINITY,
};

function recordDocRowReadOutcome(
  outcome: DocRowReadOutcome,
  context: { sessionId: string; docId: string; error?: unknown },
): void {
  docRowReadStats[outcome]++;
  const now = Date.now();
  if (now - docRowReadStats.lastLoggedAt < 10_000) return;
  docRowReadStats.lastLoggedAt = now;

  try {
    logger.info("documents table restore read stats", {
      sessionId: context.sessionId,
      docId: context.docId,
      outcome,
      hit: docRowReadStats.hit,
      miss: docRowReadStats.miss,
      error: docRowReadStats.error,
      lastError: context.error instanceof Error ? context.error.message : undefined,
    });
  } catch {
    // 观测日志绝不能影响恢复主链路。
  }
}

function recordRestoreReconcileSpan(context: {
  sessionId: string;
  docId: string;
  metadataDocVersion: number | null;
  documentsDocVersion: number;
  resolution: "documents" | "metadata" | "conflict-rescue";
  lastPersistedAt: string | null;
}): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = sessionIdToTraceId(context.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "restore_reconcile",
      ...(traceId ? { traceId } : {}),
      metadata: {
        eventKind: "restore_reconcile",
        sessionId: context.sessionId,
        docId: context.docId,
      },
      input: {
        metadataDocVersion: context.metadataDocVersion,
        documentsDocVersion: context.documentsDocVersion,
        resolution: context.resolution,
        lastPersistedAt: context.lastPersistedAt,
      },
    });
    span.end({
      output: {
        winner: context.resolution === "metadata" ? "metadata" : "documents",
        resolution: context.resolution,
      },
    });
  } catch (err) {
    logger.warn("recordRestoreReconcileSpan failed (non-fatal)", {
      sessionId: context.sessionId,
      docId: context.docId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function applyRestoredDocumentRow(
  meta: QingagentThreadMetadata,
  docRow: DocumentRow,
): QingagentThreadMetadata {
  return {
    ...meta,
    docVersion: docRow.docVersion,
    doc: docRow.pmDoc,
    legacySections: docRow.legacySections,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unique|constraint/i.test(message);
}

async function rescueMetadataSnapshotOnRestoreConflict(input: {
  sessionId: string;
  docId: string;
  docVersion: number;
  metadataDoc: PmDoc;
  metadataHash: string;
}): Promise<void> {
  const versionId = `rescue-${input.docId}-${input.docVersion}-${input.metadataHash.slice(0, 8)}`;
  if (await getVersionSnapshot(versionId)) return;

  // 正常提交使用非负版本号；救援快照落在负空间，既不抢获胜方版本，也能按最小值继续递减。
  for (let attempt = 0; attempt < 2; attempt++) {
    const minVersion = await getMinDocumentSnapshotVersion(input.docId);
    const rescueDocVersion = Math.min(0, minVersion ?? 0) - 1;
    try {
      await insertVersion({
        versionId,
        docId: input.docId,
        docVersion: rescueDocVersion,
        contentHash: input.metadataHash,
        schemaVersion: input.metadataDoc.attrs.schemaVersion,
        actorType: "restore-rescue",
        summary: "恢复冲突败方快照",
        snapshotPm: input.metadataDoc,
        parentVersion: null,
        createdAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        logger.error("Failed to rescue metadata snapshot during restore conflict", {
          sessionId: input.sessionId,
          docId: input.docId,
          docVersion: input.docVersion,
          versionId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // 仅 version_id 已实际入库时才是幂等成功；doc_version 撞号要重新取最小值再试。
      if (await getVersionSnapshot(versionId)) return;
      if (attempt === 0) continue;

      logger.error("Failed to rescue metadata snapshot during restore conflict", {
        sessionId: input.sessionId,
        docId: input.docId,
        docVersion: input.docVersion,
        versionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

async function hasMatchingRestoreDraft(input: {
  docId: string;
  docVersion: number;
  doc: PmDoc | undefined;
}): Promise<boolean> {
  if (!input.doc) return false;
  try {
    const row = await documentDraftRepo.load(input.docId);
    if (!row || row.status === "conflict") return false;
    if (row.status !== "pending_review" && row.status !== "draft_candidate") {
      return false;
    }
    return row.baseVersion === input.docVersion && row.baseHash === getPmContentHash(input.doc);
  } catch (err) {
    logger.warn("Failed to inspect document_drafts during restore reconcile", {
      docId: input.docId,
      docVersion: input.docVersion,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thread CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new Mastra thread for this session.
 * Called from bridgeHandler's startSession handler.
 */
export async function createSessionThread(
  sessionId: string,
  title?: string,
  initial?: Pick<QingagentThreadMetadata, "workingMemorySnapshot" | "workingMemorySnapshotLoaded"> & {
    createdAt?: string;
  },
): Promise<void> {
  const memory = mastra.getMemory("default");
  if (!memory) return;

  const createdAt = parseValidTimestamp(initial?.createdAt) ?? new Date().toISOString();

  const initialMeta: QingagentThreadMetadata = {
    docId: sessionId,
    docState: { kind: "empty" },
    docVersion: 0,
    lastContentEditedAt: createdAt,
    lastSyncedDocumentSnapshot: 0,
    legacySections: [],
    materials: [],
    folderSources: [],
    title: title ?? "",
    runId: null,
    toolCallId: null,
    askUserCompleted: false,
    askUserAsked: false,
    directionChangeAskedSinceLastWrite: false,
    workingMemorySnapshot: initial?.workingMemorySnapshot ?? null,
    workingMemorySnapshotLoaded: initial?.workingMemorySnapshotLoaded === true,
    lastPersistedAt: createdAt,
  };

  await memory.saveThread({
    thread: {
      id: sessionId,
      title: title ?? "",
      resourceId: QINGAGENT_RESOURCE_ID,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
      metadata: initialMeta as unknown as Record<string, unknown>,
    },
  });
}

/**
 * Per-session persist queue.  Each session's persists are chained so that a
 * later call always waits for the previous write to finish before starting.
 * This prevents a slow early persist from overwriting a fast later persist
 * (race condition that caused the last thinking bubble to be lost on restore).
 */
const persistQueues = new Map<string, Promise<void>>();
const persistDirty = new Map<string, boolean>();
const persistLoops = new Map<string, Promise<void>>();
const pendingPersists = new Map<string, { state: SessionState; reason: string }>();
const deletedSessions = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  deletedSessions.add(sessionId);
}

export function unmarkSessionDeleted(sessionId: string): void {
  deletedSessions.delete(sessionId);
}

export function isSessionDeleted(sessionId: string): boolean {
  return deletedSessions.has(sessionId);
}

function hasDirtySession(): boolean {
  for (const dirty of persistDirty.values()) {
    if (dirty) return true;
  }
  return false;
}

function timeoutPromise(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function retryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : "";
  return /thread not found|not_found|no thread/i.test(`${code} ${message}`);
}

async function waitForInitialThreadCreate(state: SessionState, reason: string): Promise<void> {
  const promise = state.threadCreatePromise;
  if (!promise) return;
  try {
    await promise;
  } catch (err) {
    logger.error("Initial session thread creation failed before metadata persist", {
      sessionId: state.sessionId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Layer ④ — DB 写入审计 span（阶段3）
// ---------------------------------------------------------------------------

/**
 * 从「即将写库的 meta」（serializeMetadata 的结果）计算关键字段摘要（只取摘要 /
 * 计数 / id，绝不含文档正文）。
 *
 * 关键：从 `meta`（写库快照）而非 live state 计算，避免 await 期间 state 被并发
 * 修改导致基线推进到一份从未真正写入的快照（修代码评审阻断项 #1）。
 * meta.docState.kind 已是 serializeMetadata normalizer 的最终落库值，无需再校正。
 */
function snapshotFromMeta(meta: QingagentThreadMetadata): PersistAuditSnapshot {
  const suggestionIds = (meta.suggestions ?? []).map((p) => p.id);
  const verdicts = meta.patchVerdicts ?? {};
  // 阶段4 follow-up — verdict 内容签名：按 patchId 排序后拼 `id:verdict`，使同数量但
  // verdict 内容变化（accept→reject）也能被 diff 识别。小字符串，不含文档正文。
  const patchVerdictSig = Object.entries(verdicts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, verdict]) => `${id}:${verdict}`)
    .join("|");
  const folderSourceIds = deserializeFolderSources(meta.folderSources).map((source) => source.id).sort();
  return {
    docStateKind: meta.docState.kind,
    docVersion: meta.docVersion,
    suggestionCount: suggestionIds.length,
    suggestionIds,
    patchVerdictCount: Object.keys(verdicts).length,
    folderSourceCount: folderSourceIds.length,
    folderSourceIds,
    patchVerdictSig,
  };
}

/**
 * 对比前后两份快照，列出真正发生变化的字段名。无变化返回空数组（调用方据此
 * 跳过记 span，避免「每次 persist 都记」的噪音）。
 */
function diffPersistSnapshots(
  before: PersistAuditSnapshot | undefined,
  after: PersistAuditSnapshot,
): string[] {
  if (!before) {
    // 首次持久化：没有基线，记一条「首次落库」，把所有摘要字段列为变化。
    return ["docStateKind", "docVersion", "suggestions", "patchVerdicts", "folderSources"];
  }
  const changed: string[] = [];
  if (before.docStateKind !== after.docStateKind) changed.push("docStateKind");
  if (before.docVersion !== after.docVersion) changed.push("docVersion");
  // suggestions 计数或 id 集合（顺序敏感即可，id 是稳定追加）变化都算变化。
  if (
    before.suggestionCount !== after.suggestionCount ||
    before.suggestionIds.length !== after.suggestionIds.length ||
    before.suggestionIds.some((id, i) => id !== after.suggestionIds[i])
  ) {
    changed.push("suggestions");
  }
  // 阶段4 follow-up — patchVerdict 不仅比数量，也比内容签名：同数量但 verdict 变化
  // （accept→reject）也算变更。count 与 sig 任一不同都归为单一 "patchVerdicts"（合并
  // 命名，避免 count/内容两条冗余字段；sig 已覆盖 count 变化，count 比较留作冗余保险）。
  if (
    before.patchVerdictCount !== after.patchVerdictCount ||
    before.patchVerdictSig !== after.patchVerdictSig
  ) {
    changed.push("patchVerdicts");
  }
  if (
    before.folderSourceCount !== after.folderSourceCount ||
    before.folderSourceIds.length !== after.folderSourceIds.length ||
    before.folderSourceIds.some((id, i) => id !== after.folderSourceIds[i])
  ) {
    changed.push("folderSources");
  }
  return changed;
}

/**
 * Layer ④：在 thread.metadata 真正写入成功、且关键字段确有变化时，记一条
 * `SpanType.GENERIC`（name=`db_write`）审计 span。
 *
 * 设计要点：
 * - 仅当 changedFields 非空时记，避免「每次 persist 都记」的噪音。
 * - before/after 只放摘要（docStateKind / docVersion / suggestion id 与计数 /
 *   patchVerdict 计数），**绝不放文档正文**。
 * - traceId 用 `sessionIdToTraceId(sessionId)`，与同会话的 command / llm_response /
 *   框架 span 落在同一条 trace。
 * - metadata.clientTraceId 透传单次动作关联 id（阶段4a）。
 * - 整段 try/catch：span 失败绝不能影响持久化主链路（持久化是主链路）。
 */
function recordDbWriteSpan(
  state: SessionState,
  before: PersistAuditSnapshot | undefined,
  after: PersistAuditSnapshot,
  changedFields: string[],
): void {
  try {
    if (changedFields.length === 0) return;
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;

    const traceId = sessionIdToTraceId(state.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "db_write",
      ...(traceId ? { traceId } : {}),
      metadata: {
        eventKind: "db_write",
        sessionId: state.sessionId,
        threadId: state.threadId,
        clientTraceId: state.clientTraceId,
        origin: state.origin ?? "manual",
      },
      input: { changedFields },
    });
    span.end({
      output: {
        before: before ?? null,
        after,
      },
    });
  } catch (err) {
    logger.warn("recordDbWriteSpan failed (non-fatal)", {
      sessionId: state.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Persist current session state to thread metadata.
 * 写入失败会记录日志并向调用方抛出，避免上层把未落盘误判为成功。
 *
 * Calls are serialised per session: if a persist is already in-flight for
 * this session, the new persist waits for it to finish first. This ensures
 * the LAST caller always writes last, so no stale intermediate state can
 * overwrite a more-recent snapshot.
 */
export async function persistSessionMetadata(
  state: SessionState,
  reason = "direct",
): Promise<void> {
  const sid = state.sessionId;
  const prev = persistQueues.get(sid) ?? Promise.resolve();

  // 前一笔失败已经向它自己的调用方抛出；当前写仍要继续执行，不能让拒绝态永久
  // 毒化这个 session 的串行队列。
  const current = prev.catch(() => undefined).then(async () => {
    try {
      const memory = mastra.getMemory("default");
      if (!memory) return;

      await waitForInitialThreadCreate(state, reason);
      if (isSessionDeleted(sid)) {
        logger.info("Skipping metadata persist for deleted session", { sessionId: sid, reason });
        return;
      }
      const meta = serializeMetadata(state);
      // Layer ④ — DB 写入审计：从「即将写入的 meta」快照关键字段（在 await 之前，
      // 锁定本次真正写库的值），避免 await 期间 state 并发修改导致基线漂移。
      const before = state._lastPersistSnapshot;
      const after = snapshotFromMeta(meta);
      try {
        await withWriteRetry(
          () =>
            memory.updateThread({
              id: state.sessionId,
              title: state.title || "",
              metadata: meta as unknown as Record<string, unknown>,
            }),
          PRIMARY_METADATA_WRITE_MAX_ATTEMPTS,
          PRIMARY_METADATA_WRITE_INITIAL_BACKOFF_MS,
        );
      } catch (err) {
        if (!isThreadNotFoundError(err)) throw err;
        if (isSessionDeleted(sid)) {
          logger.info("Refusing to recreate deleted session thread", {
            sessionId: sid,
            reason,
          });
          return;
        }
        logger.warn("Primary metadata update missed thread; falling back to saveThread", {
          sessionId: state.sessionId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        const now = new Date();
        await memory.saveThread({
          thread: {
            id: state.sessionId,
            title: state.title || "",
            resourceId: state.resourceId || QINGAGENT_RESOURCE_ID,
            createdAt: now,
            updatedAt: now,
            metadata: meta as unknown as Record<string, unknown>,
          },
        });
      }

      if (isSessionDeleted(sid)) {
        logger.info("Skipping derived documents persist for deleted session", {
          sessionId: sid,
          reason,
        });
        return;
      }

      // 0702 review Lane A:影子写必须整体使用 serializeMetadata 时刻的快照(meta.doc),
      // 不能晚读活引用 state.doc——updateThread await 期间若发生 updateDoc 提交,
      // 会把「新内容 + 旧 docVersion」的错位对写进 documents(documentRepo.save 的
      // 版本守卫能挡住版本回退,但等版本+内容变化分支仍可能放行错位内容)。
      // 快照一致后,期间的新变更由 schedulePersist 的 dirty 循环下一轮补写。
      // documents 只保存正文及其从 Mastra thread 派生出的缓存字段。即使其短暂不可用，
      // 也不能让熔断器永久跳过后续同步；每次权威元数据落库后都尝试收敛一次。
      if (meta.doc) {
        try {
          await documentRepo.save({
            id: meta.docId ?? state.sessionId,
            threadId: state.threadId ?? state.sessionId,
            resourceId: state.resourceId,
            title: meta.title,
            docState: meta.docState.kind,
            docVersion: meta.docVersion,
            lastSyncedVersion: meta.lastSyncedDocumentSnapshot,
            legacySections: meta.legacySections,
            pmDoc: meta.doc,
            createdAt: meta.lastPersistedAt,
            updatedAt: meta.lastPersistedAt,
          });
        } catch (shadowErr) {
          logger.warn("Derived documents write failed; it will be reconciled from Mastra metadata", {
            sessionId: state.sessionId,
            error: shadowErr instanceof Error ? shadowErr.message : String(shadowErr),
          });
        }
      }

      // write 成功后再 diff + 记 span。基线只在确有变化时推进到「本次写入的」
      // 快照，避免 write 失败重试漏记。span 失败已在内部 try/catch 吞掉，绝不
      // 影响主链路。
      const changedFields = diffPersistSnapshots(before, after);
      if (changedFields.length > 0) {
        recordDbWriteSpan(state, before, after, changedFields);
        state._lastPersistSnapshot = after;
      }
    } catch (err) {
      logger.error("Failed to persist session metadata", {
        sessionId: state.sessionId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  persistQueues.set(sid, current);

  // Clean up the queue entry when this persist completes so the map
  // doesn't grow unboundedly across sessions.
  const cleanup = () => {
    if (persistQueues.get(sid) === current) {
      persistQueues.delete(sid);
    }
  };
  // 不用 current.finally(cleanup)：finally 会派生一个无人消费的拒绝 Promise，
  // 在真实写失败时触发 unhandledRejection。
  void current.then(cleanup, cleanup);

  return current;
}

export function schedulePersist(state: SessionState, reason = "unspecified"): Promise<void> {
  const sid = state.sessionId;
  if (isSessionDeleted(sid)) {
    return Promise.resolve();
  }
  persistDirty.set(sid, true);
  pendingPersists.set(sid, { state, reason });

  const existing = persistLoops.get(sid);
  if (existing) {
    return existing.then(async () => {
      const next = persistLoops.get(sid);
      if (next && next !== existing) {
        await next;
      }
    });
  }

  let loop!: Promise<void>;
  loop = (async () => {
    let exhaustedRetries = false;
    try {
      while (persistDirty.get(sid)) {
        if (isSessionDeleted(sid)) {
          persistDirty.set(sid, false);
          break;
        }
        let lastError: unknown;
        for (let attempt = 1; attempt <= SCHEDULE_PERSIST_MAX_ATTEMPTS; attempt += 1) {
          if (isSessionDeleted(sid)) {
            persistDirty.set(sid, false);
            lastError = undefined;
            break;
          }
          // 写前清除本轮快照的 dirty；写入期间的新变更会重新置 dirty。失败时必须
          // 立即回置，确保未保存标记不会被当成成功清掉。
          persistDirty.set(sid, false);
          try {
            await persistSessionMetadata(state, reason);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            if (isSessionDeleted(sid)) {
              persistDirty.set(sid, false);
              lastError = undefined;
              break;
            }
            persistDirty.set(sid, true);
            if (attempt < SCHEDULE_PERSIST_MAX_ATTEMPTS) {
              await retryDelay(SCHEDULE_PERSIST_INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
            }
          }
        }

        if (lastError !== undefined) {
          exhaustedRetries = true;
          logger.error("Scheduled session metadata persist exhausted retries; session remains dirty", {
            sessionId: sid,
            reason,
            attempts: SCHEDULE_PERSIST_MAX_ATTEMPTS,
            error: lastError instanceof Error ? lastError.message : String(lastError),
          });
          throw lastError;
        }
      }
    } finally {
      if (persistLoops.get(sid) === loop) {
        persistLoops.delete(sid);
        if (persistDirty.get(sid) && !exhaustedRetries) {
          void schedulePersist(state, "reschedule_after_loop_finally").catch((err) => {
            logger.error("Failed to reschedule dirty session metadata persist", {
              sessionId: sid,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          if (!persistDirty.get(sid)) {
            persistDirty.delete(sid);
            pendingPersists.delete(sid);
          }
        }
      }
    }
  })();

  persistLoops.set(sid, loop);
  return loop;
}

export async function drainSessionPersistence(timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const drain = async () => {
    while (persistLoops.size > 0 || hasDirtySession()) {
      let loops = Array.from(new Set(persistLoops.values()));
      if (loops.length === 0) {
        for (const [sid, pending] of pendingPersists) {
          if (persistDirty.get(sid)) {
            const drainReason = pending.reason.startsWith("shutdown_drain:")
              ? pending.reason
              : `shutdown_drain:${pending.reason}`;
            void schedulePersist(pending.state, drainReason).catch(() => {
              // allSettled(loops) 负责消费拒绝；这里仅避免 fire-and-forget 窗口。
            });
          }
        }
        loops = Array.from(new Set(persistLoops.values()));
        if (loops.length === 0) break;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`drainSessionPersistence timed out after ${timeoutMs}ms`);
      }
      await Promise.race([
        Promise.allSettled(loops),
        timeoutPromise(remainingMs, "drainSessionPersistence"),
      ]);
    }
  };

  try {
    await drain();
  } catch (err) {
    const sessionIds = Array.from(persistDirty)
      .filter(([, dirty]) => dirty)
      .map(([sid]) => sid);
    logger.error("会话持久化 drain 超时，仍有未保存会话", {
      timeoutMs,
      unsavedSessionCount: sessionIds.length,
      sessionIds,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function drainSessionPersistenceForSession(
  sessionId: string,
  timeoutMs = 4_000,
): Promise<void> {
  const drain = async () => {
    while (true) {
      let pending = [persistLoops.get(sessionId), persistQueues.get(sessionId)].filter(
        (promise): promise is Promise<void> => Boolean(promise),
      );
      if (pending.length === 0 && !persistDirty.get(sessionId)) return;
      if (pending.length === 0) {
        if (isSessionDeleted(sessionId)) {
          persistDirty.delete(sessionId);
          pendingPersists.delete(sessionId);
          return;
        }
        const deferred = pendingPersists.get(sessionId);
        if (deferred) {
          void schedulePersist(deferred.state, deferred.reason).catch(() => {
            // 下轮 allSettled 消费拒绝；此处只封住 fire-and-forget 窗口。
          });
          pending = [persistLoops.get(sessionId), persistQueues.get(sessionId)].filter(
            (promise): promise is Promise<void> => Boolean(promise),
          );
        }
      }
      if (pending.length === 0) {
        await Promise.resolve();
        continue;
      }
      await Promise.allSettled(pending);
    }
  };

  await Promise.race([
    drain(),
    timeoutPromise(timeoutMs, `drainSessionPersistenceForSession(${sessionId})`),
  ]);
}

export function __resetSessionPersistenceForTest(): void {
  persistQueues.clear();
  persistDirty.clear();
  persistLoops.clear();
  pendingPersists.clear();
  deletedSessions.clear();
}

export function __getSessionPersistenceStateForTest(): {
  queueCount: number;
  dirtyCount: number;
  loopCount: number;
} {
  let dirtyCount = 0;
  for (const dirty of persistDirty.values()) {
    if (dirty) dirtyCount++;
  }
  return {
    queueCount: persistQueues.size,
    dirtyCount,
    loopCount: persistLoops.size,
  };
}

/**
 * Strip injected metadata from restored message text so the user sees
 * only the original conversational content.
 *
 * Removes:
 * 0. Frozen Working Memory blocks.
 * 1. Doc snapshot block (`\n\n──── 当前文档` … end-of-string)
 * 2. System reminders (`[系统：…] `)
 * 3. Line-number prefixes (`[N] ` at start of lines)
 * 4. Selection context blocks (`【用户选中的文档片段】\n> …`)
 */
export function cleanRestoredText(text: string): string {
  let cleaned = text.replace(
    /\[长期记忆快照[：:]不可信上下文数据\][\s\S]*?<\/working-memory-snapshot>\s*/g,
    "",
  );

  // 1. Strip doc snapshot: everything from `\n\n──── 当前文档` to end
  cleaned = cleaned.replace(/\n\n──── 当前文档[\s\S]*$/, "");

  // 2. Strip system reminders: `[系统：...] ` patterns (greedy within brackets)
  cleaned = cleaned.replace(/\[系统：[^\]]*\]\s*/g, "");

  // 3. Strip line number prefixes: `[N] ` at start of lines
  cleaned = cleaned.replace(/^\[\d+\] /gm, "");

  // 4. Strip selection context blocks: `【用户选中的文档片段】\n> ...`
  //    These blocks start with 【用户选中的文档片段】 and continue through
  //    quoted lines (> ...) ending with the bridging phrase.
  cleaned = cleaned.replace(
    /【用户选中的文档片段】\n(?:>.*\n)*\n*(?:用户针对以上选中内容说：)?/g,
    "",
  );

  return cleaned.trim();
}

/**
 * Extract text content from a MastraDBMessage.content structure.
 * MastraDBMessage uses MastraMessageContentV2 which is:
 * `{ format: 2, parts: MastraMessagePart[] }` where text parts have `{ type: "text", text: string }`.
 */
function extractTextFromDbContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  // MastraMessageContentV2 format
  if (Array.isArray(c.parts)) {
    return (c.parts as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  // Legacy array-of-content-parts format
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

/**
 * Load a thread and reconstruct SessionState from its metadata.
 * Also loads messages from Memory via recall().
 * Returns null if the thread doesn't exist.
 */
export async function loadSessionFromThread(
  sessionId: string,
  options: {
    preferredAskUserToolCallId?: string | null;
    mode?: "activate" | "snapshot";
  } = {},
): Promise<SessionState | null> {
  const isSnapshot = options.mode === "snapshot";
  if (isSessionDeleted(sessionId)) return null;
  const memory = mastra.getMemory("default");
  if (!memory) return null;

  const thread = await memory.getThreadById({
    threadId: sessionId,
  });
  if (!thread) return null;

  let meta = (thread.metadata ?? {}) as unknown as QingagentThreadMetadata;
  const docId = meta.docId ?? sessionId;
  const metadataDocVersion = typeof meta.docVersion === "number" ? meta.docVersion : null;
  const persistedContentEditedAt = parseValidTimestamp(meta.lastContentEditedAt);
  const needsContentTimeBackfill = persistedContentEditedAt === null;
  // 仅旧 metadata 需要在任何 restore 写回前冻结 thread.updatedAt；已有有效内容时间
  // 的会话不再读取这个会被“打开/消息写”推进的字段。
  const frozenUpdatedAt = persistedContentEditedAt ?? frozenThreadUpdatedAt(thread);
  meta = {
    ...meta,
    lastContentEditedAt: persistedContentEditedAt ?? frozenUpdatedAt,
  };
  let restoredFromDocuments = false;
  let needsRestoreReconcilePersist = false;

  try {
    const docRow = await documentRepo.load(docId);
    if (docRow) {
      recordDocRowReadOutcome("hit", { sessionId, docId });
      const metadataDoc = meta.doc;
      const metadataHash = metadataDoc ? getPmContentHash(metadataDoc) : null;
      const documentsHash = docRow.contentHash ?? null;
      const metadataWins =
        metadataDoc &&
        metadataDocVersion !== null &&
        docRow.docVersion < metadataDocVersion;
      const sameVersionHashConflict =
        metadataDoc &&
        metadataDocVersion !== null &&
        docRow.docVersion === metadataDocVersion &&
        documentsHash !== metadataHash;

      // commitDocumentOp 与正文/op 原子落库，但 metadata 是后续写；进程在两者之间
      // 崩溃时必须按精确版本恢复真实提交时间。查询失败不撤销 DB-win 的持久化信号。
      if (docRow.docVersion > (metadataDocVersion ?? -1)) {
        needsRestoreReconcilePersist = true;
        try {
          const committedAt = await getDocumentVersionCommittedAt(docId, docRow.docVersion);
          const validCommittedAt = parseValidTimestamp(committedAt);
          if (validCommittedAt) {
            meta = { ...meta, lastContentEditedAt: validCommittedAt };
          }
        } catch (err) {
          logger.warn("Failed to recover content edit time from exact document op", {
            sessionId,
            docId,
            docVersion: docRow.docVersion,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (metadataWins) {
        needsRestoreReconcilePersist = true;
        recordRestoreReconcileSpan({
          sessionId,
          docId,
          metadataDocVersion,
          documentsDocVersion: docRow.docVersion,
          resolution: "metadata",
          lastPersistedAt: meta.lastPersistedAt ?? null,
        });
        logger.warn("Restore reconcile selected metadata because metadata doc_version is newer", {
          sessionId,
          docId,
          metadataDocVersion,
          documentsDocVersion: docRow.docVersion,
        });
      } else if (sameVersionHashConflict) {
        restoredFromDocuments = true;
        needsRestoreReconcilePersist = true;
        recordRestoreReconcileSpan({
          sessionId,
          docId,
          metadataDocVersion,
          documentsDocVersion: docRow.docVersion,
          resolution: "conflict-rescue",
          lastPersistedAt: meta.lastPersistedAt ?? null,
        });
        logger.error("Restore reconcile detected same-version content hash conflict; documents wins", {
          sessionId,
          docId,
          docVersion: docRow.docVersion,
          metadataHash,
          documentsHash,
        });
        if (!isSnapshot) {
          await rescueMetadataSnapshotOnRestoreConflict({
            sessionId,
            docId,
            docVersion: docRow.docVersion,
            metadataDoc,
            metadataHash: metadataHash!,
          });
        }
        meta = applyRestoredDocumentRow(meta, docRow);
      } else {
        restoredFromDocuments = true;
        if (docRow.docVersion !== metadataDocVersion) {
          needsRestoreReconcilePersist = true;
          recordRestoreReconcileSpan({
            sessionId,
            docId,
            metadataDocVersion,
            documentsDocVersion: docRow.docVersion,
            resolution: "documents",
            lastPersistedAt: meta.lastPersistedAt ?? null,
          });
        }
        meta = applyRestoredDocumentRow(meta, docRow);
      }
    } else {
      recordDocRowReadOutcome("miss", { sessionId, docId });
    }
  } catch (err) {
    recordDocRowReadOutcome("error", { sessionId, docId, error: err });
    try {
      logger.warn("Failed to read documents table during session restore; falling back to metadata", {
        sessionId,
        docId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // 观测日志绝不能影响 metadata fallback。
    }
  }

  // 模型上下文优先恢复 metadata 中的 exact bytes；recall 只作为旧会话兜底。
  let messages: CoreMessage[] = [];
  if (Array.isArray(meta.messages) && meta.messages.length > 0) {
    messages = meta.messages;
  } else {
    try {
      const recalled = await memory.recall({
        threadId: sessionId,
        perPage: false, // load all messages
      });
      messages = recalled.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const rawText = extractTextFromDbContent(m.content);
          const text = cleanRestoredText(rawText);
          const msg: CoreMessage & { id?: string; createdAt?: string } = {
            role: m.role as "user" | "assistant",
            content: text,
          };
          // Attach stable ID and timestamp for restore frames
          msg.id = m.id;
          msg.createdAt = m.createdAt?.toISOString?.() ?? new Date().toISOString();
          return msg as CoreMessage;
        })
        .filter((m) => {
          // Skip messages with empty text after cleaning
          const content = typeof m.content === "string" ? m.content : "";
          return content.length > 0;
        });
    } catch (err) {
      logger.error("Failed to recall messages for session restore", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // PROTECTED fallback — 阶段4保留；停写 metadata.legacySections 前置条件见阶段4计划，勿删。
  const legacySections = meta.legacySections ?? [];
  const doc = meta.doc ?? legacySectionsToPm(legacySections as never);
  let suggestions = deserializeSuggestions(meta.suggestions);
  let patchVerdicts = deserializePatchVerdicts(meta.patchVerdicts);
  const hasPersistedReviewState =
    suggestions.size > 0 ||
    patchVerdicts.size > 0 ||
    meta.docState?.kind === "pendingReview";
  if (needsRestoreReconcilePersist && restoredFromDocuments && hasPersistedReviewState) {
    const canRestoreReview = await hasMatchingRestoreDraft({
      docId,
      docVersion: meta.docVersion ?? 0,
      doc,
    });
    if (!canRestoreReview) {
      suggestions = new Map();
      patchVerdicts = new Map();
    }
  }
  let chatHistory = deserializeChatHistory(meta.chatHistory);
  const toolCallFacts = scanRestoreToolCallFacts(chatHistory);
  const preferredAskUserToolCallId =
    typeof options.preferredAskUserToolCallId === "string" &&
    options.preferredAskUserToolCallId.length > 0 &&
    toolCallFacts.openAskUserToolCallIds.includes(options.preferredAskUserToolCallId)
      ? options.preferredAskUserToolCallId
      : null;
  const persistedAskUserToolCallId =
    typeof meta.toolCallId === "string" &&
    toolCallFacts.openAskUserToolCallIds.includes(meta.toolCallId)
      ? meta.toolCallId
      : null;
  const restorableAskUserToolCallId =
    preferredAskUserToolCallId ?? persistedAskUserToolCallId;
  const hasRestorableAskUserSuspension =
    restorableAskUserToolCallId !== null &&
    typeof meta.runId === "string" &&
    meta.runId.length > 0;
  const normalizedDocStateKind = normalizeRestoredDocStateKind({
    persistedKind: meta.docState?.kind ?? "init",
    hasDoc: legacySections.length > 0,
    hasReviewPatch: suggestions.size > 0,
    hasApplicableReviewPatch: suggestions.size > 0,
    hasOpenAskUserToolCall: toolCallFacts.hasOpenAskUserToolCall,
    hasRestorableSuspension: hasRestorableAskUserSuspension,
  });

  if (toolCallFacts.hasOpenAskUserToolCall) {
    chatHistory = terminalizeStaleRestoreToolCalls(chatHistory, {
      preserveOpenAskUserToolCallId: hasRestorableAskUserSuspension
        ? restorableAskUserToolCallId
        : null,
    });
  }

  meta = {
    ...meta,
    docState: { kind: normalizedDocStateKind },
    chatHistory,
  };

  const restoredSuspensionOwner: SuspensionOwner | null =
    hasRestorableAskUserSuspension
      ? {
          streamId: `restored:${meta.runId}`,
          runId: meta.runId!,
          toolCallId: restorableAskUserToolCallId!,
          toolName: toolCallFacts.openAskUserToolNamesById.get(restorableAskUserToolCallId!) ?? "askUser",
        }
      : null;

  const restoredFolderSources = await verifyRestoredFolderSources(
    filterFolderSourcesForSession(sessionId, deserializeFolderSources(meta.folderSources)),
  );

  // Durable askUser resume is the primary path: an open askUser with persisted
  // runId/toolCallId keeps its Mastra workflow snapshot restorable across
  // restart. If the snapshot is actually missing, resume falls back to a fresh
  // turn after explicitly consuming and clearing the stale suspension.
  const state: SessionState = {
    sessionId,
    docId,
    threadId: sessionId,
    resourceId: (thread as { resourceId?: string }).resourceId ?? QINGAGENT_RESOURCE_ID,
    turnCounter: Number.isInteger(meta.turnCounter) && meta.turnCounter! >= 0
      ? meta.turnCounter!
      : 0,
    omSidecarCursor: deserializeOmSidecarCursor(meta.omSidecarCursor),
    omObservedMessageIds: deserializeOmObservedMessageIds(meta.omObservedMessageIds),
    omCompressionActive: meta.omCompressionActive === true,
    omCompressionEpoch: Number.isInteger(meta.omCompressionEpoch) && meta.omCompressionEpoch! >= 0
      ? meta.omCompressionEpoch!
      : 0,
    omCompressionSnapshot: meta.omCompressionSnapshot &&
        Number.isInteger(meta.omCompressionSnapshot.epoch) &&
        typeof meta.omCompressionSnapshot.observations === "string" &&
        Array.isArray(meta.omCompressionSnapshot.removedMessageIds)
      ? {
          epoch: meta.omCompressionSnapshot.epoch,
          observations: meta.omCompressionSnapshot.observations,
          removedMessageIds: meta.omCompressionSnapshot.removedMessageIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        }
      : null,
    branchTitleGenerated: meta.branchTitleGenerated === true,
    title: meta.title ?? thread.title ?? "",
    titlePinned: meta.titlePinned === true,
    docState: meta.docState,
    messages,
    doc,
    legacySections,
    docVersion: meta.docVersion ?? 0,
    // 仅表示当前进程内模型真正读过的版本；恢复时不从历史上下文推断。
    modelKnownDocVersion: null,
    lastContentEditedAt:
      parseValidTimestamp(meta.lastContentEditedAt) ?? frozenUpdatedAt,
    streamId: null,
    runId: restoredSuspensionOwner?.runId ?? null,
    toolCallId: restoredSuspensionOwner?.toolCallId ?? null,
    previousDocState: null,
    _lastEmittedWireKind: null,
    _abortController: null,
    _activeTurnPromise: null,
    suggestions,
    // 批注是宁简勿繁的瞬时确认事务；刷新/退出不恢复，避免残留不可回状态。
    annotationGroups: [],
    patchVerdicts,
    patchValidationResults: new Map(),
    docDraftBaseSections: null,
    docDraftBaseVersion: null,
    docDraftBaseDoc: null,
    docDraftCandidateSections: null,
    docDraftCandidateDoc: null,
    suggestionBaseDoc: meta.doc ?? null,
    suggestionBaseVersion: meta.docVersion ?? null,
    seqCounters: new Map(),
    materials: deserializeMaterials(meta.materials ?? []),
    folderSources: new Map(restoredFolderSources.map((source) => [source.id, source])),
    todos: [],
    lastSyncedDocumentSnapshot: meta.lastSyncedDocumentSnapshot ?? 0,
    selectedSkills: meta.selectedSkills ?? [],
    selectedSkillsHadSelection: meta.selectedSkillsHadSelection ?? false,
    _workingMemorySnapshot: typeof meta.workingMemorySnapshot === "string"
      ? meta.workingMemorySnapshot
      : null,
    _workingMemorySnapshotLoaded: meta.workingMemorySnapshotLoaded === true,
    _workingMemorySnapshotPersistable: meta.workingMemorySnapshotLoaded === true,
    _workingMemoryUpdatedThisSession: false,
    _askUserCompleted: meta.askUserCompleted ?? false,
    _askUserAsked: meta.askUserAsked ?? false,
    _directionChangeAskedSinceLastWrite: meta.directionChangeAskedSinceLastWrite ?? false,
    _suspendedThisTurn: restoredSuspensionOwner !== null,
    _suspensionOwner: restoredSuspensionOwner,
    chatHistory,
    // 阶段4 follow-up — 用「当前已持久化的状态」初始化 db_write 审计基线快照，
    // 使恢复后第一条 db_write span 的 before 反映真实已存状态，而非把恢复当成首次写
    // （before=null）。meta.docState 已在本函数开头按 restore facts 校正（与
    // serializeMetadata 行为兼容），所以 snapshotFromMeta(meta) 的 docStateKind 与下次 persist 的基线一致；
    // suggestionIds 经 deserialize→serialize 往返保序。
    _lastPersistSnapshot: snapshotFromMeta(meta),
  };

  if (!isSnapshot) {
    if (state.folderSources.size > 0) {
      registerSessionFolderSources(sessionId, state.folderSources.values());
    } else {
      unregisterSessionFolderSources(sessionId);
    }
  }

  const rebuiltAnswerMessages = appendMissingAskUserAnswerMessagesFromChatHistory(state);
  const rebuiltVisibleAnswerCards = appendMissingVisibleAskUserAnswerMessagesFromChatHistory(state);
  const docVersionBeforePendingRehydrate = state.docVersion;
  const contentEditedAtBeforePendingRehydrate = state.lastContentEditedAt;
  try {
    await rehydratePendingDraft(state, { readOnly: isSnapshot });
  } catch (err) {
    logger.error("Failed to rehydrate pending document draft", {
      sessionId,
      docId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const pendingRehydrateChangedCanonical =
    state.docVersion !== docVersionBeforePendingRehydrate ||
    state.lastContentEditedAt !== contentEditedAtBeforePendingRehydrate;
  const rebuiltAskUserState = rebuiltAnswerMessages > 0 || rebuiltVisibleAnswerCards > 0;
  if (
    !isSnapshot &&
    (
      needsContentTimeBackfill ||
      needsRestoreReconcilePersist ||
      pendingRehydrateChangedCanonical ||
      rebuiltAskUserState
    )
  ) {
    await schedulePersist(state, "restore:unified_metadata_reconcile").catch((err) => {
      logger.error("Failed to persist unified session restore reconcile", {
        sessionId,
        docId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return state;
}

/**
 * List session threads by Mastra's mutable updatedAt semantics.
 * Used by usage/data-admin callers; homepage has a dedicated content-time query below.
 * Returns threads ordered by updatedAt DESC.
 */
export async function listSessionThreads(opts: {
  page?: number;
  perPage?: number;
} = {}): Promise<{
  threads: StorageThreadType[];
  total: number;
  hasMore: boolean;
}> {
  const memory = mastra.getMemory("default");
  if (!memory) return { threads: [], total: 0, hasMore: false };

  const [current, legacy] = await Promise.all([
    memory.listThreads({
      filter: { resourceId: QINGAGENT_RESOURCE_ID },
      orderBy: { field: "updatedAt", direction: "DESC" },
      page: opts.page ?? 0,
      perPage: opts.perPage ?? 50,
    }),
    memory.listThreads({
      filter: { resourceId: LEGACY_RESOURCE_ID },
      orderBy: { field: "updatedAt", direction: "DESC" },
      page: opts.page ?? 0,
      perPage: opts.perPage ?? 50,
    }),
  ]);

  const threadsById = new Map<string, StorageThreadType>();
  for (const thread of [...current.threads, ...legacy.threads]) {
    threadsById.set(thread.id, thread);
  }

  const threads = Array.from(threadsById.values()).sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );

  return {
    threads,
    total: current.total + legacy.total,
    hasMore: current.hasMore || legacy.hasMore,
  };
}

export type HomeSessionThread = StorageThreadType & {
  /** 已按 metadata→updatedAt→createdAt→epoch 解析，可直接用于 API 输出。 */
  contentEditedAt: string;
  /** 已校验的创建时间，避免首页路由对 Invalid Date 调用 toISOString。 */
  createdAtIso: string;
};

function parsedHomeThread(thread: StorageThreadType): HomeSessionThread & {
  contentEditedAtMs: number;
  createdAtMs: number;
} {
  const meta = (thread.metadata ?? {}) as unknown as Pick<
    QingagentThreadMetadata,
    "lastContentEditedAt"
  >;
  const contentEditedAt = parseValidTimestamp(meta.lastContentEditedAt)
    ?? parseValidTimestamp(thread.updatedAt)
    ?? parseValidTimestamp(thread.createdAt)
    ?? CONTENT_TIME_EPOCH;
  const createdAt = parseValidTimestamp(thread.createdAt) ?? CONTENT_TIME_EPOCH;
  return {
    ...thread,
    contentEditedAt,
    createdAtIso: createdAt,
    contentEditedAtMs: Date.parse(contentEditedAt),
    createdAtMs: Date.parse(createdAt),
  };
}

/**
 * 首页专用查询：全量拉 current/legacy、current 优先去重、按内容编辑时间排序后分页。
 * listSessionThreads 保持原有 updatedAt 语义，避免影响 usage/data-admin。
 */
export async function listHomeSessionThreads(opts: {
  page?: number;
  perPage?: number;
} = {}): Promise<{
  threads: HomeSessionThread[];
  total: number;
  hasMore: boolean;
}> {
  const memory = mastra.getMemory("default");
  if (!memory) return { threads: [], total: 0, hasMore: false };

  const [current, legacy] = await Promise.all([
    memory.listThreads({
      filter: { resourceId: QINGAGENT_RESOURCE_ID },
      orderBy: { field: "updatedAt", direction: "DESC" },
      page: 0,
      perPage: false,
    }),
    memory.listThreads({
      filter: { resourceId: LEGACY_RESOURCE_ID },
      orderBy: { field: "updatedAt", direction: "DESC" },
      page: 0,
      perPage: false,
    }),
  ]);

  const threadsById = new Map<string, StorageThreadType>();
  for (const thread of current.threads) {
    threadsById.set(thread.id, thread);
  }
  for (const thread of legacy.threads) {
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }

  const sorted = Array.from(threadsById.values())
    .map(parsedHomeThread)
    .sort((a, b) => {
      const contentOrder = b.contentEditedAtMs - a.contentEditedAtMs;
      if (contentOrder !== 0) return contentOrder;
      const createdOrder = b.createdAtMs - a.createdAtMs;
      if (createdOrder !== 0) return createdOrder;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const page = Number.isSafeInteger(opts.page) && (opts.page ?? 0) >= 0
    ? opts.page ?? 0
    : 0;
  const perPage = Number.isSafeInteger(opts.perPage) && (opts.perPage ?? 50) >= 0
    ? opts.perPage ?? 50
    : 50;
  const start = page * perPage;
  const end = start + perPage;
  const threads = sorted.slice(start, end).map(({ contentEditedAtMs: _, createdAtMs: __, ...thread }) => thread);

  return {
    threads,
    total: sorted.length,
    hasMore: end < sorted.length,
  };
}

/**
 * Delete a session thread and all its messages.
 */
export async function deleteSessionThread(sessionId: string): Promise<void> {
  clearSessionSnapshot(sessionId);
  clearQuestionBranch(sessionId);
  unregisterSessionFolderSources(sessionId);
  // 先清沙箱工作目录(模型写的中间文件/产物),再删 thread。清理失败不阻断删除。
  try {
    const { cleanupSessionWorkspace } = await import("../workspace/sessionWorkspace.js");
    await cleanupSessionWorkspace(sessionId);
  } catch {
    // 清理失败不影响 thread 删除
  }
  const memory = mastra.getMemory("default");
  if (!memory) return;

  await deleteDocumentFamily(sessionId);
  await memory.deleteThread(sessionId);
}
