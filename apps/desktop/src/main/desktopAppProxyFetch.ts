import { Agent, request as nodeHttpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { DesktopAppProxyFetch } from "./desktopAppProtocol.js";

/**
 * 打包渲染器的 qingagent:// 请求最终要落到内嵌 Hono 服务。这一跳**不能**用 Electron 的
 * `net.fetch`,两个实测缺陷会直接打死 SSE:
 *
 * 1) 取消不传播。`protocol.handle` 构造交给 handler 的 Request 时根本没有传 signal
 *    (见 Electron lib/browser/api/protocol.ts),所以 `request.signal` 是一个永不触发的
 *    空信号;而 Electron 的 IncomingMessage 被销毁时也不会中止底层 URLLoader。实测:
 *    渲染端 abort 后 4 秒,服务端 SSE 连接仍全部活着 —— 每次 EventSource 重连都永久泄漏一条。
 * 2) 主机连接上限。`net.fetch` 走 Chromium 网络栈,单主机 6 连接。实测并发 10 条 SSE
 *    只有 6 条到达服务端,其余 4 条在 Chromium 里静默排队,服务端日志里连请求都看不到。
 *
 * 两者叠加即为真机现象:泄漏的 SSE 逐步吃满 6 条槽位,之后**所有** API 请求静默挂起。
 *
 * 改用 Node 原生 http 直连回环:无单主机连接上限,且响应体的 `cancel()` 能把渲染端的取消
 * 确实地传导到 socket 销毁。实测同样并发 10 条全部到达,abort 后服务端立刻全部关闭。
 */

/** 逐跳头由每一跳自己协商,不能透传(RFC 9110 §7.6.1)。 */
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

/** 这些状态码按 fetch 规范不得带响应体,构造 Response 时必须给 null。 */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export interface NodeHttpProxyFetchOptions {
  /** 复用连接池;默认无上限,长连接 SSE 不会挤掉普通 API 请求。 */
  agent?: Agent;
  /** 便于单测注入;默认 node:http 的 request。 */
  requestImpl?: typeof nodeHttpRequest;
}

function toOutgoingHeaders(headers: Headers): Record<string, string> {
  const outgoing: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // host 由 Node 按目标地址重算;逐跳头不透传。
    if (name === "host" || HOP_BY_HOP_HEADERS.has(name)) return;
    outgoing[name] = value;
  });
  // Node http 不会自动解压,而 Chromium 的自定义协议加载器也不解码 content-encoding,
  // 透传渲染端的 gzip/br 协商会让整个响应变成乱码。回环内压缩本来也没有收益。
  outgoing["accept-encoding"] = "identity";
  return outgoing;
}

function toResponseHeaders(upstreamHeaders: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * 把上游 Node 响应流包成 Web 流。`cancel` 是主进程唯一能拿到的"渲染端已取消"信号:
 * 渲染端关掉 EventSource 时,Electron 会销毁由本响应体转出的 Node 流,从而触发 cancel。
 * 这里必须顺手销毁上游连接,否则服务端会一直以为客户端还在。
 */
export function createUpstreamBodyStream(
  upstream: Pick<ClientRequest, "destroy">,
  response: IncomingMessage,
): ReadableStream<Uint8Array> {
  // Node 内建桥接通过 finished/eos 同时覆盖 end、error、aborted 与 premature close。
  // 旧手写桥只监听 end/error；Windows Electron 的连接淘汰若只落到 close，Web 流会
  // 永久保持 open，renderer 只能等半开看门狗。这里交回运行时处理终态与背压。
  response.once("close", () => {
    // renderer 取消会让 toWeb 销毁 IncomingMessage；若 HTTP 尚未完整收口，再显式销毁
    // ClientRequest，维持“不泄漏 SSE 上游连接”的原契约。正常 EOF 保留 keep-alive。
    if (!response.complete) upstream.destroy();
  });
  return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>;
}

export function createNodeHttpProxyFetch(
  options: NodeHttpProxyFetchOptions = {},
): DesktopAppProxyFetch {
  const agent =
    options.agent ??
    new Agent({ keepAlive: true, maxSockets: Number.POSITIVE_INFINITY });
  const requestImpl = options.requestImpl ?? nodeHttpRequest;

  return (request) =>
    new Promise<Response>((resolve, reject) => {
      const targetUrl = new URL(request.url);
      const requestOptions: RequestOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        method: request.method,
        // 保留原始 pathname(可能含 //),Host 仍由 hostname/port 决定,不会外发。
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: toOutgoingHeaders(request.headers),
        agent,
      };

      const upstream = requestImpl(requestOptions, (response) => {
        const status = response.statusCode ?? 502;
        const init: ResponseInit = {
          status,
          statusText: response.statusMessage ?? "",
          headers: toResponseHeaders(response.headers),
        };
        if (NULL_BODY_STATUS.has(status) || request.method === "HEAD") {
          response.resume();
          resolve(new Response(null, init));
          return;
        }
        resolve(new Response(createUpstreamBodyStream(upstream, response), init));
      });

      // SSE 是长连接,任何 socket 空闲超时都会误杀;心跳由服务端 ping 负责。
      upstream.setTimeout(0);
      upstream.on("error", reject);
      // 目前 Electron 不会给 handler 真实 signal(见文件头注释),但一旦将来接通,这里立即生效。
      request.signal?.addEventListener("abort", () => upstream.destroy(), { once: true });

      const body = request.body as NodeReadableStream<Uint8Array> | null;
      if (body) {
        Readable.fromWeb(body).pipe(upstream);
      } else {
        upstream.end();
      }
    });
}
