import type { BridgeFrame, Command } from "@qingagent/contract-ts";
import {
  clearQuestionBranch,
  clearSessionSnapshot,
  currentPmDoc,
  deriveActiveOverlay,
  deriveAgentBusy,
  emitProjectedDocState,
  invalidateSessionWorkspace,
  hasNonEmptyCanonicalBase,
  terminateSessionBackgroundCommands,
  loadSessionFromThread,
  resolveSessionDocumentId,
  unregisterBrowserFolderSession,
  unregisterSessionFolderSources,
  type SessionState,
} from "./bridgeCore";
import { dispatchBridgeCommand } from "./commandRuntime";
import { forgetFolderSourceOperationQueue } from "./folderSourceRuntime";
import { SessionManager } from "./sessionManager";
import {
  beginSessionDeletion,
  listSessionDeletions,
  getSessionDeletion,
} from "@qingagent/db";
import { emitRestoreFrames } from "./restoreFrames";
import { sessions } from "./sessionRegistry";
import { confirmService } from "./bridgeCore";
import {
  reconcileRestoredAgentSuspension,
  reconcileRestoredConfirms,
} from "./confirmRecovery";
import { handleConfirmExpiry, registerConfirmSessionResolver } from "./confirmRuntime";
export {
  findSessionByPatch,
  findSessionByReviewBatchId,
  findSessionByStream,
  getSession,
  sessions,
} from "./sessionRegistry";

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

export function listSessionIdsForShutdownRecovery(): string[] {
  // persistence drain 也可能卡在已经 idle 的脏会话，因此恢复标记必须覆盖全部已加载
  // session，而不只是在退出瞬间仍有 _activeTurnPromise 的会话。
  return Array.from(sessions.keys());
}

export async function collectRestoreFrames(sessionId: string): Promise<BridgeFrame[]> {
  const session = await getOrRestoreSessionReadOnly(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  // 只给 /events gap/epoch restore 使用:它不经过 SessionActor 串行泵,可能与活跃生成轮次
  // 并发。这里必须是纯读快照,所有会变异会话状态的归一化/终态化/reconcile 只允许发生在
  // actor 内的 startSession(existing) 命令路径。
  return [
    { kind: "sessionMeta", data: { sessionId, title: session.title } },
    ...emitRestoreFrames(session, { readOnly: true }),
    { kind: "sessionRestoreCompleted", data: { sessionId } },
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
const readOnlyRestoreInflight = new Map<string, Promise<SessionState | undefined>>();

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

function mergeRestoredSuspension(cached: SessionState, restored: SessionState): SessionState {
  // C1②：cached 可能已有尚未持久化的聊天、正文、素材或标题。整体替换成 DB
  // 恢复对象会把这些内存改动回退；这里只补 resumeAskUser 真正需要的挂起身份。
  cached.runId = restored.runId;
  cached.toolCallId = restored.toolCallId;
  cached.previousDocState = restored.previousDocState ?? cached.previousDocState;
  cached._suspendedThisTurn = restored._suspendedThisTurn;
  cached._suspensionOwner = restored._suspensionOwner;
  // 两个 askUser 标记都是单向事实，恢复旧快照时只能补真，不能抹掉内存中的真值。
  cached._askUserCompleted =
    cached._askUserCompleted === true || restored._askUserCompleted === true;
  cached._askUserAsked =
    cached._askUserAsked === true || restored._askUserAsked === true;
  return cached;
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
    if (restored?.runId && !cached.runId) {
      await reconcileRestoredAgentSuspension(restored);
      await reconcileRestoredConfirms(restored);
      mergeRestoredSuspension(cached, restored);
      armSessionConfirmTimeouts(cached);
      return cached;
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
      await reconcileRestoredAgentSuspension(restored);
      await reconcileRestoredConfirms(restored);
      // await 期间可能已有别的路径(如 startSession existing)把 session 放回内存,以内存态为准,不覆盖。
      const existing = sessions.get(sessionId);
      if (existing) {
        if (restoreOptions && !existing.runId && restored.runId) {
          mergeRestoredSuspension(existing, restored);
          armSessionConfirmTimeouts(existing);
          return existing;
        }
        return existing;
      }
      sessions.set(sessionId, restored);
      armSessionConfirmTimeouts(restored);
      return restored;
    })().finally(() => {
      restoreInflight.delete(inflightKey);
    });
    restoreInflight.set(inflightKey, inflight);
  }
  return inflight;
}

/**
 * 只读冷恢复：优先复用已注册会话；内存 miss 时只加载临时快照，不写入 sessions。
 * 外部读取与 SSE restore 可因此读取任意历史会话，而不会让全局注册表随访问量常驻增长。
 */
export async function getOrRestoreSessionReadOnly(
  sessionId: string,
): Promise<SessionState | undefined> {
  const cached = sessions.get(sessionId);
  if (cached) return cached;

  let inflight = readOnlyRestoreInflight.get(sessionId);
  if (!inflight) {
    inflight = loadSessionFromThread(sessionId, { mode: "snapshot" })
      .then((restored) => restored ?? undefined)
      .finally(() => {
        readOnlyRestoreInflight.delete(sessionId);
      });
    readOnlyRestoreInflight.set(sessionId, inflight);
  }

  const restored = await inflight;
  // 加载期间若写命令已注册同一会话，以活跃内存态为准；否则返回不注册的临时快照。
  return sessions.get(sessionId) ?? restored;
}

/**
 * 会话是否已存在(内存命中或持久层可恢复)。供 /commands 的 startSession(new) 覆写防护
 * 预检使用。预检是只读路径，冷恢复不得把历史会话写入常驻注册表。
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  if (sessions.has(sessionId)) return true;
  const restored = await getOrRestoreSessionReadOnly(sessionId);
  return restored !== undefined;
}

export function forgetSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  session?._abortController?.abort();
  if (session) confirmService.clearSession(session);
  clearSessionConfirmTimeouts(sessionId);
  clearExternalBusyLeaseTimer(sessionId);
  const deleted = sessions.delete(sessionId);
  forgetFolderSourceOperationQueue(sessionId);
  unregisterSessionFolderSources(sessionId);
  unregisterBrowserFolderSession(sessionId);
  invalidateSessionWorkspace(sessionId);
  clearSessionSnapshot(sessionId);
  clearQuestionBranch(sessionId);
  return deleted;
}

async function closeSessionRuntime(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    await terminateSessionBackgroundCommands(session, "sessionClosed");
  }
  forgetSession(sessionId);
}

// confirmRuntime 不得反向依赖本模块(依赖环);它取会话统一走这里注册的解析器。
registerConfirmSessionResolver(getOrRestoreSession);

/**
 * 新消息只可抢占可安全重来的普通轮次。审查轮与确认卡都承载了用户已明确发起的工作，
 * 必须排队等其收口；显式 cancelStream 在 SessionActor 中走 globalStop，故不受本保护集阻挡。
 */
export function hasProtectedSessionWork(
  session: SessionState | undefined,
  activeCommand?: Command,
): boolean {
  if (
    activeCommand?.kind === "sendMessage" &&
    activeCommand.data.reviewContext !== undefined
  ) {
    return true;
  }
  if (!session) return false;
  if (session._activeConfirmedToolCallId) return true;
  for (const pending of session.pendingConfirms.values()) {
    if (pending.status === "pending" || pending.status === "resuming") return true;
  }
  return false;
}

export const sessionManager = new SessionManager({
  handleCommand: dispatchBridgeCommand,
  abortSession: (sessionId, reason) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (reason === "globalStop") {
      session._userCancelGeneration += 1;
    }
    session._abortController?.abort(reason);
  },
  cleanupSession: closeSessionRuntime,
  resolveSessionDocumentId: async (sessionId) =>
    sessions.get(sessionId)?.docId ?? resolveSessionDocumentId(sessionId),
  deletionStore: {
    begin: beginSessionDeletion,
    list: listSessionDeletions,
    get: getSessionDeletion,
  },
  deleteSessionThread: async (sessionId) => {
    const { deleteSessionWithStoredResources } = await import("./sessionStoredResources");
    return deleteSessionWithStoredResources(sessionId);
  },
  afterRun: (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) armSessionConfirmTimeouts(session);
  },
  hasProtectedWork: (sessionId, activeCommand) => {
    const session = sessions.get(sessionId);
    return hasProtectedSessionWork(session, activeCommand);
  },
  hasRuntimeBusy: (sessionId) => {
    const session = sessions.get(sessionId);
    return session ? deriveAgentBusy(session) : false;
  },
  hasExternalBusyLease: (sessionId) => {
    const lease = sessions.get(sessionId)?.externalBusyLease;
    return lease !== null && lease !== undefined && lease.expiresAt > Date.now();
  },
});

export const EXTERNAL_BUSY_LEASE_TTL_MS = 60_000;

export type ExternalTurnSignalAction = "begin" | "end" | "heartbeat";

export interface ExternalTurnSignalResult {
  found: boolean;
  active: boolean;
  expiresAt: number | null;
  errorCode?: "BUSY_NATIVE" | "LEASE_HELD";
  cancelled?: boolean;
}

interface ExternalBusyLeaseTimerEntry {
  principalId: string;
  turnId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const externalBusyLeaseTimers = new Map<string, ExternalBusyLeaseTimerEntry>();

/** 所有租约变更都通过会话 Actor 串行化；HTTP handler 不直接写 SessionState。 */
export async function signalExternalBusyLease(input: {
  sessionId: string;
  principalId: string;
  turnId: string;
  action: ExternalTurnSignalAction;
  deadline?: number;
  signal?: AbortSignal;
}): Promise<ExternalTurnSignalResult> {
  let found = false;
  let active = false;
  let expiresAt: number | null = null;
  let errorCode: ExternalTurnSignalResult["errorCode"];
  let cancelled = false;

  await sessionManager.runExclusive(input.sessionId, async function* () {
    if (
      input.action === "begin"
      && (input.signal?.aborted === true || Date.now() >= (input.deadline ?? Infinity))
    ) {
      cancelled = true;
      return;
    }
    const session = await getOrRestoreSession(input.sessionId);
    if (!session) return;
    found = true;
    const now = Date.now();
    const current = session.externalBusyLease;
    const sameOwner = current !== null
      && current.principalId === input.principalId
      && current.turnId === input.turnId;
    const currentIsActive = current !== null && current.expiresAt > now;
    const sameActiveOwner = sameOwner && currentIsActive;

    if (input.action === "end") {
      if (sameOwner) {
        session.externalBusyLease = null;
        clearExternalBusyLeaseTimer(input.sessionId);
        yield* emitProjectedDocState(session, "external_busy_lease_ended");
      }
    } else if (input.action === "begin") {
      if (session.streamId !== null || deriveActiveOverlay(session) !== null) {
        errorCode = "BUSY_NATIVE";
      } else if (currentIsActive && !sameOwner) {
        errorCode = "LEASE_HELD";
      } else {
        // A2 续期继承铁律：同主未过期 begin 只改 expiresAt；新段才重算空稿标志与计数。
        session.externalBusyLease = sameActiveOwner
          ? { ...current!, expiresAt: now + EXTERNAL_BUSY_LEASE_TTL_MS }
          : {
              principalId: input.principalId,
              turnId: input.turnId,
              expiresAt: now + EXTERNAL_BUSY_LEASE_TTL_MS,
              startedFromEmpty: !hasNonEmptyCanonicalBase(session, currentPmDoc(session)),
              directCommitCount: 0,
            };
        armExternalBusyLeaseTimer(session);
        yield* emitProjectedDocState(session, "external_busy_lease_began");
      }
    } else if (input.action === "heartbeat") {
      if (session.streamId !== null || deriveActiveOverlay(session) !== null) {
        // F3/H3:心跳观察到原生回合时显式返回 BUSY_NATIVE，由客户端走 recovery begin。
        errorCode = "BUSY_NATIVE";
      } else if (currentIsActive && !sameOwner) {
        // F3:异主心跳必须明确返回 LEASE_HELD，客户端据此把本段收为 lost。
        errorCode = "LEASE_HELD";
      } else if (sameActiveOwner) {
        // heartbeat 同样只续 expiresAt，绝不刷新 startedFromEmpty/directCommitCount。
        session.externalBusyLease = {
          ...current!,
          expiresAt: now + EXTERNAL_BUSY_LEASE_TTL_MS,
        };
        armExternalBusyLeaseTimer(session);
        yield* emitProjectedDocState(session, "external_busy_lease_heartbeat");
      }
    }

    const next = session.externalBusyLease;
    active = next !== null
      && next.expiresAt > now
      && next.principalId === input.principalId
      && next.turnId === input.turnId;
    expiresAt = active ? next!.expiresAt : null;
  }, input.action === "begin"
    ? { rejectIfAgentTurnDispatchPending: true }
    : {});

  return {
    found,
    active,
    expiresAt,
    ...(errorCode ? { errorCode } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

function armExternalBusyLeaseTimer(session: SessionState): void {
  const lease = session.externalBusyLease;
  if (!lease) {
    clearExternalBusyLeaseTimer(session.sessionId);
    return;
  }
  clearExternalBusyLeaseTimer(session.sessionId);
  const entry = {
    principalId: lease.principalId,
    turnId: lease.turnId,
    expiresAt: lease.expiresAt,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  } satisfies ExternalBusyLeaseTimerEntry;
  entry.timer = setTimeout(
    () => expireExternalBusyLease(session.sessionId, entry),
    Math.max(0, lease.expiresAt - Date.now()),
  );
  entry.timer.unref?.();
  externalBusyLeaseTimers.set(session.sessionId, entry);
}

async function expireExternalBusyLease(
  sessionId: string,
  expected: ExternalBusyLeaseTimerEntry,
): Promise<void> {
  try {
    await sessionManager.runExclusive(sessionId, async function* () {
      const session = await getOrRestoreSession(sessionId);
      if (!session) return;
      const lease = session.externalBusyLease;
      if (
        !lease
        || lease.principalId !== expected.principalId
        || lease.turnId !== expected.turnId
        || lease.expiresAt !== expected.expiresAt
      ) {
        return;
      }
      if (lease.expiresAt > Date.now()) {
        armExternalBusyLeaseTimer(session);
        return;
      }
      session.externalBusyLease = null;
      if (externalBusyLeaseTimers.get(sessionId) === expected) {
        externalBusyLeaseTimers.delete(sessionId);
      }
      yield* emitProjectedDocState(session, "external_busy_lease_expired");
    });
  } catch {
    // 会话删除/关闭与到期竞态时无需复活运行态；引擎重启本来也要求全解锁。
  } finally {
    if (externalBusyLeaseTimers.get(sessionId) === expected) {
      externalBusyLeaseTimers.delete(sessionId);
    }
  }
}

function clearExternalBusyLeaseTimer(sessionId: string): void {
  const entry = externalBusyLeaseTimers.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  externalBusyLeaseTimers.delete(sessionId);
}

interface ConfirmTimerEntry {
  expiresAt: string;
  timer: ReturnType<typeof setTimeout>;
}

const confirmTimers = new Map<string, Map<string, ConfirmTimerEntry>>();

function clearSessionConfirmTimeouts(sessionId: string): void {
  const entries = confirmTimers.get(sessionId);
  if (!entries) return;
  for (const entry of entries.values()) clearTimeout(entry.timer);
  confirmTimers.delete(sessionId);
}

function armSessionConfirmTimeouts(session: SessionState): void {
  let entries = confirmTimers.get(session.sessionId);
  if (!entries) {
    entries = new Map();
    confirmTimers.set(session.sessionId, entries);
  }
  const pendingIds = new Set<string>();
  for (const pending of session.pendingConfirms.values()) {
    if (pending.status !== "pending") continue;
    pendingIds.add(pending.toolCallId);
    if (entries.get(pending.toolCallId)?.expiresAt === pending.expiresAt) continue;
    const previous = entries.get(pending.toolCallId);
    if (previous) clearTimeout(previous.timer);
    const delay = Math.max(0, Date.parse(pending.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      entries?.delete(pending.toolCallId);
      void sessionManager.runExclusive(
        session.sessionId,
        () => handleConfirmExpiry(session.sessionId, pending.toolCallId),
      ).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    entries.set(pending.toolCallId, { expiresAt: pending.expiresAt, timer });
  }
  for (const [toolCallId, entry] of entries) {
    if (pendingIds.has(toolCallId)) continue;
    clearTimeout(entry.timer);
    entries.delete(toolCallId);
  }
  if (entries.size === 0) confirmTimers.delete(session.sessionId);
}

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
    await closeSessionRuntime(sessionId);
  }

  // 等所有被 abort 的轮真正收尾完成(持久化落盘),再让进程退出。
  await Promise.allSettled(activeTurnPromises);
}
