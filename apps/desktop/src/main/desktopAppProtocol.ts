export const DESKTOP_APP_SCHEME = "qingagent";
export const DESKTOP_APP_HOST = "app";
export const DESKTOP_APP_URL = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}/`;
// Node 的 WHATWG URL 对自定义 scheme 返回 "null"，但 Electron 将已登记的 standard scheme
// 按 scheme + host 隔离 Web Storage；这里显式保留与 Chromium 一致的固定 origin。
export const DESKTOP_APP_ORIGIN = `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}`;

export type DesktopAppProxyFetch = (request: Request) => Promise<Response>;

export function createDesktopAppProxyHandler(
  port: number,
  fetchRequest: DesktopAppProxyFetch,
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

    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, serverOrigin);
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 服务端继续按实际回环 Host 执行 CSRF 校验，不把自定义 scheme 扩入公网 Origin 白名单。
    headers.set("origin", serverOrigin);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      signal: request.signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    return fetchRequest(new Request(targetUrl, init));
  };
}
