import type { Command } from "@qingagent/contract-ts";
import type { ModelOverrides } from "@qingagent/core";
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
}

export interface SubmitCommandInput {
  command: Command;
  clientTraceId?: string;
  origin?: CommandOrigin;
  modelOverrides?: ModelOverrides;
}

interface ActorEntry {
  actor: SessionActor;
  lastAccessAt: number;
}

export class SessionManager {
  readonly frameLog: FrameLog;
  private readonly actors = new Map<string, ActorEntry>();
  private readonly maxActors: number;

  constructor(private readonly options: SessionManagerOptions) {
    this.frameLog = options.frameLog ?? new InMemoryFrameLog();
    this.maxActors = options.maxActors ?? 256;
  }

  submit(sessionId: string, input: SubmitCommandInput): Promise<LoggedFrame[]> {
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
