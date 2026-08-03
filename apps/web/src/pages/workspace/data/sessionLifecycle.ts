import type { ServerStream } from "./serverStream";
import type { WorkspaceState } from "./workspaceState";

type Ref<T> = { current: T };

export function startNewSessionOnce(
  stream: ServerStream,
  sessionIdRef: Ref<string | null>,
  startSessionPromiseRef: Ref<Promise<string> | null>,
  onSessionReady?: (sessionId: string) => void,
): Promise<string> {
  startSessionPromiseRef.current ??= stream
    .startSession({ mode: { kind: "new", data: { template: null } } })
    .then((id) => {
      sessionIdRef.current = id;
      onSessionReady?.(id);
      return id;
    })
    .catch((e) => {
      startSessionPromiseRef.current = null;
      throw e;
    });
  return startSessionPromiseRef.current;
}

export async function ensureSessionIdOnce(
  stream: ServerStream,
  stateRef: Ref<WorkspaceState>,
  sessionIdRef: Ref<string | null>,
  startSessionPromiseRef: Ref<Promise<string> | null>,
  onSessionReady?: (sessionId: string) => void,
): Promise<string> {
  const existing = stateRef.current.sessionId ?? sessionIdRef.current;
  if (existing) return existing;
  return startNewSessionOnce(stream, sessionIdRef, startSessionPromiseRef, onSessionReady);
}

export function workspaceHashWithSession(hash: string, sessionId: string): string {
  const [baseAndQuery, suffix = ""] = hash.split(";", 2);
  const normalized = baseAndQuery && baseAndQuery.startsWith("#")
    ? baseAndQuery
    : "#/workspace";
  const [route = "#/workspace", query = ""] = normalized.split("?", 2);
  // 路由守卫(review #7):惰性建会话的 promise 可能在用户已离开工作区(如点了返回首页)后才
  // resolve——此时不改写他页 hash,否则首页 URL 会被污染成 `#/?session=xxx`。
  if (route !== "#/workspace") return hash;
  const params = new URLSearchParams(query);
  // intent=new 必须压过残留 session；新会话落定后 URL 只保留权威 session 身份。
  if (params.get("session") && params.get("intent") !== "new") return hash;
  params.delete("intent");
  params.set("session", sessionId);
  const nextBase = `${route || "#/workspace"}?${params.toString()}`;
  return suffix ? `${nextBase};${suffix}` : nextBase;
}

export function replaceWorkspaceSessionHash(sessionId: string): void {
  const nextHash = workspaceHashWithSession(window.location.hash, sessionId);
  if (nextHash !== window.location.hash) {
    window.history.replaceState(null, "", nextHash);
  }
}
