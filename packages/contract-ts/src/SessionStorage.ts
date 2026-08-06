const OM_SIDECAR_THREAD_PREFIX = "om-sidecar:";

export function omSidecarThreadId(sessionId: string): string {
  return sessionId.startsWith(OM_SIDECAR_THREAD_PREFIX)
    ? sessionId
    : `${OM_SIDECAR_THREAD_PREFIX}${sessionId}`;
}

/** 会话删除必须覆盖的全部 Mastra 精确线程 id；新增影子线程只能在这里扩展。 */
export function sessionOwnedThreadIds(sessionId: string): string[] {
  return [sessionId, omSidecarThreadId(sessionId)];
}

/** 将已知会话线程（含影子线程）归一回产品 session id。 */
export function sessionIdFromOwnedThreadId(threadId: string): string {
  return threadId.startsWith(OM_SIDECAR_THREAD_PREFIX)
    ? threadId.slice(OM_SIDECAR_THREAD_PREFIX.length)
    : threadId;
}
