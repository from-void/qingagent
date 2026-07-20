import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  BrowserContext,
  BrowserContextOptions,
  Page,
  Request as PlaywrightRequest,
  Route,
  WebSocketRoute,
} from "playwright";
import {
  createPinnedLookup,
  validateAndPinFetchUrl,
  validateFetchUrl,
  type PinnedFetchUrl,
} from "./fetchUrlPolicy.js";

/** 所有由本仓直接创建的抓取 context 都必须在创建时禁用 Service Worker。 */
export const BROWSER_SECURITY_CONTEXT_OPTIONS = {
  serviceWorkers: "block",
} satisfies Pick<BrowserContextOptions, "serviceWorkers">;

const SAFE_LOCAL_BROWSER_SCHEMES = new Set(["about:", "blob:", "data:"]);
const PINNED_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
const PINNED_REQUEST_TIMEOUT_MS = 15_000;
const CONTINUE_RESOURCE_TYPES = new Set(["eventsource", "media"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface BrowserRequestPolicyOptions {
  /**
   * 用固定 IP 的 Node 请求回填普通 HTTP(S) 响应，彻底关闭 Chromium 二次 DNS 的重绑定窗口。
   * 交互式 agent browser 默认关闭，避免改变登录、下载等完整浏览器语义。
   */
  pinHttpRequests?: boolean;
  /**
   * 阻断 WebSocket、EventSource 与媒体流；仅供只提取静态 DOM 的文章抓取使用。
   * 交互式浏览器不得启用，以免破坏登录、实时交互与媒体播放。
   */
  blockStreamingResources?: boolean;
}

interface PinnedBrowserResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const contextPolicyInstallations = new WeakMap<BrowserContext, Promise<void>>();

async function assertBrowserRequestAllowed(rawUrl: string, websocket: boolean): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid browser request URL: ${rawUrl}`);
  }

  if (websocket) {
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error(`Unsupported WebSocket scheme: ${parsed.protocol}`);
    }
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    await validateFetchUrl(parsed.toString());
    return;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    await validateFetchUrl(parsed.toString());
    return;
  }
  if (!SAFE_LOCAL_BROWSER_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported browser request scheme: ${parsed.protocol}`);
  }
}

function responseHeaders(rawHeaders: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const rawName = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!rawName || value === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === "content-length") continue;
    const separator = name === "set-cookie" ? "\n" : ", ";
    headers[name] = headers[name] ? `${headers[name]}${separator}${value}` : value;
  }
  return headers;
}

/** 用已校验 IP 发出浏览器原请求；URL/Host/SNI 仍保留原域名。 */
async function requestPinnedBrowserUrl(
  target: PinnedFetchUrl,
  browserRequest: PlaywrightRequest,
): Promise<PinnedBrowserResponse> {
  const requestHeaders = await browserRequest.allHeaders();
  for (const name of HOP_BY_HOP_HEADERS) delete requestHeaders[name];
  const method = browserRequest.method();
  const postData = browserRequest.postDataBuffer() ?? undefined;

  return await new Promise<PinnedBrowserResponse>((resolve, reject) => {
    const signal = AbortSignal.timeout(PINNED_REQUEST_TIMEOUT_MS);
    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(
      target.url,
      {
        method,
        headers: requestHeaders,
        lookup: createPinnedLookup(target),
        signal,
        // 与 scrapePage 的 ignoreHTTPSErrors 保持一致；这不改变固定 IP 的 SSRF 边界。
        ...(target.url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > PINNED_RESPONSE_LIMIT_BYTES) {
            incoming.destroy(
              new Error(`Pinned browser response exceeds ${PINNED_RESPONSE_LIMIT_BYTES} bytes`),
            );
            return;
          }
          chunks.push(buffer);
        });
        incoming.once("error", reject);
        incoming.once("end", () => {
          resolve({
            status: incoming.statusCode ?? 500,
            headers: responseHeaders(incoming.rawHeaders),
            body: Buffer.concat(chunks, size),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(postData);
  });
}

function shouldContinueInChromium(request: PlaywrightRequest): boolean {
  return CONTINUE_RESOURCE_TYPES.has(request.resourceType());
}

async function handleBrowserRoute(
  route: Route,
  options: BrowserRequestPolicyOptions,
): Promise<void> {
  const request = route.request();
  const requestUrl = request.url();
  try {
    if (options.blockStreamingResources && shouldContinueInChromium(request)) {
      await route.abort("blockedbyclient");
      return;
    }

    const parsed = new URL(requestUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      await assertBrowserRequestAllowed(requestUrl, false);
      await route.continue();
      return;
    }

    if (!options.pinHttpRequests) {
      await validateFetchUrl(requestUrl);
      await route.continue();
      return;
    }

    const target = await validateAndPinFetchUrl(requestUrl);
    if (shouldContinueInChromium(request)) {
      // EventSource 与媒体响应依赖浏览器流式/分段语义；回填会破坏正常渲染。
      // 抓取模式已在上方阻断；只有未启用该模式的交互式浏览器会走到这里，
      // 并保留“校验后 continue”产生的 Chromium 二次 DNS TOCTOU 残留窗口。
      await route.continue();
      return;
    }

    const response = await requestPinnedBrowserUrl(target, request);
    await route.fulfill(response);
  } catch {
    await route.abort("blockedbyclient").catch(() => undefined);
  }
}

async function handleBrowserWebSocketRoute(
  route: WebSocketRoute,
  options: BrowserRequestPolicyOptions,
): Promise<void> {
  try {
    if (options.blockStreamingResources) {
      await route.close({ code: 1008, reason: "Blocked by qingagent network policy" });
      return;
    }
    await assertBrowserRequestAllowed(route.url(), true);
    // 抓取模式已在上方阻断；未启用该模式的交互式浏览器仍需连接。
    // Playwright 的 WebSocketRoute 不能指定已校验 IP，connectToServer 会由 Chromium
    // 二次解析，因此残留 DNS TOCTOU 窗口只存在于交互式浏览器。
    route.connectToServer();
  } catch {
    await route
      .close({ code: 1008, reason: "Blocked by qingagent network policy" })
      .catch(() => undefined);
  }
}

async function bypassServiceWorkerForPage(context: BrowserContext, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  try {
    await session.send("Network.enable");
    await session.send("Network.setBypassServiceWorker", { bypass: true });
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
  page.once("close", () => {
    void session.detach().catch(() => undefined);
  });
}

function blockServiceWorkerRegistration(): void {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.register = async () => {
    console.warn("Service Worker registration blocked by qingagent");
    return undefined as unknown as ServiceWorkerRegistration;
  };
}

async function installServiceWorkerBlock(context: BrowserContext): Promise<void> {
  // 与 Playwright serviceWorkers:"block" 的 init script 保持同一语义；用于上游库已创建的 context。
  if (typeof context.addInitScript === "function") {
    await context.addInitScript(blockServiceWorkerRegistration);
  }

  // CDP/持久 profile 可能已经注册过 SW：先注销，再让现有与后续页面强制旁路。
  if (typeof context.serviceWorkers === "function") {
    await Promise.all(
      context.serviceWorkers().map(async (worker) => {
        await worker
          .evaluate(async () => {
            const scope = globalThis as unknown as {
              registration?: { unregister: () => Promise<boolean> };
            };
            await scope.registration?.unregister();
          })
          .catch(() => undefined);
      }),
    );
  }

  if (typeof context.newCDPSession !== "function" || typeof context.pages !== "function") return;
  await Promise.all(
    context
      .pages()
      .map((page) => page.evaluate(blockServiceWorkerRegistration).catch(() => undefined)),
  );
  await Promise.all(context.pages().map((page) => bypassServiceWorkerForPage(context, page)));
  context.on("page", (page) => {
    void bypassServiceWorkerForPage(context, page).catch(() => {
      // 无法确认旁路时关闭新页面，避免已有 SW 抢在 route 前发出未校验请求。
      void page.close().catch(() => undefined);
    });
  });
}

/** 在首个真实导航前安装 Service Worker、HTTP(S) 与 WebSocket 的统一网络策略。 */
export async function installBrowserRequestPolicy(
  context: BrowserContext,
  options: BrowserRequestPolicyOptions = {},
): Promise<void> {
  const existing = contextPolicyInstallations.get(context);
  if (existing) return await existing;

  const installation = (async () => {
    await installServiceWorkerBlock(context);
    await context.route("**/*", (route) => handleBrowserRoute(route, options));
    await context.routeWebSocket("**/*", (route) => handleBrowserWebSocketRoute(route, options));
  })();
  contextPolicyInstallations.set(context, installation);
  try {
    await installation;
  } catch (error) {
    contextPolicyInstallations.delete(context);
    throw error;
  }
}
