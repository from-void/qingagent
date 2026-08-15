import {
  isDesktopCommandMutationPath,
} from "./desktopCommandAuth.js";

export const DESKTOP_APP_SCHEME = "qingagent";
export const DESKTOP_APP_HOST = "app";
export const DESKTOP_APP_URL = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}/`;
// Node 的 WHATWG URL 对自定义 scheme 返回 "null"，但 Electron 将已登记的 standard scheme
// 按 scheme + host 隔离 Web Storage；这里显式保留与 Chromium 一致的固定 origin。
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}`;
const DESKTOP_APP_DEEP_LINK_MAX_LENGTH = 8_192;

export type DesktopAppDeepLinkNavigator = (url: string) => void;

/**
 * 只接受可安全交给主 SPA 的固定 origin 深链。
 *
 * 自定义协议同时承担打包 renderer 的内部 origin，不能把任意 path/query 当成主 frame
 * 入口；外部入口只允许根路径，并把路由和 session 参数放在 hash 中。
 */
export function parseDesktopAppDeepLink(rawUrl: string): string | null {
  if (rawUrl.length === 0 || rawUrl.length > DESKTOP_APP_DEEP_LINK_MAX_LENGTH) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${DESKTOP_APP_SCHEME}:`
      || url.host !== DESKTOP_APP_HOST
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || !url.hash.startsWith("#/")
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** 把受信深链的 hash 路由移植到当前运行态 origin（开发态为 Vite，打包态为 qingagent）。 */
export function resolveDesktopContentUrl(baseContentUrl: string, deepLinkUrl: string): string {
  const accepted = parseDesktopAppDeepLink(deepLinkUrl);
  if (!accepted) return baseContentUrl;
  const target = new URL(baseContentUrl);
  target.hash = new URL(accepted).hash;
  return target.href;
}

/**
 * 首实例 argv、macOS open-url 与 second-instance 共用的 latest-wins 暂存器。
 * navigator 只在 embedded server 与打包协议 handler 就绪后绑定，因此冷启动期间不会
 * 把 qingagent://app 导航到一个尚未安装 handler 的 Chromium 错误页。
 */
export class DesktopAppDeepLinkDispatcher {
  #pendingUrl: string | null = null;
  #navigator: DesktopAppDeepLinkNavigator | null = null;

  constructor(commandLine: readonly string[] = []) {
    this.offerCommandLine(commandLine);
  }

  offerUrl(rawUrl: string): boolean {
    const accepted = parseDesktopAppDeepLink(rawUrl);
    if (!accepted) return false;
    this.#pendingUrl = accepted;
    this.#flush();
    return true;
  }

  offerCommandLine(commandLine: readonly string[]): boolean {
    let accepted: string | null = null;
    for (const argument of commandLine) {
      const candidate = parseDesktopAppDeepLink(argument);
      if (candidate) accepted = candidate;
    }
    if (!accepted) return false;
    this.#pendingUrl = accepted;
    this.#flush();
    return true;
  }

  setNavigator(navigator: DesktopAppDeepLinkNavigator): boolean {
    this.#navigator = navigator;
    return this.#flush();
  }

  clearNavigator(navigator: DesktopAppDeepLinkNavigator): void {
    if (this.#navigator === navigator) this.#navigator = null;
  }

  #flush(): boolean {
    if (!this.#navigator || !this.#pendingUrl) return false;
    const target = this.#pendingUrl;
    this.#pendingUrl = null;
    this.#navigator(target);
    return true;
  }
}

export type DesktopAppProxyFetch = (request: Request) => Promise<Response>;

export function createDesktopAppProxyHandler(
  port: number,
  fetchRequest: DesktopAppProxyFetch,
  commandAuthToken: string,
  externalAuthToken: string = commandAuthToken,
): (request: Request) => Promise<Response> {
  const serverOrigin = `http://127.0.0.1:${port}`;

  return async (request) => {
    const sourceUrl = new URL(request.url);
    if (
      sourceUrl.protocol !== `${DESKTOP_APP_SCHEME}:` ||
      sourceUrl.host !== DESKTOP_APP_HOST
    ) {
      return new Response("Not found", { status: 404 });
    }

    const targetUrl = new URL(serverOrigin);
    targetUrl.pathname = sourceUrl.pathname;
    targetUrl.search = sourceUrl.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 服务端继续按实际回环 Host 执行 CSRF 校验，不把自定义 scheme 扩入公网 Origin 白名单。
    headers.set("origin", serverOrigin);
    if (request.method === "POST" && isDesktopCommandMutationPath(sourceUrl.pathname)) {
      // Headers.set 大小写不敏感，会覆盖 renderer 伪造的 Authorization。
      headers.set("authorization", `Bearer ${commandAuthToken}`);
    } else if (sourceUrl.pathname.startsWith("/api/v1/external/")) {
      // external 子树恒要 Bearer;本应用自己的请求(深链探测 HEAD doc 等)由主进程
      // 注入自家 instance token,绝不落到 renderer,也绝不弹交互式令牌门。
      headers.set("authorization", `Bearer ${externalAuthToken}`);
    }
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      // Electron 的 protocol.handle 目前不给 handler 传 signal,这里的 request.signal 恒不触发;
      // 真正可靠的"渲染端已取消"信号是响应体的 cancel(),由 desktopAppProxyFetch 负责接住。
      // 保留透传是为了将来 Electron 接通时能立刻生效。
      signal: request.signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    return fetchRequest(new Request(targetUrl, init));
  };
}
