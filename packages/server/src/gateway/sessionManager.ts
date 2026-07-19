import type { Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "@qingagent/core";
import {
  deleteSessionThread,
  drainSessionPersistenceForSession,
  markSessionDeleted,
  unmarkSessionDeleted,
} from "@qingagent/core";
import { InMemoryFrameLog, type FrameLog, type LoggedFrame } from "./frameLog";
import {
  SessionActor,
  type CommandOrigin,
  type HandleCommandFn,
} from "./sessionActor";

export interface SessionManagerOptions {
  handleCommand: HandleCommandFn;
  abortSession: (sessionId: string) => void;
  cleanupSession: (sessionId: string) => void | Promise<void>;
  frameLog?: FrameLog;
  maxActors?: number;
  markSessionDeleted?: (sessionId: string, docId?: string) => void;
  unmarkSessionDeleted?: (sessionId: string) => void;
  resolveSessionDocumentId?: (sessionId: string) => Promise<string>;
  drainSessionPersistence?: (sessionId: string, timeoutMs: number) => Promise<void>;
  deleteSessionThread?: (sessionId: string) => Promise<void>;
  deletionRetryDelayMs?: number;
}

export interface SubmitCommandInput {
  command: Command;
  clientTraceId?: string;
  origin?: CommandOrigin;
  client?: string;
  modelOverrides?: ModelOverrides;
  abortSignal?: AbortSignal;
}

interface ActorEntry {
  actor: SessionActor;
  lastAccessAt: number;
}

export class SessionManager {
  readonly frameLog: FrameLog;
  private readonly actors = new Map<string, ActorEntry>();
  private readonly deletingSessions = new Set<string>();
  private readonly destroyedSessions = new Set<string>();
  private readonly backgroundDeletionJobs = new Map<string, Promise<void>>();
  private readonly maxActors: number;

  constructor(private readonly options: SessionManagerOptions) {
    this.frameLog = options.frameLog ?? new InMemoryFrameLog();
    this.maxActors = options.maxActors ?? 256;
  }

  submit(sessionId: string, input: SubmitCommandInput): Promise<LoggedFrame[]> {
    if (this.deletingSessions.has(sessionId)) {
      return Promise.reject(new Error("Session deletion is in progress"));
    }
    if (this.destroyedSessions.has(sessionId)) {
      return Promise.reject(new Error("Session has been deleted"));
    }
    const actor = this.getOrCreateActor(sessionId);
    return actor.enqueue(input);
  }

  async disposeSession(sessionId: string): Promise<void> {
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
    const sessionIds = [...this.actors.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.disposeSession(sessionId)));
  }

  async destroySession(sessionId: string, timeoutMs = 5_000): Promise<void> {
    if (this.destroyedSessions.has(sessionId)) return;
    if (this.deletingSessions.has(sessionId)) {
      throw new Error("Session deletion is in progress");
    }
    this.deletingSessions.add(sessionId);
    let docId: string;
    try {
      docId = await (this.options.resolveSessionDocumentId?.(sessionId) ?? Promise.resolve(sessionId));
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
      return;
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
      return;
    }
    try {
      await (this.options.deleteSessionThread ?? deleteSessionThread)(sessionId);
    } catch (error) {
      this.rollbackDeletion(sessionId);
      throw error;
    }
    this.completeDeletion(sessionId);
  }

  getActorState(sessionId: string): SessionActor["state"] | null {
    return this.actors.get(sessionId)?.actor.state ?? null;
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
    this.destroyedSessions.add(sessionId);
  }

  private rollbackDeletion(sessionId: string): void {
    this.deletingSessions.delete(sessionId);
    this.destroyedSessions.delete(sessionId);
    (this.options.unmarkSessionDeleted ?? unmarkSessionDeleted)(sessionId);
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
      while (this.deletingSessions.has(sessionId)) {
        await delay(retryDelayMs);
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
        } catch (error) {
          this.rollbackDeletion(sessionId);
          console.error("[sessionManager] background session deletion failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    })().finally(() => {
      this.backgroundDeletionJobs.delete(sessionId);
    });
    this.backgroundDeletionJobs.set(sessionId, job);
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
