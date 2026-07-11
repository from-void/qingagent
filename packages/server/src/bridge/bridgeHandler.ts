import type {
  ChatMessage,
  Command,
  LegacySection,
  DocState,
  DocSuggestion,
  MessagePart,
  ToolCallSpec,
  ToolCallStatus,
  BridgeFrame,
  FolderSourceRecord,
  ExternalProposeOp,
} from "@qingagent/contract-ts";
import { readFile } from "node:fs/promises";
import { markdownToPm, normalizePmDoc, pmToLegacySections, pmToMarkdown, type PmDoc } from "@qingagent/pm-schema";
import crypto from "node:crypto";
import { MASTRA_THREAD_ID_KEY, RequestContext } from "@mastra/core/request-context";
import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import {
  mastra,
  createSession,
  createSessionScopedTools,
  buildCapabilityTools,
  abortAndCleanupTurn,
  finalizeLingeringRunningToolCalls,
  runAgentTurn,
  serializeReviewOutcome,
  processAgentStream,
  isOmSidecarEnabled,
  prepareOmContextForTurn,
  scheduleOmSidecarAfterTurn,
  TODO_AWARENESS_REQUEST_CONTEXT_KEY,
  buildTodoAwarenessContent,
  activeSuspensionOwnedBy,
  clearSuspension,
  clearStaleSuspensionIfInactive,
  ensureWorkingMemorySnapshot,
  ensureWorkingMemorySnapshotWithStatus,
  QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY,
  QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY,
  getActiveSuspensionOwner,
  hasActiveSuspension,
  updatePatchVerdict,
  commitPatches as commitPatchesBridge,
  commitReviewGroups,
  createSessionThread,
  loadSessionFromThread,
  buildDocumentSnapshot,
  cleanRestoredText,
  persistSessionMetadata,
  schedulePersist,
  deriveDocStateFacts,
  advanceLastContentEditedAt,
  commitDocumentOp,
  getDocumentVersionCommittedAt,
  documentRepo,
  deriveTitleFromSections,
  deriveActiveOverlay,
  deriveAgentBusy,
  deriveContentState,
  deriveEditorState,
  emitProjectedDocState,
  settleDraftCandidate,
  clonePmDoc,
  ensureDraftCandidateDoc,
  replaceDraftCandidateDoc,
  collectTopLevelTextBlocks,
  findLiteralMatches,
  replaceTextRuns,
  normalizeRestoredDocStateKind,
  normalizeTargetDocState,
  sessionIdToTraceId,
  buildAgentTracingMetadata,
  transitionDocState,
  terminalizeAskUserToolCall,
  appendAskUserAnswerMessageIfMissing,
  appendMissingVisibleAskUserAnswerMessagesFromChatHistory,
  buildVisibleAskUserAnswerMessage,
  enrichAskUserResumeAnswersWithLabels,
  hasVisibleAskUserAnswerMessage,
  normalizeAskUserAnswers,
  getObservability,
  guardContext,
  guardReset,
  withPrefixCacheGuardContext,
  QINGAGENT_RESOURCE_ID,
  AGENT_MAX_STEPS,
  clearFolderSourceCache,
  browserFolderSourcesEnabled,
  folderSourcesToWire,
  getQingagentSessionWorkspace,
  invalidateSessionWorkspace,
  localFolderSourcesEnabled,
  markFolderSourceDetached,
  registerBrowserFolderSource,
  registerSessionFolderSources,
  unregisterBrowserFolderSession,
  unregisterBrowserFolderSource,
  unregisterSessionFolderSources,
  type SessionState,
  type Material,
  type ModelOverrides,
  resolveModelParams,
  qingagentAgent,
  parseFileBuffer,
  resolveFileIds,
  findMaterialByFileId,
  upsertMaterialByFileId,
} from "@qingagent/core";
import { deleteUploadedFile } from "../lib/uploadStorage";
import {
  assertDirectory,
  consumeDesktopFolderSelection,
  peekDesktopFolderSelection,
} from "../lib/desktopFolderSelection";
import { SessionManager } from "./sessionManager";
import { countFolderSourceFiles, type FolderSourceFileCountResult } from "../lib/folderSourceFileCount";

const _agent = mastra.getAgent("qingagent");
void _agent;

/** In-memory session store keyed by sessionId. */
const sessions = new Map<string, SessionState>();
const folderSourceOperationQueues = new Map<string, Promise<void>>();
const folderSourceFileCountCache = new Map<string, Promise<FolderSourceFileCountResult>>();

function deriveSessionTraceId(sessionId: string): string | undefined {
  const derive = sessionIdToTraceId as unknown;
  return typeof derive === "function" ? derive(sessionId) : undefined;
}

export const DEFAULT_USER_VERSION_WINDOW_MS = 60_000;

export function readUserVersionWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QINGAGENT_USER_VERSION_WINDOW_MS;
  if (raw === undefined) return DEFAULT_USER_VERSION_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export const USER_VERSION_WINDOW_MS = readUserVersionWindowMs();

export async function drainActiveTurnsForShutdown(): Promise<void> {
  const active = Array.from(sessions.values()).filter(
    (session) =>
      session.streamId !== null ||
      session._abortController !== null ||
      session._activeTurnPromise !== null,
  );
  for (const session of active) {
    session._abortController?.abort();
  }
  await Promise.allSettled(
    active.map((session) => session._activeTurnPromise ?? Promise.resolve()),
  );
}

async function withFolderSourceOperationLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = folderSourceOperationQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  folderSourceOperationQueues.set(sessionId, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (folderSourceOperationQueues.get(sessionId) === next) {
      folderSourceOperationQueues.delete(sessionId);
    }
  }
}

async function persistFolderSourceChange(session: SessionState, reason: string): Promise<void> {
  const promise = schedulePersist(session, reason);
  if (session.threadCreatePromise) {
    void promise.catch((err) => {
      console.error("[persistence] Failed to persist folder source change:", {
        sessionId: session.sessionId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }
  await promise;
}

function folderSourceFileCountCacheKey(sessionId: string, folderId: string): string {
  return `${sessionId}\0${folderId}`;
}

function clearFolderSourceFileCountCache(sessionId: string, folderId: string): void {
  folderSourceFileCountCache.delete(folderSourceFileCountCacheKey(sessionId, folderId));
}

function emitFolderSourcesChangedToClients(session: SessionState): void {
  sessionManager.frameLog.append(session.sessionId, folderSourcesChangedFrame(session));
}

function startFolderSourceFileCountRefresh(session: SessionState, folderId: string): void {
  const source = session.folderSources.get(folderId);
  if (!source || source.status !== "connected") return;
  const key = folderSourceFileCountCacheKey(session.sessionId, folderId);
  if (folderSourceFileCountCache.has(key)) return;

  const task = (async (): Promise<FolderSourceFileCountResult> => {
    const workspace = await getQingagentSessionWorkspace(session.sessionId);
    const filesystem = workspace.filesystem;
    if (!filesystem) return { fileCount: 0, fileCountCapped: true };
    return await countFolderSourceFiles(filesystem, source.mountPath);
  })();
  folderSourceFileCountCache.set(key, task);

  void task
    .then(async (result) => {
      const current = session.folderSources.get(folderId);
      if (!current || current.status !== "connected") return;
      const updatedAt = new Date().toISOString();
      session.folderSources.set(folderId, {
        ...current,
        fileCount: result.fileCount,
        fileCountCapped: result.fileCountCapped,
        updatedAt,
      });
      registerSessionFolderSources(session.sessionId, session.folderSources.values());
      await persistFolderSourceChange(session, "background:folderSourceFileCount");
      emitFolderSourcesChangedToClients(session);
    })
    .catch((error) => {
      folderSourceFileCountCache.delete(key);
      console.warn("[bridge] folder source file count refresh failed", {
        sessionId: session.sessionId,
        folderId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function refreshBrowserFolderSourceFileCountsForBridgeConnection(
  sessionId: string,
  clientId: string,
  folderIds: readonly string[],
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const folderId of folderIds) {
    const source = session.folderSources.get(folderId);
    if (
      !source ||
      source.provider !== "browser-fs-access" ||
      source.browserClientSourceId !== clientId ||
      source.status !== "connected" ||
      source.fileCount != null
    ) {
      continue;
    }
    startFolderSourceFileCountRefresh(session, folderId);
  }
}

async function collectBridgeFrames(frames: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const collected: BridgeFrame[] = [];
  for await (const frame of frames) {
    collected.push(frame);
  }
  return collected;
}

async function* runFolderSourceOperation(
  session: SessionState,
  operation: () => AsyncGenerator<BridgeFrame>,
): AsyncGenerator<BridgeFrame> {
  const frames = await withFolderSourceOperationLock(session.sessionId, () => collectBridgeFrames(operation()));
  for (const frame of frames) {
    yield frame;
  }
}

// ---------------------------------------------------------------------------
// 阶段4 — clientTraceId 透传 + command span（Layer ②）
// ---------------------------------------------------------------------------

/**
 * 解析命令对应的 sessionId（用于 command span 的 traceId 与兜底 clientTraceId）。
 * - 大多数命令 payload 直接带 sessionId。
 * - acceptPatch / rejectPatch / commitPatches 按 patchId 反查已加载会话。
 * 反查不到（会话尚未加载等）则返回 undefined —— span 仍会记，只是 traceId 走
 * Mastra 自动生成、clientTraceId 退回 header 原值。在分发前解析，保证这些命令的
 * command span 也能正确归到本会话 trace（修 Codex review blocking #2）。
 */
export function resolveCommandSessionId(command: Command): string | undefined {
  switch (command.kind) {
    case "acceptPatch":
    case "rejectPatch":
      return (
        (command.data.id ? findSessionByPatch(command.data.id)?.sessionId : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)?.sessionId
          : undefined)
      );
    case "commitPatches":
      return (
        (command.data.ids[0] ? findSessionByPatch(command.data.ids[0])?.sessionId : undefined) ??
        (command.data.reviewBatchIds?.[0]
          ? findSessionByReviewBatchId(command.data.reviewBatchIds[0])?.sessionId
          : undefined)
      );
    case "cancelStream":
      return findSessionByStream(command.data.streamId)?.sessionId;
    default: {
      const data = command.data as Record<string, unknown> | undefined;
      const sid = data?.sessionId;
      return typeof sid === "string" && sid.length > 0 ? sid : undefined;
    }
  }
}

/**
 * 归一化 clientTraceId（阶段4a）：
 * - 传入恰好 32hex（清洗去 dash/大小写后）→ 前端透传的合法 clientTraceId，直接用。
 * - 传入缺失或非 32hex（畸形）→ 用 sessionIdToTraceId(sessionId) 兜底（与会话级
 *   traceId 同源）。要求严格 32hex 而非「任意非空 hex」，避免畸形头（如 "abc"）
 *   产生短 id 污染关联（修 Codex review blocking #3）。
 * - 实在派生不出 → undefined。
 */
export function normalizeClientTraceId(
  raw: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (raw) {
    const cleaned = raw.replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(cleaned)) return cleaned;
  }
  return sessionId ? deriveSessionTraceId(sessionId) : undefined;
}

/**
 * 0603 — 触发来源三态(日志可观测)。读 `x-origin` header:manual=真人前端 /
 * agent=AI 经 agent-browser 等触发 / e2e=自动化。非法/缺省 → manual。纯函数,便于单测。
 */
export type Origin = "manual" | "agent" | "e2e" | "external";
export function parseOrigin(raw: string | undefined): Origin {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "agent" || v === "e2e" || v === "external" ? v : "manual";
}

/**
 * 把本次动作的 clientTraceId + origin 绑到 SessionState，供 db_write / 模型 / state_change
 * span 关联与来源标注。每条命令进来刷新一次(同会话不同动作可有不同 clientTraceId/origin)。
 */
function bindClientTraceId(
  session: SessionState | undefined,
  clientTraceId: string | undefined,
  origin?: Origin,
  modelOverrides?: ModelOverrides,
): void {
  if (!session) return;
  if (clientTraceId) session.clientTraceId = clientTraceId;
  if (origin) session.origin = origin;
  if (modelOverrides) session.modelOverrides = modelOverrides;
}

/**
 * 提取命令关键参数摘要，作为 command span 的 input。
 * 只取小字段 / 计数 / id / 截断文本，绝不塞大对象（文档正文、完整 answers 等）。
 */
function summarizeCommandInput(command: Command): Record<string, unknown> {
  switch (command.kind) {
    case "startSession":
      return { mode: command.data.mode?.kind };
    case "sendMessage":
      return {
        textPreview: command.data.text?.slice(0, 100) ?? "",
        textLength: command.data.text?.length ?? 0,
        mentionCount: command.data.mentions?.length ?? 0,
        skillCount: command.data.skills?.length ?? 0,
        chipCount: command.data.chips?.length ?? 0,
        fileCount: command.data.fileIds?.length ?? 0,
      };
    case "resumeAskUser":
      return {
        toolCallId: command.data.toolCallId ?? null,
        answerCount: Object.keys(command.data.answers ?? {}).length,
      };
    case "cancelAskUser":
      return {
        sessionId: command.data.sessionId,
        toolCallId: command.data.toolCallId,
      };
    case "acceptPatch":
    case "rejectPatch":
      return { patchId: command.data.id, reviewBatchId: command.data.reviewBatchId };
    case "commitPatches":
      return {
        patchIds: command.data.ids,
        patchCount: command.data.ids.length,
        reviewBatchIds: command.data.reviewBatchIds,
      };
    case "updateDoc":
      return {
        sectionsCount: command.data.legacySections?.length ?? null,
        hasPmDoc: Boolean(command.data.doc),
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
      };
    case "externalPropose":
      return {
        sessionId: command.data.sessionId,
        expectedDocVersion: command.data.expectedDocVersion,
        opCount: command.data.ops.length,
        opKinds: command.data.ops.map((op) => op.kind),
      };
    case "updateMaterialSummary":
      return {
        sessionId: command.data.sessionId,
        materialId: command.data.materialId,
        summaryLength: command.data.summary.length,
        summaryPreview: command.data.summary.slice(0, 100),
      };
    case "removeMaterial":
      return {
        sessionId: command.data.sessionId,
        materialId: command.data.materialId,
      };
    case "reparseMaterial":
      return {
        sessionId: command.data.sessionId,
        fileId: command.data.fileId,
      };
    case "attachFolder":
      return {
        sessionId: command.data.sessionId,
        provider: command.data.source.provider,
      };
    case "detachFolder":
      return {
        sessionId: command.data.sessionId,
        folderId: command.data.folderId,
      };
    case "cancelStream":
      return { streamId: command.data.streamId };
    default:
      return {};
  }
}

/**
 * Layer ②（阶段4b）：在命令统一分发点记一条 `SpanType.GENERIC`（name=`command`）
 * span。metadata 带 kind / sessionId / clientTraceId；input 是关键参数摘要。
 * 整段 try/catch：记 span 失败绝不影响命令处理（命令处理是主链路）。
 */
export interface CommandSpanHandle {
  endOk(output?: Record<string, unknown>): void;
  endError(reason: unknown, metadata?: Record<string, unknown>): void;
}

function noopCommandSpanHandle(): CommandSpanHandle {
  return {
    endOk: () => {},
    endError: () => {},
  };
}

function getFailureFromFrame(frame: BridgeFrame): { reason: string; failureKind: string } | null {
  if (frame.kind === "stream" && frame.data.kind === "draftingFailed") {
    return { reason: frame.data.data.reason, failureKind: "draftingFailed" };
  }
  if (frame.kind === "folderSourceOperationResult" && frame.data.ok === false) {
    return {
      reason: frame.data.reason,
      failureKind: `folderSource.${frame.data.op}`,
    };
  }
  return null;
}

/**
 * Layer ②（阶段4b）：在命令统一分发点记一条 `SpanType.GENERIC`（name=`command`）
 * span。metadata 带 kind / sessionId / clientTraceId；input 是关键参数摘要。
 * 返回未结束 handle，由真实执行外层统一根据 throw / draftingFailed / 完成状态 end。
 * 整段 try/catch：记 span 失败绝不影响命令处理（命令处理是主链路）。
 */
export function recordCommandSpan(
  command: Command,
  sessionId: string | undefined,
  clientTraceId: string | undefined,
  origin: Origin = "manual",
): CommandSpanHandle {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return noopCommandSpanHandle();

    const traceId = sessionId ? deriveSessionTraceId(sessionId) : undefined;
    const baseMetadata = {
      eventKind: "command",
      kind: command.kind,
      sessionId,
      clientTraceId,
      origin,
    };
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "command",
      ...(traceId ? { traceId } : {}),
      metadata: baseMetadata,
      input: summarizeCommandInput(command),
    }) as Span<SpanType.GENERIC>;

    let ended = false;
    return {
      endOk(output = { accepted: true }) {
        if (ended) return;
        ended = true;
        span.end({
          metadata: { ...baseMetadata, outcome: "ok" },
          output,
        });
      },
      endError(reason: unknown, metadata: Record<string, unknown> = {}) {
        if (ended) return;
        ended = true;
        const error = reason instanceof Error ? reason : new Error(String(reason));
        const failureReason = error.message || String(reason);
        const finalMetadata = {
          ...baseMetadata,
          ...metadata,
          outcome: "error",
          failureReason,
        };
        span.error({
          error,
          metadata: finalMetadata,
          endSpan: false,
        });
        span.end({
          metadata: finalMetadata,
          output: { accepted: false, failureReason },
        });
      },
    };
  } catch (err) {
    mastra.getLogger().warn("recordCommandSpan failed (non-fatal)", {
      sessionId,
      kind: (command as { kind?: string }).kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return noopCommandSpanHandle();
  }
}

export async function* handleCommand(
  command: Command,
  clientTraceId?: string,
  origin: Origin = "manual",
  modelOverrides?: ModelOverrides,
  client?: string,
): AsyncGenerator<BridgeFrame> {
  // 阶段4 — 在统一分发点归一化 clientTraceId 并记一条 command span（Layer ②）。
  // sessionId 在分发前已解析（含 patch/toolCall 反查），保证 command span 的
  // sessionId / traceId / clientTraceId 兜底都正确归属本会话。
  const cmdSessionId = resolveCommandSessionId(command);
  const resolvedClientTraceId = normalizeClientTraceId(clientTraceId, cmdSessionId);
  console.info(formatAcceptedTurnLog(cmdSessionId ?? "unknown", command.kind));
  // 0603 — 已在内存的会话(非 startSession/restore)在此直接绑 origin,覆盖 db_write 等
  // 不经 bindClientTraceId 的命令分支(acceptPatch/updateDoc/export…);新建/恢复会话
  // 在 handleCommandInner 的 bind 点再绑。
  const existingSession = cmdSessionId ? sessions.get(cmdSessionId) : undefined;
  if (existingSession) {
    existingSession.origin = origin;
    if (modelOverrides) existingSession.modelOverrides = modelOverrides;
  }
  const commandSpan = recordCommandSpan(command, cmdSessionId, resolvedClientTraceId, origin);

  let failure: { reason: string; failureKind: string } | null = null;
  let completed = false;
  try {
    for await (const frame of handleCommandInner(
      command,
      clientTraceId,
      resolvedClientTraceId,
      origin,
      modelOverrides,
      client,
    )) {
      failure ??= getFailureFromFrame(frame);
      yield frame;
    }
    if (failure) {
      commandSpan.endError(failure.reason, { failureKind: failure.failureKind });
    } else {
      commandSpan.endOk({ accepted: true });
    }
    completed = true;
  } catch (err) {
    commandSpan.endError(err, { failureKind: "throw" });
    throw err;
  } finally {
    if (!completed) {
      commandSpan.endError("stream aborted before command completed", {
        failureKind: "streamAborted",
      });
    }
  }
}

function formatAcceptedTurnLog(sessionId: string, commandKind: string): string {
  return `[turn] evt=accepted session=${safeTurnLogValue(sessionId)} cmd=${safeTurnLogValue(commandKind)}`;
}

function safeTurnLogValue(value: string): string {
  return value.replace(/\s+/g, "_");
}

/**
 * startSession(existing) 重进会话的还原:必须先发 restoreReset 让前端清空 session 级状态,
 * 再发 sessionMeta + emitRestoreFrames 从 chatHistory 干净重建。
 *
 * 为什么必须先 reset:直播 sendMessage 只把 agent 消息作为帧写进 FrameLog(用户消息只进
 * chatHistory、不发帧)。重进(startSession existing)会把 emitRestoreFrames 追加到同一条
 * FrameLog 尾部,前端 after=0 重放时会先应用"直播残留的 agent 帧"、再应用还原帧,导致
 * ① 用户消息(只在还原里出现)排到 AI 回复之后 ② AI 消息重复(直播帧 + 还原帧)。
 * 前置 restoreReset 让前端在应用还原帧前清空,状态从 chatHistory 干净重建,顺序正确、无重复。
 * 与 /events 的 appendRestoreSnapshot 干净还原路径对齐(那条已先发 restoreReset)。
 */
function* emitExistingSessionRestore(session: SessionState): Generator<BridgeFrame> {
  const sessionId = session.sessionId;
  yield {
    kind: "restoreReset",
    data: {
      epoch: sessionManager.frameLog.getEpoch(sessionId),
      snapshotSeq: sessionManager.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER)
        .nextSeq,
    },
  };
  yield { kind: "sessionMeta", data: { sessionId, title: session.title } };
  yield* emitRestoreFrames(session);
}

async function* handleCommandInner(
  command: Command,
  clientTraceId: string | undefined,
  resolvedClientTraceId: string | undefined,
  origin: Origin,
  modelOverrides: ModelOverrides | undefined,
  client: string | undefined,
): AsyncGenerator<BridgeFrame> {
  switch (command.kind) {
    case "startSession": {
      const mode = command.data.mode;

      if (mode.kind === "existing") {
        // Restore existing session from thread
        const sessionId = mode.data.id;

        // Check if already loaded in memory
        const cached = sessions.get(sessionId);
        if (cached) {
          // Session already active — just re-emit restore frames
          bindClientTraceId(cached, resolvedClientTraceId, origin, modelOverrides);
          // 重连前对齐 DB 权威版本,修复"内存陈旧 docVersion 导致刷新后必现文档冲突"。
          const cachedReconciledFromDb = await reconcileCachedSessionDocFromDb(cached);
          const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(cached);
          if (cachedReconciledFromDb || (wmSnapshot.loadedNow && wmSnapshot.persistable)) {
            await schedulePersist(
              cached,
              cachedReconciledFromDb
                ? "restore:cached_documents_metadata_reconcile"
                : "restore:working_memory_snapshot",
            );
          }
          yield* emitExistingSessionRestore(cached);
          return;
        }

        // Load from thread storage
        const restored = await loadSessionFromThread(sessionId);
        if (!restored) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        bindClientTraceId(restored, resolvedClientTraceId, origin, modelOverrides);
        sessions.set(sessionId, restored);
        const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(restored);
        if (wmSnapshot.loadedNow && wmSnapshot.persistable) {
          await schedulePersist(restored, "restore:working_memory_snapshot");
        }
        yield* emitExistingSessionRestore(restored);
        return;
      }

      // mode.kind === "new"
      const sessionId = mode.data.sessionId ?? crypto.randomUUID();
      // 覆写防护第二道(0702 review):路由层 409 预检后仍可能有并发窗口(两条同 id 的 new
      // 同时过检、先后入队)。执行时内存已存在同 id 会话则拒绝,绝不允许空会话顶掉活会话。
      if (sessions.has(sessionId)) {
        throw new Error(`Session already exists: ${sessionId}`);
      }
      const createdAt = new Date().toISOString();
      const session = createSession(sessionId, createdAt);
      session.threadId = sessionId;
      // 阶段4a：新会话入口拿不到 sessionId（刚生成），这里按真实 sessionId 重新
      // 归一化 clientTraceId（兜底将用本会话的 traceId），再绑定。
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, sessionId), origin, modelOverrides);
      const wmSnapshot = await ensureWorkingMemorySnapshotWithStatus(session);
      sessions.set(session.sessionId, session);

      // Persist thread to storage (fire-and-forget — don't block SSE)
      const threadCreatePromise = createSessionThread(sessionId, undefined, {
        createdAt,
        workingMemorySnapshot: session._workingMemorySnapshot ?? null,
        workingMemorySnapshotLoaded: wmSnapshot.persistable,
      });
      session.threadCreatePromise = threadCreatePromise;
      threadCreatePromise.catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[persistence] Failed to create session thread:", errMsg);
      });
      void threadCreatePromise
        .finally(() => {
          if (session.threadCreatePromise === threadCreatePromise) {
            session.threadCreatePromise = undefined;
          }
        })
        .catch(() => undefined);

      const meta: BridgeFrame = {
        kind: "sessionMeta",
        data: { sessionId: session.sessionId, title: session.title },
      };
      yield meta;
      return;
    }

    case "sendMessage": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(
          `Session not found: ${command.data.sessionId}`,
        );
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (clearStaleSuspensionIfInactive(session)) {
        yield* emitProjectedDocState(session, "stale_suspension_cleared");
        schedulePersist(session, "sendMessage:clear_stale_suspension").catch((err) => {
          console.error(
            "[sendMessage] Persist after clearing stale suspension failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      if (hasActiveSuspension(session)) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先完成问卷",
              retriable: false,
            },
          },
        };
        return;
      }

      if (session.streamId !== null) {
        yield* abortAndCleanupTurn(session);
      }

      const fileIds = command.data.fileIds ?? [];
      const chips = command.data.chips ?? [];
      const skills = command.data.skills ?? [];
      yield* runAgentTurn(
        session,
        command.data.text,
        fileIds,
        chips,
        skills,
        null, // userDisplayParts:普通发送无展示覆盖(审核结果回流路径才传)
        command.data.clientMessageId,
        command.data.richText,
      );
      return;
    }

    case "submitReviewOutcome": {
      // 用户审完一轮 diff（局部采纳 / 全部拒绝）后以用户名义回流结果，驱动模型追问。
      // 同一 outcome 双投影：序列化全文喂模型（state.messages），缩略卡 part 进 chatHistory。
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (clearStaleSuspensionIfInactive(session)) {
        yield* emitProjectedDocState(session, "stale_suspension_cleared");
        schedulePersist(session, "submitReviewOutcome:clear_stale_suspension").catch((err) => {
          console.error(
            "[submitReviewOutcome] Persist after clearing stale suspension failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      if (hasActiveSuspension(session)) {
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId: session.streamId ?? "blocked",
              reason: "请先完成问卷",
              retriable: false,
            },
          },
        };
        return;
      }

      if (session.streamId !== null) {
        yield* abortAndCleanupTurn(session);
      }

      const outcome = command.data.outcome;
      const reviewUserText = serializeReviewOutcome(outcome);
      const displayParts: MessagePart[] = [
        { kind: "reviewOutcome", data: outcome },
      ];
      yield* runAgentTurn(session, reviewUserText, [], [], [], displayParts);
      return;
    }

    case "resumeAskUser": {
      // 冷加载兜底:loadSessionFromThread 能恢复 askUser 的 runId/toolCallId/_suspensionOwner,
      // 重启/部署后用户仍停在问卷直接提交时,内存 miss 也能恢复后继续(下方 !runId 门控不变)。
      // WM 不在冷 resume 补读:D8 后会话已在 start/run 冻结进 messages;
      // D8 前遗留挂起保持 no-WM 语义,避免恢复时改变旧会话前缀。
      const session = await getOrRestoreSession(command.data.sessionId, {
        preferredAskUserToolCallId: command.data.toolCallId,
      });
      if (!session) {
        throw new Error("没有待恢复的操作");
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      // If runId is not yet set but an active stream is running (the
      // tool-call-suspended event hasn't been processed yet), wait briefly
      // for the suspend to complete. This handles the race condition where
      // the user submits the questionnaire before the askUser tool's
      // suspend() finishes persisting its workflow snapshot.
      if (!session.runId && session.streamId) {
        const MAX_WAIT_MS = 10_000;
        const POLL_MS = 100;
        const deadline = Date.now() + MAX_WAIT_MS;
        while (!session.runId && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
      }

      applySubmittedAskUserToolCallId(session, command.data.toolCallId);

      if (!session.runId) {
        throw new Error("没有待恢复的操作");
      }

      yield* handleResume(
        session,
        command.data.answers,
        session.previousDocState ?? { kind: "editing" },
      );
      return;
    }

    case "cancelAskUser": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* handleCancelAskUser(session, command.data.toolCallId);
      return;
    }

    case "updateDoc": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.runId) {
        yield docWriteReason(command.data.clientMutationId, "agent_busy");
        return;
      }

      const editorState = deriveEditorState(
        deriveContentState(session),
        deriveAgentBusy(session),
        deriveActiveOverlay(session),
      );
      // "先写后聊/模板填充":空文档(empty,非 agent 占用/overlay 锁定)允许首次写入,从空白起稿落库;
      // 仍拒 locked(agent 在跑/overlay)与 pendingReview(审核态)。
      if (editorState !== "editable" && editorState !== "empty") {
        yield docWriteReason(command.data.clientMutationId, "not_editable");
        return;
      }

      const submittedDoc = command.data.doc
        ? normalizePmDoc(command.data.doc)
        : null;

      if (!submittedDoc) {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }

      const previousDocVersion = session.docVersion;
      const result = await commitDocumentOp({
        docId: session.docId ?? session.sessionId,
        threadId: session.threadId ?? session.sessionId,
        resourceId: session.resourceId,
        expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
        clientMutationId: command.data.clientMutationId,
        opKind: "replace_doc",
        actorType: "user",
        // 空文档首写(先写后聊/模板填充):此前无 canonical doc,需 createIfMissing 创建首版(要求 expectedDocumentSnapshot===0)。
        // 首写不进合并窗口(无前序 op 可合并);已有 doc 的常规编辑才走 coalesce。
        ...(editorState === "empty"
          ? {
              createIfMissing: {
                title: session.title,
                docState: "editing",
                lastSyncedVersion: 0,
              },
            }
          : { coalesce: { windowMs: USER_VERSION_WINDOW_MS } }),
        summary: "用户编辑保存",
        apply: () => ({ nextDoc: submittedDoc }),
      });

      if (result.status === "not_found") {
        yield docWriteReason(command.data.clientMutationId, "not_found");
        return;
      }
      if (result.status === "validation_error") {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }
      if (result.status === "patch_conflict") {
        yield docWriteReason(command.data.clientMutationId, "validation_error");
        return;
      }
      if (result.status === "conflict") {
        yield {
          kind: "docWriteResult",
          data: {
            ok: false,
            clientMutationId: command.data.clientMutationId,
            conflict: {
              expectedDocumentSnapshot: command.data.expectedDocumentSnapshot,
              actualDocumentSnapshot: result.currentVersion,
            },
          },
        };
        return;
      }

      advanceLastContentEditedAt(session, result, previousDocVersion);
      const legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
      // 单调防回退:并发/乱序写入下不让 session.docVersion 退到更低版本——否则重连会重放陈旧版本、
      // 客户端发过期 expectedDocumentSnapshot 触发必现文档冲突(配合重连时的 DB reconcile 兜底)。
      if (result.docVersion >= session.docVersion) {
        session.doc = result.doc;
        session.legacySections = legacySections;
        session.docVersion = result.docVersion;
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", {
          mode: "normalize",
        });
        const nextTitle = deriveTitleFromSections(session.legacySections);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield {
            kind: "sessionMeta",
            data: { sessionId: session.sessionId, title: session.title },
          };
        }
      }
      await persistSessionMetadata(session);

      // 空文档首写(先写后聊/模板填充):此前 docState=empty,doc 落库后必须广播 editing,
      // 否则前端停在 empty 态、把新文档渲染成只读静态视图无法编辑。emitProjectedDocState 从
      // doc 派生并幂等去重,常规编辑(已 editing)重复调用会被去重、无副作用。
      yield* emitProjectedDocState(session, "user_doc_write");

      yield {
        kind: "docWriteResult",
        data: {
          ok: true,
          clientMutationId: command.data.clientMutationId,
          // 单调:stale 幂等回放(result.docVersion < 内存版本)时不向客户端确认低版本,
          // 否则客户端会把本地 snapshot 退回、下一次编辑继续冲突。
          docVersion: Math.max(result.docVersion, session.docVersion),
        },
      };
      return;
    }

    case "externalPropose": {
      const session = await getOrRestoreSession(command.data.sessionId);
      const clientMutationId = command.data.clientMutationId ?? crypto.randomUUID();
      if (!session) {
        yield docWriteReason(clientMutationId, "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (deriveAgentBusy(session) || deriveActiveOverlay(session) !== null) {
        yield docWriteReason(clientMutationId, "agent_busy");
        return;
      }
      const contentState = deriveContentState(session);
      if (contentState.kind === "pendingReview") {
        yield docWriteReason(clientMutationId, "not_editable");
        return;
      }
      if (session.docVersion !== command.data.expectedDocVersion) {
        yield {
          kind: "docWriteResult",
          data: {
            ok: false,
            clientMutationId,
            conflict: {
              expectedDocumentSnapshot: command.data.expectedDocVersion,
              actualDocumentSnapshot: session.docVersion,
            },
          },
        };
        return;
      }

      const fullDraftOp = command.data.ops[0]?.kind === "fullDraft" ? command.data.ops[0] : null;
      if (contentState.kind === "empty") {
        if (!fullDraftOp || command.data.ops.length !== 1) {
          yield docWriteReason(clientMutationId, "validation_error");
          return;
        }
        const submittedDoc = normalizePmDoc(markdownToPm(fullDraftOp.markdown));
        const previousDocVersion = session.docVersion;
        const result = await commitDocumentOp({
          docId: session.docId ?? session.sessionId,
          threadId: session.threadId ?? session.sessionId,
          resourceId: session.resourceId,
          expectedDocumentSnapshot: command.data.expectedDocVersion,
          clientMutationId,
          opKind: "replace_doc",
          actorType: "agent",
          createIfMissing: {
            title: session.title,
            docState: "editing",
            lastSyncedVersion: 0,
          },
          summary: "外部工具首写文档",
          apply: () => ({ nextDoc: submittedDoc }),
        });
        if (result.status === "conflict") {
          yield {
            kind: "docWriteResult",
            data: {
              ok: false,
              clientMutationId,
              conflict: {
                expectedDocumentSnapshot: command.data.expectedDocVersion,
                actualDocumentSnapshot: result.currentVersion,
              },
            },
          };
          return;
        }
        if (result.status !== "committed") {
          yield docWriteReason(clientMutationId, result.status === "not_found" ? "not_found" : "validation_error");
          return;
        }
        advanceLastContentEditedAt(session, result, previousDocVersion);
        session.doc = result.doc;
        session.legacySections = pmToLegacySections(result.doc) as unknown as LegacySection[];
        session.docVersion = result.docVersion;
        session._directionChangeAskedSinceLastWrite = false;
        transitionDocState(session, deriveContentState(session), "user_doc_write", { mode: "normalize" });
        const nextTitle = deriveTitleFromSections(session.legacySections);
        if (nextTitle && nextTitle !== session.title) {
          session.title = nextTitle;
          yield { kind: "sessionMeta", data: { sessionId: session.sessionId, title: session.title } };
        }
        await persistSessionMetadata(session);
        yield* emitProjectedDocState(session, "external_full_draft");
        yield { kind: "docWriteResult", data: { ok: true, clientMutationId, docVersion: session.docVersion } };
        return;
      }

      if (fullDraftOp) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }

      const baseCandidate = ensureDraftCandidateDoc(session);
      let workingDoc = clonePmDoc(baseCandidate);
      const applied = applyExternalProposalOps(workingDoc, command.data.ops);
      if (!applied.ok) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      workingDoc = applied.doc;
      replaceDraftCandidateDoc(session, workingDoc);

      const externalId = `external-${client ?? "agent"}-${crypto.randomUUID()}`;
      const agentMessageId = externalId;
      const streamId = externalId;
      const runId = externalId;
      const agentMessage: ChatMessage = {
        id: agentMessageId,
        role: { kind: "agent" },
        ts: new Date().toISOString(),
        parts: [],
        chips: null,
      };

      const settled = yield* settleDraftCandidate({
        state: session,
        agentMessageId,
        streamId,
        runId,
        wholeDocument: false,
      });
      if (settled.hunkCount <= 0) {
        yield docWriteReason(clientMutationId, "validation_error");
        return;
      }
      agentMessage.parts.push({
        kind: "patchSummary",
        data: { count: settled.hunkCount, hunkIds: Array.from(session.suggestions.keys()) },
      });
      session.chatHistory.push(agentMessage);
      yield { kind: "chatMessageAdded", data: { message: agentMessage } };
      return;
    }

    case "updateMaterialSummary": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        yield materialCommandBusyFrame(session);
        return;
      }

      const mat = session.materials.get(command.data.materialId);
      if (!mat) return;

      mat.summary = command.data.summary;
      mat.updatedAt = new Date().toISOString();

      yield materialResourceUpdatedFrame(mat);
      await schedulePersist(session, "command:updateMaterialSummary");
      return;
    }

    case "removeMaterial": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        yield materialCommandBusyFrame(session);
        return;
      }

      const mat = session.materials.get(command.data.materialId);
      if (!mat) return;

      session.materials.delete(command.data.materialId);
      clearExtractedTextCacheForMaterial(session, mat, command.data.materialId);

      const fileId = mat.fileId;
      if (fileId) {
        const stillShared = Array.from(session.materials.values()).some(
          (candidate) => candidate.fileId === fileId,
        );
        if (!stillShared) {
          await deleteUploadedFile(fileId);
        }
      }

      yield {
        kind: "resourceRemoved",
        data: {
          resourceRef: { id: command.data.materialId, domain: { kind: "file" } },
        },
      };
      await schedulePersist(session, "command:removeMaterial");
      return;
    }

    case "reparseMaterial": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${command.data.sessionId}`);
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);

      if (session.streamId || session.runId) {
        console.info("[materials] reparseMaterial busy", {
          sessionId: session.sessionId,
          fileId: command.data.fileId,
          streamId: session.streamId,
          runId: session.runId,
        });
        yield materialCommandBusyFrame(session);
        return;
      }

      const fileId = command.data.fileId;
      const existing = findMaterialByFileId(session, fileId);
      const [resolved] = await resolveFileIds([fileId]);
      const filename = existing?.filename || resolved?.filename || fileId;
      const mimeType = existing?.mimeType || resolved?.mimeType || "application/octet-stream";

      if (existing) {
        clearExtractedTextCacheForMaterial(session, existing, existing.id);
      }

      if (!resolved) {
        console.warn("[materials] reparseMaterial missing upload", {
          sessionId: session.sessionId,
          fileId,
        });
        const { frame } = upsertMaterialByFileId(
          session,
          { fileId, filename, mimeType },
          {
            kind: "error",
            message: "原始文件不存在，无法重试解析",
            parseError: "原始文件不存在，无法重试解析",
          },
        );
        yield frame;
        await schedulePersist(session, "command:reparseMaterial");
        return;
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(resolved.filePath);
      } catch {
        console.warn("[materials] reparseMaterial read upload failed", {
          sessionId: session.sessionId,
          fileId,
          filename,
        });
        const { frame } = upsertMaterialByFileId(
          session,
          { fileId, filename, mimeType },
          {
            kind: "error",
            message: "原始文件不存在，无法重试解析",
            parseError: "原始文件不存在，无法重试解析",
          },
        );
        yield frame;
        await schedulePersist(session, "command:reparseMaterial");
        return;
      }

      const parseStartedAt = Date.now();
      console.info("[materials] reparseMaterial parse start", {
        sessionId: session.sessionId,
        fileId,
        filename,
        mimeType,
        size: buffer.length,
      });
      const parseResult = await parseFileBuffer({ buffer, filename, mimeType });
      const { material, frame } = upsertMaterialByFileId(
        session,
        { fileId, filename, mimeType },
        parseResult,
      );
      cacheExtractedTextForMaterial(session, material, material.id);

      console.info("[materials] reparseMaterial parse end", {
        sessionId: session.sessionId,
        fileId,
        materialId: material.id,
        ok: parseResult.ok,
        failureKind: parseResult.ok ? null : parseResult.failureKind,
        textLength: parseResult.ok ? parseResult.text.length : 0,
        durationMs: Date.now() - parseStartedAt,
      });
      yield frame;
      await schedulePersist(session, "command:reparseMaterial");
      return;
    }

    case "attachFolder": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        yield folderSourceResult("attach", "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () => handleAttachFolder(session, command.data.source));
      return;
    }

    case "detachFolder": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        yield folderSourceResult("detach", "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () => handleDetachFolder(session, command.data.folderId));
      return;
    }

    case "acceptPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("AcceptPatch.data must include id or reviewBatchId for session routing");
      }
      const session =
        (command.data.id ? findSessionByPatch(command.data.id) : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)
          : undefined);
      if (!session) {
        throw new Error(
          `No session owns patchId/reviewBatchId: ${command.data.id ?? command.data.reviewBatchId}`,
        );
      }
      // 这些命令按 patch 反查会话，入口无 sessionId；这里按真实会话重新归一化
      // clientTraceId（兜底用本会话 traceId）后绑定。
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "accepted", command.data.reviewBatchId);
      return;
    }

    case "rejectPatch": {
      if (!command.data.id && !command.data.reviewBatchId) {
        throw new Error("RejectPatch.data must include id or reviewBatchId for session routing");
      }
      const session =
        (command.data.id ? findSessionByPatch(command.data.id) : undefined) ??
        (command.data.reviewBatchId
          ? findSessionByReviewBatchId(command.data.reviewBatchId)
          : undefined);
      if (!session) {
        throw new Error(
          `No session owns patchId/reviewBatchId: ${command.data.id ?? command.data.reviewBatchId}`,
        );
      }
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
      yield* updatePatchVerdict(session, command.data.id, "rejected", command.data.reviewBatchId);
      return;
    }

    case "commitPatches": {
      const firstId = command.data.ids[0];
      const firstReviewBatchId = command.data.reviewBatchIds?.[0];
      if (!firstId && !firstReviewBatchId) {
        throw new Error("CommitPatches.data must include ids or reviewBatchIds");
      }
      const session =
        (firstId ? findSessionByPatch(firstId) : undefined) ??
        (firstReviewBatchId ? findSessionByReviewBatchId(firstReviewBatchId) : undefined);
      if (!session) {
        throw new Error(`No session owns patchId/reviewBatchId: ${firstId ?? firstReviewBatchId}`);
      }
      bindClientTraceId(session, normalizeClientTraceId(clientTraceId, session.sessionId), origin, modelOverrides);
      if (command.data.reviewBatchIds && command.data.reviewBatchIds.length > 0) {
        for await (const frame of commitReviewGroups(session, {
          acceptReviewBatchIds: command.data.reviewBatchIds,
          keepPendingReviewBatchIds: [],
        })) {
          yield frame;
        }
        return;
      }
      for await (const frame of commitPatchesBridge(session, command.data.ids)) {
        yield frame;
      }
      return;
    }

    case "cancelStream": {
      const session = findSessionByStream(command.data.streamId);
      if (session) {
        bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
        yield* abortAndCleanupTurn(session);
      }
      return;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function docWriteReason(
  clientMutationId: string,
  reason: "agent_busy" | "not_editable" | "not_found" | "validation_error",
): BridgeFrame {
  return {
    kind: "docWriteResult",
    data: {
      ok: false,
      clientMutationId,
      reason,
    },
  };
}

function applyExternalProposalOps(
  doc: PmDoc,
  ops: ExternalProposeOp[],
): { ok: true; doc: PmDoc } | { ok: false; error: string } {
  let workingDoc = clonePmDoc(doc);
  for (const op of ops) {
    if (op.kind === "strReplace") {
      const blocks = collectTopLevelTextBlocks(workingDoc);
      const matches = op.nth
        ? findLiteralMatches(blocks, op.old, true).slice(op.nth - 1, op.nth)
        : findLiteralMatches(blocks, op.old, false);
      if (matches.length === 0) return { ok: false, error: "文本未命中或未唯一命中" };
      workingDoc = replaceTextRuns(workingDoc, matches, op.new);
      continue;
    }
    if (op.kind === "appendSection") {
      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      workingDoc = normalizePmDoc({
        ...workingDoc,
        content: [...workingDoc.content, ...insertDoc.content],
      });
      continue;
    }
    if (op.kind === "insertAfterLine") {
      const insertDoc = normalizePmDoc(markdownToPm(op.markdown));
      const index = blockIndexForMarkdownLine(workingDoc, op.line);
      if (index < 0) return { ok: false, error: "行号超出范围" };
      workingDoc = normalizePmDoc({
        ...workingDoc,
        content: [
          ...workingDoc.content.slice(0, index + 1),
          ...insertDoc.content,
          ...workingDoc.content.slice(index + 1),
        ],
      });
      continue;
    }
    return { ok: false, error: "已有文档不允许 fullDraft" };
  }
  return { ok: true, doc: workingDoc };
}

function blockIndexForMarkdownLine(doc: PmDoc, line: number): number {
  if (doc.content.length === 0) return -1;
  let consumedLines = 0;
  for (let index = 0; index < doc.content.length; index += 1) {
    const blockDoc = normalizePmDoc({ ...doc, content: [doc.content[index]!] });
    const blockLineCount = countMarkdownLines(pmToMarkdown(blockDoc));
    const trailingBlankLineCount = index < doc.content.length - 1 ? 1 : 0;
    const blockEndLine = consumedLines + blockLineCount + trailingBlankLineCount;
    if (line <= blockEndLine) return index;
    consumedLines = blockEndLine;
  }
  return line <= consumedLines + 1 ? doc.content.length - 1 : -1;
}

function countMarkdownLines(markdown: string): number {
  if (markdown.length === 0) return 1;
  return markdown.split(/\r?\n/).length;
}

type AttachFolderSource = Extract<Command, { kind: "attachFolder" }>["data"]["source"];
type FolderSourceFailureReason = Extract<
  Extract<BridgeFrame, { kind: "folderSourceOperationResult" }>["data"],
  { ok: false }
>["reason"];

function folderSourceResult(
  op: "attach" | "detach",
  reason: FolderSourceFailureReason,
): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: false, op, reason },
  };
}

function folderSourceOkResult(op: "attach" | "detach", folderId: string): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: true, op, folderId },
  };
}

function folderSourcesChangedFrame(session: SessionState): BridgeFrame {
  return {
    kind: "folderSourcesChanged",
    data: {
      sessionId: session.sessionId,
      sources: folderSourcesToWire(session.folderSources.values()),
    },
  };
}

function hasConnectedFolderSource(session: SessionState): boolean {
  return Array.from(session.folderSources.values()).some((source) => source.status === "connected");
}

function staleFolderSourceIds(session: SessionState): string[] {
  return Array.from(session.folderSources.values())
    .filter((source) => source.status !== "connected")
    .map((source) => source.id);
}

async function removeFolderSourceRuntimeState(
  session: SessionState,
  folderId: string,
  reason: "detach" | "replace",
): Promise<void> {
  clearFolderSourceFileCountCache(session.sessionId, folderId);
  markFolderSourceDetached(session.sessionId, folderId);
  unregisterBrowserFolderSource(session.sessionId, folderId);
  try {
    await clearFolderSourceCache(session.sessionId, folderId);
  } catch (error) {
    console.warn(`[bridge] clear folder source cache failed during ${reason}`, {
      sessionId: session.sessionId,
      folderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  session.folderSources.delete(folderId);
}

async function* handleAttachFolder(
  session: SessionState,
  source: AttachFolderSource,
): AsyncGenerator<BridgeFrame> {
  if (session.streamId || session.runId) {
    yield folderSourceResult("attach", "agent_busy");
    return;
  }
  if (hasConnectedFolderSource(session)) {
    yield folderSourceResult("attach", "too_many_sources");
    return;
  }

  const folderId = `fld_${crypto.randomUUID()}`;
  const mountName = `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  let record: FolderSourceRecord;

  if (source.provider === "desktop-local") {
    if (!localFolderSourcesEnabled()) {
      yield folderSourceResult("attach", "unsupported_environment");
      return;
    }
    const selection = peekDesktopFolderSelection(source.selectionToken);
    if (!selection) {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }

    let rootPath: string;
    try {
      rootPath = await assertDirectory(selection.rootPath);
    } catch {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }
    const consumedSelection = consumeDesktopFolderSelection(source.selectionToken);
    if (!consumedSelection || consumedSelection.rootPath !== selection.rootPath) {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield folderSourceResult("attach", "too_many_sources");
      return;
    }
    for (const staleId of staleFolderSourceIds(session)) {
      await removeFolderSourceRuntimeState(session, staleId, "replace");
    }
    record = {
      id: folderId,
      sessionId: session.sessionId,
      provider: "desktop-local",
      name: consumedSelection.name,
      pathLabel: consumedSelection.pathLabel,
      mountName,
      mountPath: `/sources/${mountName}`,
      readOnly: true,
      fileCount: consumedSelection.fileCount,
      fileCountCapped: consumedSelection.fileCountCapped,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      desktopRootPath: rootPath,
    };
  } else {
    if (!browserFolderSourcesEnabled()) {
      yield folderSourceResult("attach", "unsupported_environment");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield folderSourceResult("attach", "too_many_sources");
      return;
    }
    for (const staleId of staleFolderSourceIds(session)) {
      await removeFolderSourceRuntimeState(session, staleId, "replace");
    }
    record = {
      id: folderId,
      sessionId: session.sessionId,
      provider: "browser-fs-access",
      name: source.name,
      pathLabel: source.name,
      mountName,
      mountPath: `/sources/${mountName}`,
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      browserHandleKey: source.browserHandleKey,
      browserClientSourceId: source.clientSourceId,
    };
  }

  session.folderSources.set(folderId, record);
  registerSessionFolderSources(session.sessionId, session.folderSources.values());
  if (record.provider === "browser-fs-access" && record.browserClientSourceId) {
    registerBrowserFolderSource(session.sessionId, folderId, record.browserClientSourceId, {
      reviveDetached: true,
    });
  }
  invalidateSessionWorkspace(session.sessionId);
  await persistFolderSourceChange(session, "command:attachFolder");

  yield folderSourceOkResult("attach", folderId);
  yield folderSourcesChangedFrame(session);
  startFolderSourceFileCountRefresh(session, folderId);
}

async function* handleDetachFolder(
  session: SessionState,
  folderId: string,
): AsyncGenerator<BridgeFrame> {
  if (session.streamId || session.runId) {
    yield folderSourceResult("detach", "agent_busy");
    return;
  }
  if (!session.folderSources.has(folderId)) {
    yield folderSourceResult("detach", "not_found");
    return;
  }

  await removeFolderSourceRuntimeState(session, folderId, "detach");
  registerSessionFolderSources(session.sessionId, session.folderSources.values());
  invalidateSessionWorkspace(session.sessionId);
  await persistFolderSourceChange(session, "command:detachFolder");

  yield folderSourceOkResult("detach", folderId);
  yield folderSourcesChangedFrame(session);
}

function materialCommandBusyFrame(session: SessionState): BridgeFrame {
  return {
    kind: "stream",
    data: {
      kind: "draftingFailed",
      data: {
        streamId: session.streamId ?? "blocked",
        reason: "生成中，请稍后再试",
        retriable: false,
      },
    },
  };
}

function materialResourceUpdatedFrame(mat: Material): BridgeFrame {
  const metadataWithFileId = { ...mat.metadata, fileId: mat.fileId };
  return {
    kind: "resourceUpdated",
    data: {
      resourceRef: { id: mat.id, domain: { kind: "file" } },
      summary: mat.summary,
      metadata: metadataWithFileId,
    },
  };
}

function clearExtractedTextCacheForMaterial(
  session: SessionState,
  mat: Material,
  materialId?: string,
): void {
  const keys = [mat.filename, mat.metadata.title, mat.metadata.sourceUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (typeof materialId === "string" && materialId.length > 0) {
    keys.push(materialId);
  }
  for (const key of keys) {
    session._extractedTexts?.delete(key);
  }
}

function cacheExtractedTextForMaterial(
  session: SessionState,
  mat: Material,
  materialId?: string,
): void {
  if (mat.metadata.parseState !== "ready" || mat.text.trim().length === 0) return;
  session._extractedTexts ??= new Map();
  const entry = { text: mat.text, sourceUrl: mat.metadata.sourceUrl ?? null, fileId: mat.fileId };
  session._extractedTexts.set(mat.filename, entry);
  if (typeof mat.metadata.title === "string" && mat.metadata.title.length > 0) {
    session._extractedTexts.set(mat.metadata.title, entry);
  }
  if (typeof materialId === "string" && materialId.length > 0) {
    session._extractedTexts.set(materialId, entry);
  }
}

async function* handleCancelAskUser(
  session: SessionState,
  toolCallId: string,
): AsyncGenerator<BridgeFrame> {
  const hasSuspension = hasActiveSuspension(session);
  const hasMatchingSuspension = hasSuspension && session.toolCallId === toolCallId;
  if (hasSuspension && !hasMatchingSuspension) {
    throw new Error("没有待放弃的问卷");
  }
  if (!hasMatchingSuspension && !canAbortRunningAskUser(session, toolCallId)) {
    throw new Error("没有待放弃的问卷");
  }

  const terminalized = terminalizeAskUserToolCall(
    session,
    toolCallId,
    "用户已放弃本轮问卷",
  );
  if (!terminalized) {
    throw new Error(`No pending askUser toolCall: ${toolCallId}`);
  }

  yield {
    kind: "toolCallUpdated",
    data: {
      messageId: terminalized.messageId,
      toolCallId: terminalized.toolCallId,
      spec: terminalized.spec,
    },
  };

  if (!hasMatchingSuspension) {
    // running(尚未挂起)态点放弃:abort 与 Mastra 的 askUser 挂起会抢跑,挂起常在 abort
    // 之后才落地、被错投影成"新问卷"。标记该 toolCallId,让挂起处理处命中即丢弃,回 idle。
    (session._abandonedAskUserToolCallIds ??= new Set()).add(toolCallId);
    yield* abortAndCleanupTurn(session, { emitStreamEnd: false });
    return;
  }

  clearSuspension(session);
  transitionDocState(
    session,
    normalizeTargetDocState(
      session,
      session.previousDocState ?? deriveContentState(session),
      "ask_user_abandoned",
    ),
    "ask_user_abandoned",
    { mode: "normalize" },
  );
  yield* emitProjectedDocState(session, "ask_user_abandoned");

  schedulePersist(session, "cancelAskUser").catch((err) => {
    console.error("[cancelAskUser] Persist after cancel failed:", err instanceof Error ? err.message : String(err));
  });
}

function canAbortRunningAskUser(session: SessionState, toolCallId: string): boolean {
  if (session.streamId === null) return false;
  for (const message of session.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        part.data.name === "askUser" &&
        (part.data.status.kind === "pending" || part.data.status.kind === "running")
      ) {
        return true;
      }
    }
  }
  return false;
}

interface LiveRestoreDocStateDecision {
  target: DocState;
}

function liveRestoreStatus(
  spec: ToolCallSpec,
  opts: { preserveToolCallId?: string | null } = {},
): ToolCallSpec["status"] | null {
  if (spec.id === opts.preserveToolCallId) {
    return null;
  }

  if (
    spec.name === "askUser" &&
    (spec.status.kind === "pending" || spec.status.kind === "running")
  ) {
    return {
      kind: "failed",
      data: { retriable: false, reason: "上次的确认已结束，请重新发起。" },
    };
  }

  return null;
}

function terminalizeStaleLiveRestoreToolCalls(session: SessionState): void {
  const activeOwner = getActiveSuspensionOwner(session);
  for (const message of session.chatHistory) {
    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i]!;
      if (part.kind !== "toolCall") continue;
      const status = liveRestoreStatus(part.data, {
        preserveToolCallId: activeOwner?.toolCallId ?? null,
      });
      if (!status) continue;
      message.parts[i] = {
        kind: "toolCall",
        data: { ...part.data, status },
      };
    }
  }
}

function getLiveRestoreDocStateDecision(
  session: SessionState,
): LiveRestoreDocStateDecision {
  const facts = deriveDocStateFacts(session);
  return {
    target: {
      kind: normalizeRestoredDocStateKind({
        persistedKind: session.docState.kind,
        hasDoc: facts.hasDoc,
        hasReviewPatch: facts.hasReviewPatch,
        hasApplicableReviewPatch: facts.hasApplicableReviewPatch,
        hasOpenAskUserToolCall: facts.hasOpenAskUser,
        hasRestorableSuspension: facts.hasActiveSuspension,
      }),
    } as DocState,
  };
}

function* emitNormalizedRestoreDocState(session: SessionState): Generator<BridgeFrame> {
  const decision = getLiveRestoreDocStateDecision(session);
  terminalizeStaleLiveRestoreToolCalls(session);
  const target = decision.target;
  transitionDocState(session, target, "restore_normalized", {
    mode: "normalize",
  });
  // restore 是把完整当前状态重放给一个全新的前端连接(刷新/重进)。_lastEmittedWireKind
  // 记录的是发给【上一个】连接的 wire 态;若不清,emitProjectedDocState 会因"同 kind"短路
  // 而不发 docStateChanged,导致新连接 docState 卡在初始 empty → 正文不渲染("文章不见了")
  // + 编辑器只读。强制清空,使 restore 必发当前 docState 首帧。
  session._lastEmittedWireKind = null;
  yield* emitProjectedDocState(session, "restore_normalized");
}

function* emitReadOnlyRestoreDocState(session: SessionState): Generator<BridgeFrame> {
  // /events 的 gap/epoch restore 是订阅恢复路径,可能与正在运行的 SessionActor 并发。
  // 这里只投影当前快照,不终态化 toolCall、不 transition docState、不改 _lastEmittedWireKind。
  yield {
    kind: "docStateChanged",
    data: {
      state: deriveContentState(session),
      activeOverlay: deriveActiveOverlay(session),
      agentBusy: deriveAgentBusy(session),
    },
  };
}

function isSnapshotNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("AGENT_RESUME_NO_SNAPSHOT_FOUND") ||
      error.message.includes("could not find a suspended run"))
  );
}

function isAskUserQuestionSpec(spec: ToolCallSpec): boolean {
  return spec.name === "askUser" && spec.body?.kind === "askUser";
}

function findAskUserToolCallSpec(
  session: SessionState,
  toolCallId: string | null,
): ToolCallSpec | null {
  if (!toolCallId) return null;
  for (const message of session.chatHistory) {
    for (const part of message.parts) {
      if (
        part.kind === "toolCall" &&
        part.data.id === toolCallId &&
        isAskUserQuestionSpec(part.data)
      ) {
        return part.data;
      }
    }
  }
  return null;
}

function applySubmittedAskUserToolCallId(
  session: SessionState,
  submittedToolCallId: string | null | undefined,
): void {
  if (!submittedToolCallId || submittedToolCallId === session.toolCallId) return;
  const submittedSpec = findAskUserToolCallSpec(session, submittedToolCallId);
  if (!submittedSpec) {
    return;
  }
  session.toolCallId = submittedToolCallId;
  if (session._suspensionOwner?.toolName === "askUser") {
    session._suspensionOwner = {
      ...session._suspensionOwner,
      toolCallId: submittedToolCallId,
    };
  }
}

function markAskUserToolCallAnsweredForResume(
  session: SessionState,
  toolCallId: string | null,
  answersRecord: ReturnType<typeof normalizeAskUserAnswers>,
): { messageId: string; toolCallId: string; spec: ToolCallSpec } | null {
  if (!toolCallId) return null;
  for (const message of session.chatHistory) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      if (
        part?.kind !== "toolCall" ||
        part.data.id !== toolCallId ||
        !isAskUserQuestionSpec(part.data)
      ) {
        continue;
      }
      if (part.data.status.kind === "done") return null;
      const spec: ToolCallSpec = {
        ...part.data,
        status: { kind: "done" },
        result:
          Object.keys(answersRecord).length > 0
            ? { kind: "askUserAnswers", data: answersRecord }
            : { kind: "genericText", data: "已提交" },
      };
      message.parts[index] = { kind: "toolCall", data: spec };
      return { messageId: message.id, toolCallId, spec };
    }
  }
  return null;
}

function formatChatHistoryForFreshResume(session: SessionState): string {
  const lines: string[] = [];
  for (const message of session.chatHistory) {
    const role = message.role.kind === "user" ? "用户" : "助手";
    const parts: string[] = [];
    for (const part of message.parts) {
      if (part.kind === "text" && part.data.body.trim().length > 0) {
        parts.push(part.data.body.trim());
      }
      if (part.kind === "toolCall") {
        parts.push(`[工具:${part.data.name} ${part.data.status.kind}]`);
      }
    }
    if (parts.length > 0) {
      lines.push(`${role}: ${parts.join(" ")}`);
    }
  }
  return lines.slice(-12).join("\n");
}

function formatAskUserQuestions(spec: ToolCallSpec): string {
  if (spec.body.kind !== "askUser") {
    return "[]";
  }
  return JSON.stringify(spec.body.data.questions, null, 2);
}

function buildFreshAskUserResumePrompt(
  session: SessionState,
  spec: ToolCallSpec,
  resumeData: Record<string, unknown>,
): string {
  const history = formatChatHistoryForFreshResume(session);
  const questions = formatAskUserQuestions(spec);
  const answers = JSON.stringify(resumeData, null, 2);

  return [
    "[系统：上一轮 askUser 挂起的持久快照缺失，下面用 fresh turn 延续同一任务。]",
    "请基于已有历史、原问卷和用户本次答案继续完成原任务；不要要求用户重复填写同一份问卷，除非答案仍明显不足。",
    "",
    "【已有历史】",
    history || "（无可用历史摘要）",
    "",
    "【原问卷 questions】",
    questions,
    "",
    "【用户本次 answers】",
    answers,
  ].join("\n");
}

/**
 * Shared resume handler for resumeAskUser.
 *
 * Key safety invariant: we do NOT clear session.runId / session.toolCallId
 * before calling resumeStream. processAgentStream already clears them on
 * natural stream completion. If an askUser snapshot is missing, the handler
 * first consumes and clears the stale suspension, persists idle state, then
 * starts a fresh turn with the original questions and submitted answers.
 */
async function* handleResume(
  session: SessionState,
  resumeData: Record<string, unknown>,
  errorFallbackDocState: DocState,
): AsyncGenerator<BridgeFrame> {
  const { runId, toolCallId } = session;
  const streamId = crypto.randomUUID();
  const abortController = new AbortController();
  let resolveActiveTurn!: () => void;
  const activeTurnPromise = new Promise<void>((resolve) => {
    resolveActiveTurn = resolve;
  });
  session.streamId = streamId;
  session._abortController = abortController;
  session._activeTurnPromise = activeTurnPromise;
  const omSidecarEnabled = isOmSidecarEnabled();
  // resume 只把 askUser 答案补回被挂起回合；不推进新的 OM turn。
  // 不传 currentTurn 锚点时，OM fallback 会把 [askUserAnswers:*] 辅助 user
  // 并回上一轮，避免后续普通 turn 重新映射旧消息 ID。
  const omResumeTurnIndex: number | null = null;
  const omResumeStartMessageIndex: number | null = null;
  // 在进入 resumeStream 重试循环前快照本次动作的 clientTraceId（已由 resume 类
  // 命令分发时 bindClientTraceId 设置）。若在重试退避期间有并发命令改写了
  // session.clientTraceId，本轮 resume 的框架 span 仍归属本动作而非后续动作。
  const resumeClientTraceId = session.clientTraceId ?? null;
  let freshTurnPrompt: string | null = null;
  let resumeRequestContext: RequestContext | undefined;

  yield { kind: "stream", data: { kind: "start", data: { streamId } } };

  const askUserSpecForResume = findAskUserToolCallSpec(session, toolCallId);
  let visibleAnswerMessageAdded = false;
  if (!hasVisibleAskUserAnswerMessage(session, toolCallId)) {
    // 先把用户已提交的可见答卷卡落进 chatHistory,再尝试 resumeStream。
    // 若后续缺 Mastra snapshot 走 fresh-turn 兜底,模型上下文会通过同一份答案 message 消费答案；
    // 可见卡只承担 UI 复原职责,幂等 id 保证不会重复插入。
    const visibleAnswerMessage = buildVisibleAskUserAnswerMessage(
      toolCallId,
      resumeData,
      askUserSpecForResume,
    );
    if (visibleAnswerMessage) {
      session.chatHistory.push(visibleAnswerMessage);
      visibleAnswerMessageAdded = true;
      yield {
        kind: "chatMessageAdded",
        data: { message: visibleAnswerMessage },
      };
    }
  }

  const agentMessageId = crypto.randomUUID();
  const agentMessage: ChatMessage = {
    id: agentMessageId,
    role: { kind: "agent" },
    ts: new Date().toISOString(),
    parts: [],
    chips: null,
  };
  yield {
    kind: "chatMessageAdded",
    data: { message: agentMessage },
  };
  session.chatHistory.push(agentMessage);

  try {
    const sessionTools = createSessionScopedTools(session);
    const capabilityTools = await buildCapabilityTools();
    // Retry resumeStream with back-off when the Mastra workflow snapshot
    // hasn't been persisted yet. This handles the race where
    // tool-call-suspended was processed (runId is set) but the underlying
    // suspend() call that persists the snapshot hasn't finished the I/O.
    const MAX_RESUME_RETRIES = 5;
    const RETRY_DELAY_MS = 500;
    let result: Awaited<ReturnType<typeof qingagentAgent.resumeStream>>;
    // resume 本身即"用户已答完一轮问卷"的信号 → 无条件标记已问过一轮:既让 askUser
    // 重复 initialBrief 走抑制(askUser 工具读 askUserAlreadyCompleted),又让渲染形态走浮层
    // 而非 fullpage(processAgentStream 读 state._askUserCompleted),防止第二次问卷占据右侧编辑器。
    session._askUserCompleted = true;
    const resumeAnswers = normalizeAskUserAnswers(resumeData);
    if (
      Object.keys(resumeAnswers).length > 0 &&
      askUserSpecForResume?.body.kind === "askUser" &&
      askUserSpecForResume.body.data.purpose?.kind === "directionChange"
    ) {
      session._directionChangeAskedSinceLastWrite = true;
    }
    let answerContextMessageAdded = false;
    if (
      appendAskUserAnswerMessageIfMissing(
        session,
        toolCallId,
        resumeData,
        askUserSpecForResume,
      )
    ) {
      answerContextMessageAdded = true;
    }
    if (visibleAnswerMessageAdded || answerContextMessageAdded) {
      await schedulePersist(session, "resumeAskUser:answer_message");
    }
    const frozenWorkingMemorySnapshot = await ensureWorkingMemorySnapshot(session);
    const omContextForResume = await prepareOmContextForTurn(session, undefined, {
      allowCompressionActivation: false,
    });
    const resumeMessagesForModel = omContextForResume.messagesForModel;
    const resumeMessagesForToolContext = omContextForResume.tailObservationPrompt
      ? [
          ...resumeMessagesForModel,
          {
            role: "user" as const,
            content: omContextForResume.tailObservationPrompt,
          },
        ]
      : resumeMessagesForModel;
    // resumeStream 恢复的是 Mastra 挂起时保存的 MessageList,API 不接受替换后的
    // messages 数组;但工具内层 LLM 读取 requestContext.messages,压缩态必须同步
    // 使用投影上下文,避免 writeDraft 等工具绕过 OM 压缩。
    const requestContext: RequestContext = new RequestContext([
      ["materials", session.materials],
      ["messages", resumeMessagesForToolContext],
      [MASTRA_THREAD_ID_KEY, session.threadId ?? session.sessionId],
      [TODO_AWARENESS_REQUEST_CONTEXT_KEY, () => buildTodoAwarenessContent(session.todos)],
      [QINGAGENT_WORKING_MEMORY_REQUEST_CONTEXT_KEY, frozenWorkingMemorySnapshot],
      [QINGAGENT_OM_OBSERVATIONS_REQUEST_CONTEXT_KEY, omContextForResume.tailObservationPrompt],
      ["sessionId", session.sessionId],
      ["docVersion", session.docVersion],
      ["doc", session.doc],
      ["legacySections", session.legacySections],
      ["patchValidationResults", session.patchValidationResults],
      ["modelOverrides", session.modelOverrides],
      ["askUserAlreadyCompleted", true],
      ["directionChangeAskedSinceLastWrite", session._directionChangeAskedSinceLastWrite === true],
    ]);
    resumeRequestContext = requestContext;
    // e2e-loop-0704 R13:resume 时模型只看得到 raw 答案(chosen 里是 "v2" 这类选项
    // value),题面/选项文案只发给过前端 → 模型读不懂答卷,收到答案后 5s 内再弹一份
    // 同类问卷。把题面/选中项 label 回填进 resumeData,模型在它实际走的上下文
    // (resume 后的 tool-result)里直接读懂答案;可见卡/答案 message 路径仍用原始答案。
    const resumeDataForModel = enrichAskUserResumeAnswersWithLabels(
      resumeData,
      askUserSpecForResume,
    );
    const prefixGuardContext = {
      sessionId: session.sessionId,
      lineage: "resume" as const,
      scopeId: streamId,
    };
    let activePrefixGuardContext = prefixGuardContext;
    for (let attempt = 0; ; attempt++) {
      try {
        const sessionTraceId = deriveSessionTraceId(session.sessionId);
        activePrefixGuardContext = {
          ...prefixGuardContext,
          scopeId: attempt === 0 ? streamId : `${streamId}:retry:${attempt}`,
        };
        result = await guardContext.run(
          activePrefixGuardContext,
          () => qingagentAgent.resumeStream(
            resumeDataForModel,
            {
              runId: runId!,
              toolCallId: toolCallId ?? undefined,
              maxSteps: AGENT_MAX_STEPS,
              // 对齐普通 runAgentTurn：代理偶发抖动时给模型调用更多重试余量。
              // F1:同样合并设置页采样参数覆盖。
              modelSettings: { maxRetries: 4, ...resolveModelParams(requestContext) },
              ...(omSidecarEnabled
                ? {}
                : {
                    memory: {
                      thread: session.threadId ?? session.sessionId,
                      resource: session.resourceId || QINGAGENT_RESOURCE_ID,
                    },
                  }),
              toolsets: {
                sessionScoped: {
                  readMaterial: sessionTools.readMaterial,
                  summarizeMaterial: sessionTools.summarizeMaterial,
                  readDraft: sessionTools.readDraftAiIr,
                  editDraft: sessionTools.editDraft,
                  readDiff: sessionTools.readDiff,
                  ...(sessionTools.writeDraft ? { writeDraft: sessionTools.writeDraft } : {}),
                  ...(sessionTools.updateWorkingMemory ? { updateWorkingMemory: sessionTools.updateWorkingMemory } : {}),
                },
                capabilityTools,
              },
              // Keep resumed-run spans on the same session trace as the initial
              // turn and carry the raw ids in span metadata for cross-layer joins.
              // clientTraceId 必须随 resume 透传：缺它会让 askUser resume / 续轮
	              // （含 writeDraft 那轮）的框架 span（agent_run/model_generation/
              // tool_call/processor_run/model_inference）clientTraceId 全为 null，
              // 按 clientTraceId 追链时这些轮的因果链断裂。对齐首轮 runAgentTurn 的
              // tracingOptions.metadata（runAgentTurn.ts）。session.
	              // clientTraceId 已在 resumeAskUser 分发
              // 时由 bindClientTraceId(normalizeClientTraceId(...)) 设置。
              tracingOptions: {
                ...(sessionTraceId ? { traceId: sessionTraceId } : {}),
                metadata: buildAgentTracingMetadata(
                  { ...session, clientTraceId: resumeClientTraceId ?? undefined },
                  streamId,
                  runId,
                ),
              },
              requestContext,
              abortSignal: abortController.signal,
            },
          ),
        );
        break; // success — exit retry loop
      } catch (resumeErr) {
        // Retry only on snapshot-not-found errors (the workflow snapshot
        // from suspend() may not have been persisted yet).
        if (isSnapshotNotFoundError(resumeErr) && attempt < MAX_RESUME_RETRIES) {
          console.warn(
            `[handleResume] Snapshot not found (attempt ${attempt + 1}/${MAX_RESUME_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw resumeErr; // non-retryable or exhausted retries
      }
    }

    const answeredAskUserUpdate = markAskUserToolCallAnsweredForResume(
      session,
      toolCallId,
      resumeAnswers,
    );
    if (answeredAskUserUpdate) {
      yield {
        kind: "toolCallUpdated",
        data: answeredAskUserUpdate,
      };
    }
    yield* emitProjectedDocState(session, "resume_ask_user_answered");

    // processAgentStream clears session.runId / session.toolCallId on
    // natural completion.
    const resumeOutcome = yield* withPrefixCacheGuardContext(activePrefixGuardContext, () =>
      processAgentStream(result.fullStream, {
        state: session,
        agentMessageId,
        streamId,
        runId: result.runId,
        requestContext,
      }),
    );
    // 诊断 p04:问卷确认后的首次生成最易撞上 DeepSeek 流式瞬断(ECONNRESET)。
    // 普通 sendMessage 有零产出瞬断自动重试,resume 路径此前没有——用户刚填完
    // 问卷就看到"生成失败,请手动重试"。这里对"瞬断 + 无可见产出 + 无真副作用
    // 工具调用"的安全场景,用既有的 fresh-turn 兜底机制自动续跑(runAgentTurn
    // 自带瞬断重试)。
    if (
      resumeOutcome.transientErrorChunk !== undefined &&
      !resumeOutcome.producedVisibleFrame &&
      !resumeOutcome.sawSideEffectToolCall
    ) {
      const askUserSpecForRetry = findAskUserToolCallSpec(session, toolCallId);
      if (askUserSpecForRetry) {
        console.warn(
          "[handleResume] transient zero-output stream error after resume; auto-retrying as fresh turn",
          { sessionId: session.sessionId, streamId },
        );
        freshTurnPrompt = buildFreshAskUserResumePrompt(
          session,
          askUserSpecForRetry,
          resumeData,
        );
        const terminalized = terminalizeAskUserToolCall(
          session,
          askUserSpecForRetry.id,
          "网络刚才中断，已用你的答案自动重试。",
        );
        if (terminalized) {
          yield {
            kind: "toolCallUpdated",
            data: {
              messageId: terminalized.messageId,
              toolCallId: terminalized.toolCallId,
              spec: terminalized.spec,
            },
          };
        }
      } else {
        // 找不到原问卷 spec 时退回可见失败,绝不静默吞错。
        yield {
          kind: "stream",
          data: {
            kind: "draftingFailed",
            data: {
              streamId,
              reason: "模型服务连接失败(网络或上游异常),请重试。",
              retriable: true,
            },
          },
        };
      }
    }
  } catch (err) {
    const askUserSpec = findAskUserToolCallSpec(session, toolCallId);
    if (isSnapshotNotFoundError(err) && askUserSpec) {
      guardReset(session.sessionId, "snapshot_lost");
      freshTurnPrompt = buildFreshAskUserResumePrompt(
        session,
        askUserSpec,
        resumeData,
      );

      const terminalized = terminalizeAskUserToolCall(
        session,
        askUserSpec.id,
        "原问卷快照缺失，已用本次答案转入新一轮继续处理。",
      );
      if (terminalized) {
        yield {
          kind: "toolCallUpdated",
          data: {
            messageId: terminalized.messageId,
            toolCallId: terminalized.toolCallId,
            spec: terminalized.spec,
          },
        };
      }

      clearSuspension(session);
      if (session.streamId === streamId) {
        session.streamId = null;
      }
      transitionDocState(
        session,
        normalizeTargetDocState(session, deriveContentState(session), "resume_failed"),
        "resume_failed",
        { mode: "normalize" },
      );
      yield* emitProjectedDocState(session, "resume_failed");
      await schedulePersist(session, "resume_failed:fresh_turn_fallback");
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      yield {
        kind: "stream",
        data: {
          kind: "draftingFailed",
          data: { streamId, reason, retriable: true },
        },
      };

      // Resume failed; the consumed Mastra snapshot is no longer restorable.
      clearSuspension(session);
      transitionDocState(
        session,
        normalizeTargetDocState(session, errorFallbackDocState, "resume_failed"),
        "resume_failed",
        { mode: "normalize" },
      );
      yield* emitProjectedDocState(session, "resume_failed");
    }
  } finally {
    const reSuspendedThisStream = activeSuspensionOwnedBy(session, streamId);
    const stillHoldingConsumedRun =
      session.runId === runId && session.toolCallId === toolCallId;
    if (
      !reSuspendedThisStream &&
      (!hasActiveSuspension(session) || stillHoldingConsumedRun)
    ) {
      clearSuspension(session);
    }

    if (session.streamId === streamId) {
      session.streamId = null;
    }
    // 残留 running 工具调用落终态,避免 resume 轮"调用完仍 loading"。
    for (const u of finalizeLingeringRunningToolCalls(session)) {
      yield { kind: "toolCallUpdated", data: { messageId: u.messageId, toolCallId: u.toolCallId, spec: u.spec } };
    }
    transitionDocState(session, deriveContentState(session), "agent_turn_finally_idle", {
      mode: "normalize",
    });
    yield* emitProjectedDocState(session, "agent_turn_finally_idle");
    yield { kind: "stream", data: { kind: "end", data: { streamId, reason: { kind: "done" } } } };

    // Safety-net persist: ensures the resumed agent response is captured
    // even if the fire-and-forget persist inside processAgentStream failed.
    await schedulePersist(session, "handleResume:finally").catch((err) => {
      console.error("[handleResume] Persist after finally failed:", err instanceof Error ? err.message : String(err));
    });
    if (omSidecarEnabled) {
      scheduleOmSidecarAfterTurn(session, resumeRequestContext, {
        turnIndex: omResumeTurnIndex,
        turnStartMessageIndex: omResumeStartMessageIndex,
      });
    }
    resolveActiveTurn();
    if (session._abortController === abortController) {
      session._abortController = null;
    }
    if (session._activeTurnPromise === activeTurnPromise) {
      session._activeTurnPromise = null;
    }
  }

  if (freshTurnPrompt !== null) {
    yield* runAgentTurn(session, freshTurnPrompt);
  }
}

/**
 * 重连前把活内存 session 的 doc 版本/正文对齐 DB(已提交的权威版本)。
 *
 * 必现 bug 根因:活内存 session 的 `docVersion` 因会话级并发写竞态(agent 写 + 用户编辑无串行化)
 * 被回设成陈旧值(低于 DB 真实版本)。页面刷新走 startSession→cached 分支,只 `emitRestoreFrames(cached)`
 * 重放这个陈旧 `session.docVersion`(documentSnapshotWritten 帧),客户端据此把 docVersionRef 设成过期值,
 * 下一次手动编辑发出过期 expectedDocumentSnapshot → commitDocumentOp 判 `current.docVersion !== expected`
 * → docWriteConflict。刷新只是再次命中同一陈旧 cached(故"刷新没用");唯有重启 server 清空内存、
 * 走 loadSessionFromThread 从 DB reconcile 才恢复。
 *
 * `documents.doc_version` 由 commitDocumentOp 与正文原子写入,是唯一权威。这里以它为准向上对齐
 * (只在 DB 更高时覆盖,绝不把内存的更新内容往回退)。失败不阻断 restore。
 */
async function reconcileCachedSessionDocFromDb(session: SessionState): Promise<boolean> {
  try {
    const docRow = await documentRepo.load(session.docId);
    if (docRow && docRow.docVersion > session.docVersion) {
      session.docVersion = docRow.docVersion;
      session.doc = docRow.pmDoc;
      session.legacySections = docRow.legacySections as unknown as LegacySection[];
      try {
        const committedAt = await getDocumentVersionCommittedAt(session.docId, docRow.docVersion);
        const committedAtMs = committedAt ? Date.parse(committedAt) : Number.NaN;
        if (Number.isFinite(committedAtMs)) {
          session.lastContentEditedAt = new Date(committedAtMs).toISOString();
        }
      } catch {
        // 正文已 DB-win 时仍需返回 true 并持久化；时间查询失败不能吞掉该信号。
      }
      // DB-win 说明正文已前进到内存 session 版本之后:此前基于旧版本锚点的 review/draft 态全部失效。
      // 必须清掉,否则 restore 会同时发 documentSnapshotWritten(新版) 与 docDiffReady(旧 base),
      // 前端拿旧锚点套新正文(冷恢复 threadPersistence 有此校验/清理,热恢复此前缺失 → 冷热不一致)。
      session.suggestions.clear();
      session.patchVerdicts.clear();
      session.patchValidationResults.clear();
      session.suggestionBaseDoc = null;
      session.suggestionBaseVersion = null;
      // 清 draft scratch(等价 core 的 clearInMemoryDraftDocs,直接清字段免动 core 公共导出)
      session.docDraftBaseSections = null;
      session.docDraftBaseVersion = null;
      session.docDraftBaseDoc = null;
      session.docDraftCandidateSections = null;
      session.docDraftCandidateDoc = null;
      // 同时终止 chatHistory 里 reviewable 的 docSuggestion toolCall:否则 emitRestoreFrames 的
      // chatHistory 重放(step4)会把 status="reviewing" 的旧建议发给前端,显示成可操作 review,
      // 但后端 suggestions 已清空 → accept/reject 找不到 patch。改成 failed 终止态使其不可操作。
      for (const message of session.chatHistory) {
        for (let i = 0; i < message.parts.length; i++) {
          const part = message.parts[i];
          if (
            part?.kind === "toolCall" &&
            part.data.name === "docSuggestion" &&
            part.data.status.kind === "reviewing"
          ) {
            message.parts[i] = {
              kind: "toolCall",
              data: {
                ...part.data,
                status: { kind: "failed", data: { retriable: false, reason: "文档已更新,此修改建议已失效" } },
              },
            };
          }
        }
      }
      return true;
    }
  } catch {
    // DB 读失败不阻断重连:保留内存态,restore 照常进行。
  }
  return false;
}

/**
 * Re-emit all state frames needed to restore the frontend workspace
 * from a persisted session. Called when mode.kind === "existing".
 */
export function* emitRestoreFrames(
  session: SessionState,
  options: { readOnly?: boolean } = {},
): Generator<BridgeFrame> {
  const readOnly = options.readOnly === true;
  if (!readOnly) {
    const rebuiltVisibleAnswerCards = appendMissingVisibleAskUserAnswerMessagesFromChatHistory(session);
    if (rebuiltVisibleAnswerCards > 0) {
      schedulePersist(session, "restore:askUser_visible_answer_cards").catch((err) => {
        console.error(
          "[restore] Persist after rebuilding askUser answer cards failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  // 1. Emit doc state after normalizing it against live restore facts.
  // In-memory suspended runs keep their tool overlay facts; cold restored
  // sessions have already terminalized stale toolCalls in loadSessionFromThread.
  if (readOnly) {
    yield* emitReadOnlyRestoreDocState(session);
  } else {
    yield* emitNormalizedRestoreDocState(session);
  }

  // 回放 AI 任务清单(与 docStateChanged 同路数:会话状态帧,页面刷新/重连恢复 pill)。
  if (session.todos.length > 0) {
    yield { kind: "todosChanged", data: { todos: session.todos } };
  }

  yield folderSourcesChangedFrame(session);

  // 2. Emit doc version if document exists
  if (session.legacySections.length > 0) {
    yield {
      kind: "documentSnapshotWritten",
      data: {
        doc: buildDocumentSnapshot(session.legacySections, session.docVersion, session.doc),
      },
    };
  }

  // 3. Emit materials as resources
  for (const mat of session.materials.values()) {
    const metadataWithFileId = { ...mat.metadata, fileId: mat.fileId };
    yield {
      kind: "resourceUpserted",
      data: {
        resource: {
          resourceRef: { id: mat.id, domain: { kind: "file" } },
          displayName: mat.filename,
          summary: mat.summary ?? "",
          mime: mat.mimeType,
          byteLen: mat.text.length,
          createdAt: mat.createdAt,
          metadata: metadataWithFileId,
        },
      },
    };
  }

  // 4. Emit chat messages from the restored session.
  // If chatHistory exists (rich format with tool bubbles, thinking parts),
  // use it for full-fidelity restore. Otherwise fall back to plain text
  // from session.messages for backward compatibility.
  if (session.chatHistory.length > 0) {
    // Rich restore path: emit full ChatMessages with all parts
    for (const msg of session.chatHistory) {
      // appendSeq 基线(0702 review Lane A):生成进行中触发 restore 快照时,该消息
      // 后续直播 chatMessageAppended 的 seq 延续 seqCounters 计数(而非从 1 重新数)。
      // 前端 restoreReset 清空 appendCursor 后只应用严格连续 seq === cursor+1 的增量,
      // 缺基线会把进行中消息永久冻结(且 restoreReset 广播会冻住同会话全部标签页)。
      // 铁律:基线读取与消息深拷贝必须在同一同步 tick 内完成——emitRestoreFrames 到
      // frameLog.append 之间存在微任务间隙(collectRestoreFrames 的 await / .then),
      // 活跃轮次可能继续 push parts + 涨计数,若拷贝晚于基线读取,快照内容会多于基线,
      // 增量被重复应用(正文重复);反之则内容缺失。原子捕获后两个方向都不会错位。
      const appendSeq = session.seqCounters.get(msg.id) ?? 0;
      yield {
        kind: "chatMessageAdded",
        data: { message: structuredClone(msg), appendSeq },
      };

      // For toolCall parts with a terminal status, also emit toolCallUpdated
      // so the frontend's toolCalls Map gets populated for badge rendering.
      for (const part of msg.parts) {
        if (part.kind === "toolCall") {
          yield {
            kind: "toolCallUpdated",
            data: {
              messageId: msg.id,
              toolCallId: part.data.id,
              spec: structuredClone(part.data),
            },
          };
        }
      }
    }
  } else {
    // Legacy restore path: plain text only (no tool bubbles)
    for (const msg of session.messages) {
      // Skip messages that are not user or assistant (pure tool results)
      if (msg.role !== "user" && msg.role !== "assistant") continue;

      let rawContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter(
                  (p): p is { type: "text"; text: string } =>
                    typeof p === "object" && p !== null && "type" in p && p.type === "text",
                )
                .map((p) => p.text)
                .join("")
            : "";

      // Clean injected metadata (doc snapshots, line numbers, system reminders)
      const content = cleanRestoredText(rawContent);

      // Skip messages with empty text after cleaning
      if (!content || content.trim().length === 0) continue;

      yield {
        kind: "chatMessageAdded",
        data: {
          message: {
            id: (msg as { id?: string }).id ?? crypto.randomUUID(),
            role: { kind: msg.role === "user" ? "user" : "agent" },
            ts:
              (msg as { createdAt?: string }).createdAt ??
              new Date().toISOString(),
            parts: [{ kind: "text", data: { body: content } }],
            chips: null,
          },
          // legacy 路径重放的都是已完结消息,不会再有直播增量,基线恒为 0。
          appendSeq: 0,
        },
      };
    }
  }

  // 5. Ensure restored review sessions repopulate patch review state even
  // if the chat history was written by an older metadata version.
  if (
    session.docState.kind === "pendingReview" &&
    session.suggestions.size > 0
  ) {
    yield {
      kind: "docDiffReady",
      data: {
        baseVersion: session.suggestionBaseVersion ?? session.docVersion,
        suggestions: [...session.suggestions.values()].map((record) => record.suggestion),
        ...(session.suggestionBaseDoc ? { previewDoc: session.suggestionBaseDoc } : {}),
        ...(session.docDraftCandidateDoc ? { editedDoc: session.docDraftCandidateDoc } : {}),
      },
    };
    for (const [suggestionId, record] of session.suggestions) {
      const verdict = session.patchVerdicts.get(suggestionId);
      const status: ToolCallStatus =
        verdict === "accepted"
          ? { kind: "accepted" }
          : verdict === "rejected"
            ? { kind: "rejected" }
            : { kind: "reviewing" };
      yield {
        kind: "toolCallUpdated",
        data: {
          messageId: record.messageId,
          toolCallId: suggestionId,
          spec: buildRestoredSuggestionToolCallSpec(record.suggestion, status),
        },
      };
    }
  }
}

function buildRestoredSuggestionToolCallSpec(
  suggestion: DocSuggestion,
  status: ToolCallStatus,
): ToolCallSpec {
  return {
    id: suggestion.id,
    name: "docSuggestion",
    render: { kind: "docInlinePatch" },
    status,
    body: {
      kind: "docSuggestion",
      data: { kind: "suggestion", data: suggestion },
    },
    result: suggestion.conflict
      ? { kind: "genericText", data: suggestion.conflict.message }
      : null,
  };
}

/**
 * Look up a material by ID within a specific session.
 * Scoping by sessionId prevents cross-session data leakage.
 */
export function findMaterial(sessionId: string, materialId: string): Material | undefined {
  const session = sessions.get(sessionId);
  return session?.materials.get(materialId);
}

/**
 * Look up session state by sessionId. Used by the /api/v1/ask-more route
 * to access conversation messages for building a summary.
 */
export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export async function collectRestoreFrames(sessionId: string): Promise<BridgeFrame[]> {
  const session = await getOrRestoreSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  // 只给 /events gap/epoch restore 使用:它不经过 SessionActor 串行泵,可能与活跃生成轮次
  // 并发。这里必须是纯读快照,所有会变异会话状态的归一化/终态化/reconcile 只允许发生在
  // actor 内的 startSession(existing) 命令路径。
  return [
    { kind: "sessionMeta", data: { sessionId, title: session.title } },
    ...emitRestoreFrames(session, { readOnly: true }),
  ];
}

/**
 * 取会话:内存命中直接用;未命中则从 thread 持久层冷加载并放回内存。
 * 修复"后端重启/热重载/部署后内存 session 丢失——文档已从持久层恢复显示,但
 * 编辑(updateDoc)/对话(sendMessage)/素材/文件夹命令全报 Session not found"。
 * startSession existing 分支与 export 路径早有此冷加载兜底,各命令分支此前漏了。
 * 生产隐患尤甚:推 main 自动部署=重启,会让所有活跃会话的后续编辑/追问永久失效。
 */
const restoreInflight = new Map<string, Promise<SessionState | undefined>>();

function restoreInflightKey(
  sessionId: string,
  options: { preferredAskUserToolCallId?: string | null } = {},
): string {
  return `${sessionId}\0${options.preferredAskUserToolCallId ?? ""}`;
}

function normalizedRestoreOptions(
  options: { preferredAskUserToolCallId?: string | null } = {},
): { preferredAskUserToolCallId: string } | undefined {
  return typeof options.preferredAskUserToolCallId === "string" &&
    options.preferredAskUserToolCallId.length > 0
    ? { preferredAskUserToolCallId: options.preferredAskUserToolCallId }
    : undefined;
}

export async function getOrRestoreSession(
  sessionId: string,
  options: { preferredAskUserToolCallId?: string | null } = {},
): Promise<SessionState | undefined> {
  const restoreOptions = normalizedRestoreOptions(options);
  const cached = sessions.get(sessionId);
  if (cached) {
    if (!restoreOptions || cached.runId) return cached;
    const restored = await loadSessionFromThread(sessionId, restoreOptions);
    if (restored?.runId) {
      sessions.set(sessionId, restored);
      return restored;
    }
    return cached;
  }
  // 并发去重:同一 session 的并发冷命令共用一条恢复 promise,避免恢复出两个
  // SessionState 后相互覆盖(后返回的把内存态连同已发生的 docVersion/busy/materials 改动盖回旧对象)。
  const inflightKey = restoreInflightKey(sessionId, options);
  let inflight = restoreInflight.get(inflightKey);
  if (!inflight) {
    inflight = (async () => {
      const restored = restoreOptions
        ? await loadSessionFromThread(sessionId, restoreOptions)
        : await loadSessionFromThread(sessionId);
      if (!restored) return undefined;
      // await 期间可能已有别的路径(如 startSession existing)把 session 放回内存,以内存态为准,不覆盖。
      const existing = sessions.get(sessionId);
      if (existing) {
        if (restoreOptions && !existing.runId && restored.runId) {
          sessions.set(sessionId, restored);
          return restored;
        }
        return existing;
      }
      sessions.set(sessionId, restored);
      return restored;
    })().finally(() => {
      restoreInflight.delete(inflightKey);
    });
    restoreInflight.set(inflightKey, inflight);
  }
  return inflight;
}

/**
 * 会话是否已存在(内存命中或持久层可恢复)。供 /commands 的 startSession(new) 覆写防护
 * 预检使用。getOrRestoreSession 命中持久层时会顺带把会话载回内存缓存,副作用无害。
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  if (sessions.has(sessionId)) return true;
  const restored = await getOrRestoreSession(sessionId);
  return restored !== undefined;
}

export function forgetSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  session?._abortController?.abort();
  const deleted = sessions.delete(sessionId);
  folderSourceOperationQueues.delete(sessionId);
  unregisterSessionFolderSources(sessionId);
  unregisterBrowserFolderSession(sessionId);
  invalidateSessionWorkspace(sessionId);
  return deleted;
}

function findSessionByStream(streamId: string): SessionState | undefined {
  for (const session of sessions.values()) {
    if (session.streamId === streamId) {
      return session;
    }
  }
  return undefined;
}

export function findSessionByPatch(patchId: string): SessionState | undefined {
  for (const session of sessions.values()) {
    if (session.suggestions?.has(patchId)) {
      return session;
    }
  }
  return undefined;
}

export function findSessionByReviewBatchId(reviewBatchId: string): SessionState | undefined {
  for (const session of sessions.values()) {
    for (const record of session.suggestions?.values() ?? []) {
      const candidate =
        record.suggestion.reviewBatchId ??
        record.diffHunk?.reviewBatchId ??
        record.suggestion.id;
      if (candidate === reviewBatchId) {
        return session;
      }
    }
  }
  return undefined;
}

export const sessionManager = new SessionManager({
  handleCommand: (command, clientTraceId, origin, modelOverrides, client) =>
    handleCommand(command, clientTraceId, origin, modelOverrides, client),
  abortSession: (sessionId) => {
    sessions.get(sessionId)?._abortController?.abort();
  },
  cleanupSession: (sessionId) => {
    forgetSession(sessionId);
  },
});

export async function disposeAllSessionsForShutdown(): Promise<void> {
  // 先快照所有活跃轮的收尾 promise:dispose/forgetSession 会 abort 它们,但 abort 只是发信号,
  // 真正的收尾(含 chatHistory 落盘等持久化)在 _activeTurnPromise 结算时才完成。必须在 abort
  // 后 await 这些 promise,否则 shutdown 强杀正在写的轮 → 丢数据(回归旧 drainActiveTurnsForShutdown
  // 的 `await Promise.allSettled(_activeTurnPromise)` 语义,server-driven 改造不能丢)。
  const activeTurnPromises = Array.from(sessions.values())
    .map((session) => session._activeTurnPromise)
    .filter((p): p is Promise<void> => p != null);

  await sessionManager.disposeAll();
  for (const sessionId of [...sessions.keys()]) {
    forgetSession(sessionId);
  }

  // 等所有被 abort 的轮真正收尾完成(持久化落盘),再让进程退出。
  await Promise.allSettled(activeTurnPromises);
}
