export const AUTH_REQUIRED_EVENT = "qa-auth-required";
export const AUTH_CHANGED_EVENT = "qa-auth-changed";

let pending: Promise<boolean> | null = null;
let resolvePending: ((ok: boolean) => void) | null = null;
let installed = false;
let nativeFetch: typeof fetch | null = null;

function resolveAuth(ok: boolean): void {
  resolvePending?.(ok);
  resolvePending = null;
  pending = null;
}

/** 是否已有等待中的鉴权请求:供 AuthTokenGate 挂载时补查——
 *  首个 401 可能发生在组件 mount 之前(极早期 fetch),事件已发无人听,
 *  不补查的话 pending 永久挂起且事件不会再发、卡永远不弹。 */
export function hasPendingAuth(): boolean {
  return pending !== null;
}

export function ensureAuth(): Promise<boolean> {
  if (pending) return pending;
  pending = new Promise<boolean>((resolve) => {
    resolvePending = resolve;
  });
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
  return pending;
}

export async function submitAuthToken(token: string): Promise<boolean> {
  const fetchImpl = nativeFetch ?? window.fetch;
  let res: Response;
  try {
    res = await fetchImpl("/api/v1/auth/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  resolveAuth(true);
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT));
  return true;
}

export function cancelAuth(): void {
  resolveAuth(false);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function shouldInterceptAuth(input: RequestInfo | URL): boolean {
  const url = new URL(requestUrl(input), window.location.origin);
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith("/api/") &&
    url.pathname !== "/api/v1/auth/session"
  );
}

export function installAuthFetchInterceptor(): void {
  if (installed) return;
  nativeFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch!(input, init);
    if (response.status !== 401 || !shouldInterceptAuth(input)) return response;
    const ok = await ensureAuth();
    if (!ok) return response;
    // 重试只做一次,并且直接走原生 fetch,避免重试响应再次触发拦截。
    return nativeFetch!(input, init);
  }) as typeof fetch;
  installed = true;
}
