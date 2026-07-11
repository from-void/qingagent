import { randomBytes } from "node:crypto";

export interface PendingPublicEntry {
  pendingId: string;
  connectorId: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingEntry<T> extends PendingPublicEntry {
  value: T;
  signal: AbortSignal;
}

interface StoredPending<T> extends PendingEntry<T> {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingStoreError extends Error {
  constructor(
    message: string,
    readonly code: "PENDING_LOST" | "PENDING_EXPIRED" | "PENDING_CAPACITY",
    readonly status: 410 | 429,
  ) {
    super(message);
    this.name = "PendingStoreError";
  }
}

export interface PendingStoreOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
  createId?: () => string;
}

export interface StartPendingInput<T> {
  connectorId: string;
  scope: string;
  create: (context: { pendingId: string; signal: AbortSignal }) => T;
}

export interface StartPendingResult<T> {
  entry: PendingEntry<T>;
  reused: boolean;
}

function defaultPendingId(): string {
  return randomBytes(24).toString("base64url");
}

export class PendingStore<T> {
  private readonly entries = new Map<string, StoredPending<T>>();
  private readonly byBinding = new Map<string, string>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private detachProcessHooks: (() => void) | null = null;

  constructor(options: PendingStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.capacity = options.capacity ?? 100;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultPendingId;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("pending TTL 必须为正数");
    }
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new Error("pending 容量必须为正整数");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  start(input: StartPendingInput<T>): StartPendingResult<T> {
    this.sweepExpired();
    const binding = this.bindingKey(input.connectorId, input.scope);
    const existingId = this.byBinding.get(binding);
    if (existingId) {
      const existing = this.entries.get(existingId);
      if (existing) return { entry: this.toEntry(existing), reused: true };
      this.byBinding.delete(binding);
    }
    if (this.entries.size >= this.capacity) {
      throw new PendingStoreError("待处理授权数量已达上限", "PENDING_CAPACITY", 429);
    }

    let pendingId = this.createId();
    while (this.entries.has(pendingId)) pendingId = this.createId();
    const controller = new AbortController();
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const value = input.create({ pendingId, signal: controller.signal });
    const timer = setTimeout(() => this.expire(pendingId), this.ttlMs);
    timer.unref?.();
    const stored: StoredPending<T> = {
      pendingId,
      connectorId: input.connectorId,
      scope: input.scope,
      createdAt,
      expiresAt,
      value,
      signal: controller.signal,
      controller,
      timer,
    };
    this.entries.set(pendingId, stored);
    this.byBinding.set(binding, pendingId);
    return { entry: this.toEntry(stored), reused: false };
  }

  get(pendingId: string, connectorId: string, scope: string): PendingEntry<T> {
    const stored = this.entries.get(pendingId);
    if (!stored || stored.connectorId !== connectorId || stored.scope !== scope) {
      throw new PendingStoreError("授权上下文已丢失，请重新发起", "PENDING_LOST", 410);
    }
    if (stored.expiresAt <= this.now()) {
      this.removeStored(stored, "pending expired");
      throw new PendingStoreError("授权已过期，请重新发起", "PENDING_EXPIRED", 410);
    }
    return this.toEntry(stored);
  }

  complete(pendingId: string, connectorId: string, scope: string): PendingEntry<T> {
    const entry = this.get(pendingId, connectorId, scope);
    const stored = this.entries.get(pendingId)!;
    this.removeStored(stored);
    return entry;
  }

  disconnect(connectorId: string, scope: string): boolean {
    const pendingId = this.byBinding.get(this.bindingKey(connectorId, scope));
    if (!pendingId) return false;
    const stored = this.entries.get(pendingId);
    if (!stored) {
      this.byBinding.delete(this.bindingKey(connectorId, scope));
      return false;
    }
    this.removeStored(stored, "connector disconnected");
    return true;
  }

  shutdown(): void {
    for (const stored of [...this.entries.values()]) {
      this.removeStored(stored, "process shutdown");
    }
    this.detachProcessHooks?.();
    this.detachProcessHooks = null;
  }

  attachProcessCleanup(
    processLike: Pick<NodeJS.Process, "once" | "off"> = process,
  ): () => void {
    this.detachProcessHooks?.();
    const cleanup = (): void => this.shutdown();
    // 只监听 exit：给 SIGINT/SIGTERM 注册 listener 会吞掉 Node 默认退出语义。
    // AbortController 的清理是同步的，适合在 exit 阶段执行；真正的优雅退出由宿主统一管理。
    processLike.once("exit", cleanup);
    const detach = (): void => {
      processLike.off("exit", cleanup);
      if (this.detachProcessHooks === detach) this.detachProcessHooks = null;
    };
    this.detachProcessHooks = detach;
    return detach;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const stored of this.entries.values()) {
      if (stored.expiresAt <= now) this.removeStored(stored, "pending expired");
    }
  }

  private expire(pendingId: string): void {
    const stored = this.entries.get(pendingId);
    if (stored) this.removeStored(stored, "pending expired");
  }

  private removeStored(stored: StoredPending<T>, abortReason?: string): void {
    clearTimeout(stored.timer);
    this.entries.delete(stored.pendingId);
    this.byBinding.delete(this.bindingKey(stored.connectorId, stored.scope));
    if (abortReason && !stored.signal.aborted) stored.controller.abort(abortReason);
  }

  private bindingKey(connectorId: string, scope: string): string {
    return `${connectorId}\u0000${scope}`;
  }

  private toEntry(stored: StoredPending<T>): PendingEntry<T> {
    return {
      pendingId: stored.pendingId,
      connectorId: stored.connectorId,
      scope: stored.scope,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      value: stored.value,
      signal: stored.signal,
    };
  }
}
