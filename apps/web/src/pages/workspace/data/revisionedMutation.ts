/**
 * 工作区乐观 mutation 的统一并发原语。
 *
 * - 同一资源 key 同时只允许一个 mutation，避免迟到响应倒序覆盖；
 * - 每次 mutation 持有 revision token，权威帧到达时 reconcile 会推进 revision，
 *   令旧请求之后的失败回调无法回滚新状态；
 * - mutation 自己负责捕获完整快照、同步应用乐观态，并仅在 token 仍有效时回滚。
 */
export interface MutationToken {
  key: string;
  revision: number;
}

export interface MutationHandle<TResult> {
  token: MutationToken;
  promise: Promise<TResult>;
}

interface MutationEntry {
  revision: number;
  active: Promise<unknown> | null;
}

export class RevisionedMutationCoordinator {
  private readonly entries = new Map<string, MutationEntry>();

  isInFlight(key: string): boolean {
    return Boolean(this.entries.get(key)?.active);
  }

  isCurrent(token: MutationToken): boolean {
    return this.entries.get(token.key)?.revision === token.revision;
  }

  /**
   * 权威帧已经回正该资源。推进 revision 并释放单飞锁，任何旧请求的 catch
   * 都不得再把该帧覆盖回旧快照。
   */
  reconcile(key: string): number {
    const entry = this.entries.get(key) ?? { revision: 0, active: null };
    entry.revision += 1;
    entry.active = null;
    this.entries.set(key, entry);
    return entry.revision;
  }

  /**
   * 尝试启动一个乐观 mutation；同 key 已在途时返回 null。
   * capture/applyOptimistic 都在返回前同步执行，供事件处理器可靠判断是否已接单。
   */
  tryRun<TSnapshot, TResult>(
    key: string,
    operation: {
      capture: () => TSnapshot;
      applyOptimistic: () => void;
      commit: () => Promise<TResult>;
      rollback: (snapshot: TSnapshot) => void;
    },
  ): MutationHandle<TResult> | null {
    const entry = this.entries.get(key) ?? { revision: 0, active: null };
    if (entry.active) return null;

    entry.revision += 1;
    const token: MutationToken = { key, revision: entry.revision };
    const snapshot = operation.capture();
    operation.applyOptimistic();

    const promise = Promise.resolve()
      .then(operation.commit)
      .catch((error) => {
        if (this.isCurrent(token)) operation.rollback(snapshot);
        throw error;
      })
      .finally(() => {
        const latest = this.entries.get(key);
        if (latest?.active === promise) {
          this.entries.delete(key);
        } else if (latest?.active === null && latest.revision !== token.revision) {
          // 权威帧已推进 revision，且其后没有新 mutation；旧请求收口后即可回收 key。
          this.entries.delete(key);
        }
      });
    entry.active = promise;
    this.entries.set(key, entry);
    return { token, promise };
  }

  /** 无乐观态的请求也复用同一单飞/revision 语义。 */
  run<TResult>(key: string, commit: () => Promise<TResult>): Promise<TResult> {
    const existing = this.entries.get(key)?.active;
    if (existing) return existing as Promise<TResult>;
    const handle = this.tryRun(key, {
      capture: () => undefined,
      applyOptimistic: () => undefined,
      commit,
      rollback: () => undefined,
    });
    if (!handle) throw new Error(`mutation already in flight: ${key}`);
    return handle.promise;
  }
}

export const workspaceMutations = new RevisionedMutationCoordinator();

export function resourceMutationKey(domain: string, id: string): string {
  return `resource:${domain}:${id}`;
}

export function annotationMutationKey(sessionId: string, groupId: string): string {
  return `annotation:${sessionId}:${groupId}`;
}

export function askMoreMutationKey(sessionId: string, toolCallId: string): string {
  return `ask-more:${sessionId}:${toolCallId}`;
}
