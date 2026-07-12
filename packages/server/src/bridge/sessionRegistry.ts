import type { SessionState } from "./bridgeCore";

/** In-memory session store keyed by sessionId. */
export const sessions = new Map<string, SessionState>();

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function findSessionByStream(streamId: string): SessionState | undefined {
  for (const session of sessions.values()) {
    if (session.streamId === streamId) return session;
  }
  return undefined;
}

export function findSessionByPatch(patchId: string): SessionState | undefined {
  for (const session of sessions.values()) {
    if (session.suggestions?.has(patchId)) return session;
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
      if (candidate === reviewBatchId) return session;
    }
  }
  return undefined;
}
