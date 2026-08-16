const API_PREFIX = "/api/";

function desktopDataOrigin(): string | null {
  if (typeof window === "undefined" || window.electron?.isDesktop !== true) return null;
  return window.electron.dataOrigin ?? null;
}

function shouldIncludeEmbeddedCredentials(): boolean {
  try {
    return window.electron?.getBackendConnection?.()?.mode !== "attach";
  } catch {
    return false;
  }
}

function embeddedCredentials(init?: RequestInit): RequestInit | undefined {
  if (!shouldIncludeEmbeddedCredentials()) return init;
  return {
    ...init,
    credentials: init?.credentials === "omit" ? "omit" : "include",
  };
}

export function desktopDataUrl(input: string): string {
  const origin = desktopDataOrigin();
  if (!origin) return input;
  let url: URL;
  try { url = new URL(input, window.location.origin); } catch { return input; }
  if (
    url.origin !== window.location.origin
    || (
      !url.pathname.startsWith(API_PREFIX)
      && url.pathname !== "/health"
      && url.pathname !== "/__telemetry/send"
    )
  ) return input;
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

let installed = false;

/** desktop 唯一数据 URL 重写层；任何 bearer 都只会在主进程协议代理内注入。 */
export function installDesktopDataTransport(): void {
  if (installed || !desktopDataOrigin()) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      const nextUrl = desktopDataUrl(input);
      return nativeFetch(nextUrl, nextUrl === input ? init : embeddedCredentials(init));
    }
    if (input instanceof URL) {
      const sourceUrl = input.toString();
      const nextUrl = desktopDataUrl(sourceUrl);
      return nativeFetch(nextUrl, nextUrl === sourceUrl ? init : embeddedCredentials(init));
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      const nextUrl = desktopDataUrl(input.url);
      if (nextUrl === input.url) return nativeFetch(input, init);
      let rewritten = new Request(nextUrl, input);
      if (shouldIncludeEmbeddedCredentials() && rewritten.credentials === "same-origin") {
        rewritten = new Request(rewritten, { credentials: "include" });
      }
      return nativeFetch(rewritten, init);
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  const NativeEventSource = window.EventSource;
  window.EventSource = class DesktopEventSource extends NativeEventSource {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      super(
        desktopDataUrl(String(url)),
        shouldIncludeEmbeddedCredentials()
          ? { ...eventSourceInitDict, withCredentials: true }
          : eventSourceInitDict,
      );
    }
  } as typeof EventSource;

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function desktopOpen(
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    Reflect.apply(nativeOpen, this, [
      method,
      desktopDataUrl(String(url)),
      async,
      username,
      password,
    ]);
    if (shouldIncludeEmbeddedCredentials()) this.withCredentials = true;
  };
}

export function isAttachRenderer(): boolean {
  try { return window.electron?.getBackendConnection?.()?.mode === "attach"; } catch { return false; }
}

export function waitForMainBackendAttached(signal?: AbortSignal): Promise<boolean> {
  const bridge = window.electron;
  if (!bridge?.getBackendConnection || !bridge.onBackendConnectionChanged) return Promise.resolve(true);
  const initial = bridge.getBackendConnection();
  if (initial?.mode !== "attach" || initial.status === "attached") return Promise.resolve(true);
  if (["dead", "incompatible", "conflict"].includes(initial.status)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let detach = () => {};
    const finish = (value: boolean) => {
      detach();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    detach = bridge.onBackendConnectionChanged!((snapshot) => {
      if (snapshot.status === "attached") finish(true);
      else if (["dead", "incompatible", "conflict"].includes(snapshot.status)) finish(false);
    });
    if (signal?.aborted) finish(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
