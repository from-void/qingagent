import { schedulePersist, type SessionState } from "./bridgeCore";

const folderSourceOperationQueues = new Map<string, Promise<void>>();

export async function persistFolderSourceChange(
  session: SessionState,
  reason: string,
): Promise<void> {
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

export function forgetFolderSourceOperationQueue(sessionId: string): void {
  folderSourceOperationQueues.delete(sessionId);
}

export async function withFolderSourceOperationLock<T>(
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
