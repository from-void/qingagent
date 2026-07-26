import type { Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "@qingagent/core";
import type { SessionDeletionPhase } from "@qingagent/db";
import {
  deleteSessionThread,
  drainSessionPersistenceForSession,
  markSessionDeleted,
} from "@qingagent/core";
import { InMemoryFrameLog, type FrameLog, type LoggedFrame } from "./frameLog";
import {
  SessionActor,
  type CommandOrigin,
  type HandleCommandFn,
  type TurnPreemptionReason,
} from "./sessionActor";
import {
  SessionDeletedError,
  SessionDeletionInProgressError,
} from "./sessionErrors";

export interface SessionManagerOptions {
  handleCommand: HandleCommandFn;
  abortSession: (sessionId: string, reason?: TurnPreemptionReason) => void;
  cleanupSession: (sessionId: string) => void | Promise<void>;
  afterRun?: (sessionId: string) => void;
  frameLog?: FrameLog;
  maxActors?: number;
  markSessionDeleted?: (sessionId: string, docId?: string) => void;
  unmarkSessionDeleted?: (sessionId: string) => void;
  resolveSessionDocumentId?: (sessionId: string) => Promise<string>;
  drainSessionPersistence?: (sessionId: string, timeoutMs: number) => Promise<void>;
  deleteSessionThread?: (sessionId: string) => Promise<SessionDeletionPhase | void>;
  deletionRetryDelayMs?: number;
  deletionLookupCacheSize?: number;
  disposeWaitTimeoutMs?: number;
  deletionStore?: SessionDeletionStore;
}

export interface SessionDeletionStoreRecord {
  sessionId: string;
  phase: SessionDeletionPhase;
}

export interface SessionDeletionStore {
  begin(sessionId: string): Promise<SessionDeletionStoreRecord>;
  list(): Promise<SessionDeletionStoreRecord[]>;
  get(sessionId: string): Promise<SessionDeletionStoreRecord | null>;
}

export type DestroySessionResult =
  | { deleted: true; status: "completed" }
  | { deleted: false; status: "pending" };

export interface SubmitCommandInput {
  command: Command;
  clientTraceId?: string;
  origin?: CommandOrigin;
  client?: string;
  modelOverrides?: ModelOverrides;
  abortSignal?: AbortSignal;
}

export interface QueuedSubmission {
  completion: Promise<LoggedFrame[]>;
}

interface ActorEntry {
  actor: SessionActor;
  lastAccessAt: number;
}

const DISCONNECT_GRACE_PERIOD_MS = 15_000;

export class SessionManager {
  readonly frameLog: FrameLog;
  private readonly actors = new Map<string, ActorEntry>();
  private readonly disconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deletingSessions = new Set<string>();
  private readonly backgroundDeletionJobs = new Map<string, Promise<void>>();
  private readonly maxActors: number;
  private readonly deletionStore: SessionDeletionStore;
  private readonly deletionLookupCache = new Map<string, SessionDeletionPhase | null>();
  private readonly deletionLookupCacheSize: number;
  private readonly disposeWaitTimeoutMs: number;
  private deletionInitialization: Promise<void> | null = null;

  constructor(private readonly options: SessionManagerOptions) {
    this.frameLog = options.frameLog ?? new InMemoryFrameLog();
    this.maxActors = options.maxActors ?? 256;
    this.deletionLookupCacheSize = Math.max(1, Math.floor(options.deletionLookupCacheSize ?? 1_024));
    this.disposeWaitTimeoutMs = Math.max(
      1,
      Math.floor(options.disposeWaitTimeoutMs ?? 5_000),
    );
    this.deletionStore = options.deletionStore ?? createEphemeralDeletionStore();
  }

  async submit(sessionId: string, input: SubmitCommandInput): Promise<LoggedFrame[]> {
    const queued = await this.submitQueued(sessionId, input);
    return queued.completion;
  }

  /**
   * 只等待命令完成删除态检查并进入 Actor 有界队列，不等待整轮执行。
   * HTTP queued 语义端点用它同步感知队列满并返回 429。
   */
  async submitQueued(
    sessionId: string,
    input: SubmitCommandInput,
  ): Promise<QueuedSubmission> {
    await this.ensureDeletionStateRestored();
    await this.restoreDeletionStateForSession(sessionId);
    this.assertSessionAcceptsCommands(sessionId);
    const actor = this.getOrCreateActor(sessionId);
    return { completion: actor.enqueue(input) };
  }

  async runExclusive(
    sessionId: string,
    task: () => AsyncGenerator<import("@qingagent/contract-ts").BridgeFrame>,
  ): Promise<LoggedFrame[]> {
    await this.ensureDeletionStateRestored();
    await this.restoreDeletionStateForSession(sessionId);
    this.assertSessionAcceptsCommands(sessionId);
    const actor = this.getOrCreateActor(sessionId);
    return actor.enqueueTask(task);
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.clearDisconnectGraceTimer(sessionId);
    const entry = this.actors.get(sessionId);
    entry?.actor.dispose();
    this.actors.delete(sessionId);
    this.frameLog.evict(sessionId);
    try {
      await this.options.cleanupSession(sessionId);
    } catch (error) {
      console.error("[sessionManager] cleanupSession failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async disposeAll(): Promise<void> {
    for (const timer of this.disconnectGraceTimers.values()) clearTimeout(timer);
    this.disconnectGraceTimers.clear();
    const entries = [...this.actors.entries()];
    await Promise.all(entries.map(async ([sessionId, entry]) => {
      try {
        await withTimeout(
          entry.actor.disposeAndWait(),
          this.disposeWaitTimeoutMs,
          "active turn shutdown",
        );
      } catch (error) {
        console.warn("[sessionManager] active turn did not settle before shutdown", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.actors.delete(sessionId);
      this.frameLog.evict(sessionId);
      try {
        await this.options.cleanupSession(sessionId);
      } catch (error) {
        console.error("[sessionManager] cleanupSession failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  }

  async destroySession(
    sessionId: string,
    timeoutMs = 5_000,
  ): Promise<DestroySessionResult> {
    this.clearDisconnectGraceTimer(sessionId);
    await this.ensureDeletionStateRestored();
    await this.restoreDeletionStateForSession(sessionId);
    if (this.deletionLookupCache.get(sessionId) === "completed") {
      return { deleted: true, status: "completed" };
    }
    if (this.deletingSessions.has(sessionId)) {
      return { deleted: false, status: "pending" };
    }
    let docId: string;
    try {
      docId = await (this.options.resolveSessionDocumentId?.(sessionId) ?? Promise.resolve(sessionId));
      const tombstone = await this.deletionStore.begin(sessionId);
      this.cacheDeletionPhase(sessionId, tombstone.phase);
      if (tombstone.phase === "completed") {
        this.completeDeletion(sessionId);
        return { deleted: true, status: "completed" };
      }
      this.deletingSessions.add(sessionId);
      (this.options.markSessionDeleted ?? markSessionDeleted)(sessionId, docId);
    } catch (error) {
      this.deletingSessions.delete(sessionId);
      throw error;
    }

    const entry = this.actors.get(sessionId);
    const actorSettlement = entry?.actor.disposeAndWait() ?? Promise.resolve();
    let actorSettled = true;
    if (entry) {
      try {
        await withTimeout(actorSettlement, timeoutMs, "active turn");
      } catch (error) {
        actorSettled = false;
        console.warn("[sessionManager] active turn did not settle before deletion", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.actors.delete(sessionId);
    this.frameLog.evict(sessionId);

    try {
      await this.options.cleanupSession(sessionId);
    } catch (error) {
      console.error("[sessionManager] cleanupSession failed during deletion", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!actorSettled) {
      // 无法证明在途轮次已结束时绝不删库；墓碑与 deleting 状态保留到后台补删完成。
      this.scheduleDeletionRetry(sessionId, actorSettlement, timeoutMs);
      return { deleted: false, status: "pending" };
    }

    try {
      await (this.options.drainSessionPersistence ?? drainSessionPersistenceForSession)(
        sessionId,
        timeoutMs,
      );
    } catch (error) {
      console.warn("[sessionManager] persistence did not drain before deletion", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // 排空超时同样不能进入物理删除，否则已越过旧检查点的写会在删除后复建数据。
      this.scheduleDeletionRetry(sessionId, Promise.resolve(), timeoutMs);
      return { deleted: false, status: "pending" };
    }
    try {
      await (this.options.deleteSessionThread ?? deleteSessionThread)(sessionId);
    } catch (error) {
      console.error("[sessionManager] session deletion remains pending", {
        sessionId,
        phase: deletionErrorPhase(error),
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleDeletionRetry(sessionId, Promise.resolve(), timeoutMs);
      return { deleted: false, status: "pending" };
    }
    this.completeDeletion(sessionId);
    return { deleted: true, status: "completed" };
  }

  /** 服务启动时加载持久化墓碑；pending 会话在后台按原幂等删除链路续跑。 */
  async resumePendingDeletions(): Promise<void> {
    await this.ensureDeletionStateRestored();
  }

  getActorState(sessionId: string): SessionActor["state"] | null {
    return this.actors.get(sessionId)?.actor.state ?? null;
  }

  /**
   * 最后一个 SSE 订阅断开时，为仍在运行的 turn 调度可撤销宽限期。
   * 多标签页/重连重叠期只要还有订阅者就不动；同一会话重复断开只保留一个定时器。
   */
  async cancelRunningTurnAfterDisconnect(sessionId: string): Promise<boolean> {
    const live = this.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER);
    if (this.frameLog.hasSubscribers(sessionId) || !live.activeRunner) return false;
    if (this.disconnectGraceTimers.has(sessionId)) return true;

    const timer = setTimeout(() => {
      this.disconnectGraceTimers.delete(sessionId);
      void this.cancelRunningTurnAfterGracePeriod(sessionId);
    }, DISCONNECT_GRACE_PERIOD_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.disconnectGraceTimers.set(sessionId, timer);
    return true;
  }

  /** SSE 订阅建立后主动撤销旧宽限期，避免旧定时器影响重连后的活跃回合。 */
  subscriberConnected(sessionId: string): void {
    this.clearDisconnectGraceTimer(sessionId);
  }

  listSessionIds(limit = 20): string[] {
    const n = Math.max(0, Math.floor(limit));
    if (n === 0) return [];
    const ids = new Set<string>();
    for (const [sessionId] of [...this.actors.entries()].sort((a, b) => b[1].lastAccessAt - a[1].lastAccessAt)) {
      ids.add(sessionId);
      if (ids.size >= n) return [...ids];
    }
    for (const sessionId of this.frameLog.listSessionIds?.(n) ?? []) {
      ids.add(sessionId);
      if (ids.size >= n) break;
    }
    return [...ids];
  }

  getActorCountForTest(): number {
    return this.actors.size;
  }

  private completeDeletion(sessionId: string): void {
    this.deletingSessions.delete(sessionId);
    this.cacheDeletionPhase(sessionId, "completed");
  }

  private clearDisconnectGraceTimer(sessionId: string): void {
    const timer = this.disconnectGraceTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.disconnectGraceTimers.delete(sessionId);
  }

  private async cancelRunningTurnAfterGracePeriod(sessionId: string): Promise<void> {
    const live = this.frameLog.readFrom(sessionId, Number.MAX_SAFE_INTEGER);
    if (this.frameLog.hasSubscribers(sessionId) || !live.activeRunner) return;
    try {
      const queued = await this.submitQueued(sessionId, {
        command: { kind: "cancelStream", data: { sessionId } },
        origin: "agent",
      });
      void queued.completion.catch((error) => {
        console.error("[sessionManager] disconnect cleanup failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      console.error("[sessionManager] disconnect cleanup failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleDeletionRetry(
    sessionId: string,
    actorSettlement: Promise<void>,
    timeoutMs: number,
  ): void {
    if (this.backgroundDeletionJobs.has(sessionId)) return;
    const retryDelayMs = this.options.deletionRetryDelayMs ?? 1_000;
    const job = (async () => {
      await actorSettlement.catch((error) => {
        console.warn("[sessionManager] active turn failed while deletion was pending", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      let attempt = 0;
      while (this.deletingSessions.has(sessionId)) {
        const backoffMs = Math.min(retryDelayMs * 2 ** attempt, 30_000);
        await delay(backoffMs);
        attempt++;
        try {
          await (this.options.drainSessionPersistence ?? drainSessionPersistenceForSession)(
            sessionId,
            timeoutMs,
          );
        } catch (error) {
          console.warn("[sessionManager] persistence still pending during deletion retry", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        try {
          await (this.options.deleteSessionThread ?? deleteSessionThread)(sessionId);
          this.completeDeletion(sessionId);
          return;
        } catch (error) {
          console.error("[sessionManager] background session deletion failed", {
            sessionId,
            phase: deletionErrorPhase(error),
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
    })().finally(() => {
      this.backgroundDeletionJobs.delete(sessionId);
    });
    this.backgroundDeletionJobs.set(sessionId, job);
  }

  private async restoreDeletionState(): Promise<void> {
    const records = await this.deletionStore.list();
    for (const record of records) {
      if (record.phase === "completed") continue;
      this.cacheDeletionPhase(record.sessionId, record.phase);
      this.deletingSessions.add(record.sessionId);
      (this.options.markSessionDeleted ?? markSessionDeleted)(record.sessionId);
      this.scheduleDeletionRetry(record.sessionId, Promise.resolve(), 5_000);
    }
  }

  private cacheDeletionPhase(sessionId: string, phase: SessionDeletionPhase | null): void {
    this.deletionLookupCache.delete(sessionId);
    this.deletionLookupCache.set(sessionId, phase);
    while (this.deletionLookupCache.size > this.deletionLookupCacheSize) {
      const oldest = this.deletionLookupCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deletionLookupCache.delete(oldest);
    }
  }

  private async restoreDeletionStateForSession(sessionId: string): Promise<void> {
    if (this.deletingSessions.has(sessionId)) return;
    let phase: SessionDeletionPhase | null;
    if (this.deletionLookupCache.has(sessionId)) {
      phase = this.deletionLookupCache.get(sessionId) ?? null;
      this.cacheDeletionPhase(sessionId, phase);
    } else {
      phase = (await this.deletionStore.get(sessionId))?.phase ?? null;
      this.cacheDeletionPhase(sessionId, phase);
    }
    if (phase === "completed") {
      return;
    }
    if (phase) {
      this.deletingSessions.add(sessionId);
      (this.options.markSessionDeleted ?? markSessionDeleted)(sessionId);
      this.scheduleDeletionRetry(sessionId, Promise.resolve(), 5_000);
    }
  }

  private assertSessionAcceptsCommands(sessionId: string): void {
    if (this.deletingSessions.has(sessionId)) {
      throw new SessionDeletionInProgressError();
    }
    if (this.deletionLookupCache.get(sessionId) === "completed") {
      throw new SessionDeletedError();
    }
  }

  private ensureDeletionStateRestored(): Promise<void> {
    if (!this.deletionInitialization) {
      this.deletionInitialization = this.restoreDeletionState().catch((error) => {
        this.deletionInitialization = null;
        throw error;
      });
    }
    return this.deletionInitialization;
  }

  private getOrCreateActor(sessionId: string): SessionActor {
    const existing = this.actors.get(sessionId);
    if (existing) {
      existing.lastAccessAt = Date.now();
      return existing.actor;
    }

    const actor = new SessionActor({
      sessionId,
      frameLog: this.frameLog,
      handleCommand: this.options.handleCommand,
      abortSession: this.options.abortSession,
      afterRun: this.options.afterRun,
    });
    this.actors.set(sessionId, { actor, lastAccessAt: Date.now() });
    this.evictIdleActorsIfNeeded(sessionId);
    return actor;
  }

  private evictIdleActorsIfNeeded(protectedSessionId: string): void {
    while (this.actors.size > this.maxActors) {
      let candidate: [string, ActorEntry] | null = null;
      for (const entry of this.actors) {
        const [sessionId, actorEntry] = entry;
        if (sessionId === protectedSessionId || actorEntry.actor.isBusy) continue;
        // 0702 review Lane A(A8):空闲但仍被浏览(SSE 已订阅)的会话不能驱逐。
        // disposeSession 会 frameLog.evict 删掉带 listeners 的状态条目,后续帧经
        // ensure() 落进新建的空 listeners 条目——已连接的订阅者还在收 ping(连接看似
        // 健康)却永远收不到新帧,页面静默冻结直到手动刷新。与 InMemoryFrameLog 自身
        // 的条目驱逐保护(无订阅者且非 activeRunner 才可驱逐)同一范式;全员被订阅时
        // 宁可临时超过 maxActors(actor 本身很小,frameLog 条目另有上限)。
        if (this.frameLog.hasSubscribers(sessionId)) continue;
        if (!candidate || actorEntry.lastAccessAt < candidate[1].lastAccessAt) {
          candidate = entry;
        }
      }
      if (!candidate) return;
      void this.disposeSession(candidate[0]);
    }
  }
}

function createEphemeralDeletionStore(): SessionDeletionStore {
  const records = new Map<string, SessionDeletionStoreRecord>();
  return {
    async begin(sessionId) {
      const record = records.get(sessionId) ?? {
        sessionId,
        phase: "draining" as const,
      };
      records.set(sessionId, record);
      return record;
    },
    async list() {
      return [...records.values()].filter((record) => record.phase !== "completed");
    },
    async get(sessionId) {
      return records.get(sessionId) ?? null;
    },
  };
}

function deletionErrorPhase(error: unknown): string {
  if (typeof error === "object" && error && "phase" in error) {
    return String(error.phase);
  }
  return "unknown";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === "function") timer.unref();
  });
}
