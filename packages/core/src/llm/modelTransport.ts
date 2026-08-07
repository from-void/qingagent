import {
  lookup as dnsLookup,
  type LookupAddress,
  type LookupAllOptions,
} from "node:dns";
import { isIP } from "node:net";
import {
  Client,
  Dispatcher,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  interceptors,
} from "undici";
import {
  assertModelFetchAddressAllowed,
  allowsPrivateModelHost,
  validateModelFetchUrl,
} from "./modelFetchUrl.js";
import {
  beginWireAttempt,
  markWireAttemptError,
  observeWireResponse,
  wireUsageStorage,
  type WireAttempt,
  type WireScope,
} from "./wireUsage.js";

export const DEFAULT_MODEL_CONNECT_TIMEOUT_MS = 5_000;

/**
 * 网关自称的 keep-alive 时长常比它真正保活的时间长；undici 默认最多信到 600s，
 * 工具执行几十秒后的续写就会撞上已被对端悄悄掐掉的连接。把可信上限压到 30s，
 * 让长间隔的续写更倾向于重新握手而不是复用一条随时会死的连接。
 */
export const MODEL_KEEP_ALIVE_MAX_TIMEOUT_MS = 30_000;

/**
 * 连接复用竞态的重试退避：请求还没拿到任何响应字节就被对端关闭，重建连接重发是
 * 幂等安全的。第一次立即重试（抢在下一次空闲回收前），第二次给对端一点喘息。
 */
const MODEL_CONNECTION_RETRY_DELAYS_MS = [0, 150] as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface ModelDispatcherConfig {
  connectTimeout: number;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  allowPrivate: boolean;
}

type ModelDnsLookup = NonNullable<
  NonNullable<Parameters<typeof interceptors.dns>[0]>["lookup"]
>;
type ConnectionDnsLookup = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, records: LookupAddress[]) => void,
) => void;

const DEFAULT_DNS_RECORD_TTL_MS = 10_000;
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

export function resolveModelConnectTimeoutMs(env: Env = process.env): number {
  const parsed = Number(env.QINGAGENT_MODEL_CONNECT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MODEL_CONNECT_TIMEOUT_MS;
}

/** 与 Node --use-env-proxy / undici EnvHttpProxyAgent 相同:小写代理变量优先。 */
export function resolveModelDispatcherConfig(env: Env = process.env): ModelDispatcherConfig {
  return {
    connectTimeout: resolveModelConnectTimeoutMs(env),
    httpProxy: firstNonEmpty(env.http_proxy, env.HTTP_PROXY),
    httpsProxy: firstNonEmpty(env.https_proxy, env.HTTPS_PROXY),
    noProxy: firstNonEmpty(env.no_proxy, env.NO_PROXY),
    allowPrivate: allowsPrivateModelHost(env),
  };
}

/**
 * 模型出站连接的复用口径。单独导出便于回归钉住：
 * - undici 8 把 allowH2 默认从 false 翻成 true（lib/core/connect.js），升级后模型出站
 *   会在 ALPN 里带上 h2，网关一旦选中 h2 就复用同一条 H2 会话。工具执行期间会话空闲
 *   几十秒被网关掐掉，下一次续写请求撞上刚收到 FIN 的会话就是
 *   `SocketError: other side closed`（onHttp2SocketEnd）。模型出站是单请求串行、
 *   不需要多路复用，固定回 HTTP/1.1 消掉这条竞态。
 * - keepAliveMaxTimeout 压住「网关自称能保活多久」的可信上限。
 */
export const MODEL_CONNECTION_REUSE_OPTIONS = {
  allowH2: false,
  keepAliveMaxTimeout: MODEL_KEEP_ALIVE_MAX_TIMEOUT_MS,
} as const;

function createBaseDispatcher(
  config: ModelDispatcherConfig,
  proxyMode: "direct" | "proxy",
): EnvHttpProxyAgent {
  const httpProxy = proxyMode === "proxy" ? config.httpProxy ?? "" : "";
  const httpsProxy = proxyMode === "proxy"
    ? config.httpsProxy ?? config.httpProxy ?? ""
    : "";
  return new EnvHttpProxyAgent({
    connectTimeout: config.connectTimeout,
    ...MODEL_CONNECTION_REUSE_OPTIONS,
    httpProxy,
    httpsProxy,
    noProxy: proxyMode === "proxy" ? "" : "*",
    // EnvHttpProxyAgent 的 connectTimeout 只覆盖“连到代理”的 TCP；代理接受 TCP 后若
    // CONNECT 永不响应，默认还会等 300s。这里只缩短内部代理 Client 的 CONNECT
    // 响应头等待，不把 headersTimeout/bodyTimeout 施加到真正的模型请求。
    clientFactory: (origin, options) => new Client(origin, {
      ...(options as Client.Options),
      headersTimeout: config.connectTimeout,
    }),
  });
}

function normalizedHostAndPort(url: URL): { hostname: string; port: number } {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return {
    hostname,
    port: Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0,
  };
}

function parseNoProxyEntry(entry: string): { hostname: string; port: number } {
  const bracketedIpv6 = entry.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (bracketedIpv6) {
    return {
      hostname: bracketedIpv6[1]!.slice(1, -1).toLowerCase(),
      port: bracketedIpv6[2] ? Number.parseInt(bracketedIpv6[2], 10) : 0,
    };
  }
  // 裸 IPv6 含多个冒号，末段数字仍属于地址，不能按 host:port 拆分。
  const hostAndPort = entry.indexOf(":") === entry.lastIndexOf(":")
    ? entry.match(/^(.+):(\d+)$/)
    : null;
  return {
    hostname: (hostAndPort ? hostAndPort[1]! : entry).replace(/^\*?\./, "").toLowerCase(),
    port: hostAndPort ? Number.parseInt(hostAndPort[2]!, 10) : 0,
  };
}

function matchesNoProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy === "*") return true;
  const { hostname, port } = normalizedHostAndPort(url);
  for (const entry of noProxy.split(/[,\s]/)) {
    if (!entry) continue;
    const { hostname: entryHostname, port: entryPort } = parseNoProxyEntry(entry);
    if (entryPort && entryPort !== port) continue;
    if (
      hostname === entryHostname ||
      hostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`
    ) {
      return true;
    }
  }
  return false;
}

export function shouldProxyModelUrl(url: URL, config: ModelDispatcherConfig): boolean {
  const proxy = url.protocol === "https:"
    ? config.httpsProxy ?? config.httpProxy
    : config.httpProxy;
  return Boolean(proxy) && !matchesNoProxy(url, config.noProxy);
}

export function createModelDnsLookup(
  env: Env = process.env,
  lookupImpl: ConnectionDnsLookup = dnsLookup,
): ModelDnsLookup {
  return (origin, _options, callback) => {
    lookupImpl(origin.hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) {
        callback(error, []);
        return;
      }
      try {
        for (const record of records) {
          assertModelFetchAddressAllowed(record.address, origin.hostname, env);
        }
      } catch (error) {
        callback(error as NodeJS.ErrnoException, []);
        return;
      }
      callback(null, records.map((record) => ({
        address: record.address,
        family: record.family as 4 | 6,
        ttl: DEFAULT_DNS_RECORD_TTL_MS,
      })));
    });
  };
}

class ModelDispatcher extends Dispatcher {
  constructor(
    private readonly direct: Dispatcher,
    private readonly proxy: Dispatcher,
    private readonly config: ModelDispatcherConfig,
    private readonly env: Env,
  ) {
    super();
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    try {
      if (!options.origin) throw new Error("Model request origin is required");
      const origin = new URL(options.origin);
      const hostname = origin.hostname.toLowerCase();
      const addressHostname =
        hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
      // DNS interceptor 对字面 IP 不调用 lookup；在路由到直连/代理前同步补上同一策略。
      if (isIP(addressHostname)) {
        assertModelFetchAddressAllowed(addressHostname, hostname, this.env);
      }
      const dispatcher = shouldProxyModelUrl(origin, this.config) ? this.proxy : this.direct;
      return dispatcher.dispatch(options, handler);
    } catch (error) {
      handler.onResponseError?.(null as never, error as Error);
      return false;
    }
  }

  close(callback: () => void): void;
  close(): Promise<void>;
  close(callback?: () => void): void | Promise<void> {
    const closing = Promise.all([this.direct.close(), this.proxy.close()]).then(() => undefined);
    if (!callback) return closing;
    void closing.finally(callback);
  }

  destroy(error: Error | null, callback: () => void): void;
  destroy(callback: () => void): void;
  destroy(error: Error | null): Promise<void>;
  destroy(): Promise<void>;
  destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): void | Promise<void> {
    const error = typeof errorOrCallback === "function" ? undefined : errorOrCallback ?? undefined;
    const done = typeof errorOrCallback === "function" ? errorOrCallback : callback;
    const destroying = Promise.all([
      error ? this.direct.destroy(error) : this.direct.destroy(),
      error ? this.proxy.destroy(error) : this.proxy.destroy(),
    ]).then(() => undefined);
    if (!done) return destroying;
    void destroying.finally(done);
  }
}

export function createModelDispatcher(env: Env = process.env): Dispatcher {
  const config = resolveModelDispatcherConfig(env);
  const dnsOptions = {
    lookup: createModelDnsLookup(env),
    // 短缓存保存的已经是校验后的固定 IP；后续连接不会再次解析攻击者域名。
    maxTTL: DEFAULT_DNS_RECORD_TTL_MS,
  };
  const direct = createBaseDispatcher(config, "direct");
  const proxy = createBaseDispatcher(config, "proxy");
  return new ModelDispatcher(
    direct.compose(interceptors.dns(dnsOptions)),
    proxy.compose(interceptors.dns(dnsOptions)),
    config,
    env,
  );
}

let activeTransport: {
  key: string;
  dispatcher: Dispatcher;
} | null = null;
const nativeGlobalFetch = globalThis.fetch;

function dispatcherKey(config: ModelDispatcherConfig): string {
  return JSON.stringify(config);
}

function getModelDispatcher(env: Env = process.env): Dispatcher {
  const config = resolveModelDispatcherConfig(env);
  const key = dispatcherKey(config);
  if (activeTransport?.key === key) return activeTransport.dispatcher;

  const previous = activeTransport?.dispatcher;
  const dispatcher = createModelDispatcher(env);
  activeTransport = { key, dispatcher };
  if (previous) void previous.close().catch(() => {});
  return dispatcher;
}

const CONNECTION_RESET_ERROR_CODES = new Set([
  // undici SocketError（other side closed / socket hang up）统一挂这个 code。
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "EPIPE",
]);

const CONNECTION_RESET_MESSAGE_PATTERN = /other side closed|socket hang up/i;

/**
 * 是否属于「连接复用竞态」：连接已经建立（或以为已建立）但对端在我们发出请求前后
 * 就关掉了它。判定沿 cause 链回溯，因为 fetch 会把它包成 TypeError: fetch failed。
 */
export function isConnectionResetError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return false;
    if (typeof candidate.code === "string" && CONNECTION_RESET_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    if (
      typeof candidate.message === "string" &&
      CONNECTION_RESET_MESSAGE_PATTERN.test(candidate.message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * 只有请求体能原样重放时才允许重试。流式请求体（ReadableStream / 已构造的 Request）
 * 一旦开始发送就无法回放，宁可把错误如实抛给上层。
 */
export function isReplayableModelRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  const body = init?.body;
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 预检成功缓存的存活时长。同一 host 在窗口内不再重复付 DNS 成本：偶发的慢解析被缓存
 * 兜住，不会让每一次模型调用都赌一遍 DNS。安全性不受影响——连接层 DNS 拦截器
 * （createModelDnsLookup / ModelDispatcher.dispatch）每次连接仍按同一策略校验地址，
 * 缓存只省掉「预检」这一层重复解析。
 */
export const MODEL_PREFLIGHT_CACHE_TTL_MS = 5 * 60_000;

/** 预检撞上瞬时 DNS 故障时的重试退避；严格模式不能降级，只能靠重试兜。 */
export const MODEL_PREFLIGHT_RETRY_DELAYS_MS = [120] as const;

/** hostname 粒度的预检成功缓存：key -> 过期时间戳。只缓存成功，失败绝不缓存。 */
const preflightSuccessCache = new Map<string, number>();

/** DNS 侧的瞬时故障：重试一次通常就好，不该让整次模型调用直接失败。 */
const TRANSIENT_DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
  "ESERVFAIL",
  "EREFUSED",
  "ECONNREFUSED",
]);

/** 预检超时/瞬时 DNS 故障 → 可重试；策略拒绝、非法 URL、解析不到主机 → 确定性失败。 */
export function isTransientPreflightError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name === "TimeoutError") return true;
  return typeof candidate.code === "string" && TRANSIENT_DNS_ERROR_CODES.has(candidate.code);
}

function preflightCacheKey(rawUrl: string, env: Env): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // 策略维度进 key：放行私网与否会改变同一 host 的判定结论，不能互相污染。
  return `${allowsPrivateModelHost(env) ? "private" : "strict"}|${url.protocol}//${url.hostname.toLowerCase()}`;
}

export interface ModelPreflightDeps {
  validate?: (rawUrl: string, env: Env, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
}

/**
 * 模型出站前的 URL 策略预检。三层护栏依次生效：
 * 1. host 成功缓存（TTL 内直接放行，避免高频调用重复付 DNS 成本）；
 * 2. 瞬时故障（超时 / EAI_AGAIN 等）重试；
 * 3. 允许私网时（桌面端默认）预检结论本就放行一切地址，其超时再阻断调用没有任何安全
 *    收益，降级为尽力而为；不允许私网的 Web/自部署维持严格阻断语义。
 */
export async function runModelFetchPreflight(
  rawUrl: string,
  env: Env = process.env,
  requestSignal?: AbortSignal,
  deps: ModelPreflightDeps = {},
): Promise<void> {
  const validate = deps.validate ?? validateModelFetchUrl;
  const now = deps.now ?? Date.now;
  const cacheKey = preflightCacheKey(rawUrl, env);
  if (cacheKey !== null) {
    const expiresAt = preflightSuccessCache.get(cacheKey);
    if (expiresAt !== undefined) {
      if (expiresAt > now()) return;
      preflightSuccessCache.delete(cacheKey);
    }
  }
  const timeoutMs = resolveModelConnectTimeoutMs(env);
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(requestSignal?.reason);
    if (requestSignal?.aborted) relayAbort();
    else requestSignal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Model DNS preflight timed out", "TimeoutError")),
      timeoutMs,
    );
    try {
      await validate(rawUrl, env, controller.signal);
      if (cacheKey !== null) preflightSuccessCache.set(cacheKey, now() + MODEL_PREFLIGHT_CACHE_TTL_MS);
      return;
    } catch (error) {
      // 调用方主动取消照原样抛出，不算 DNS 故障。
      requestSignal?.throwIfAborted();
      if (!isTransientPreflightError(error)) throw error;
      if (attempt < MODEL_PREFLIGHT_RETRY_DELAYS_MS.length) {
        await sleep(MODEL_PREFLIGHT_RETRY_DELAYS_MS[attempt]!, requestSignal);
        continue;
      }
      if (allowsPrivateModelHost(env)) return;
      throw error;
    } finally {
      clearTimeout(timer);
      requestSignal?.removeEventListener("abort", relayAbort);
    }
  }
}

/** 仅供测试隔离预检缓存。 */
export function resetModelPreflightCacheForTests(): void {
  preflightSuccessCache.clear();
}

/**
 * 模型专用 fetch。npm undici 的 fetch 与 dispatcher 来自同一包，避免 Node 24 内建
 * fetch 的 undici.globalDispatcher.1 与 npm undici@8 的 .2 符号/handler 协议不兼容。
 */
export const modelFetch: typeof globalThis.fetch = async (input, init) => {
  // 身份不变式：入口、首次 await 前恰好读一次；其后只传这个闭包引用。
  const wireScope = wireUsageStorage.getStore();
  if (!wireScope) console.info("[wireUsage] modelFetch 未挂载计量 scope");
  // 既有 provider/BranchCall 单测通过 vi.stubGlobal 拦截 wire body；测试替身不是生产
  // 传输路径，显式保留这个观测缝，黑洞集成测试不 stub global fetch，仍走真实 dispatcher。
  if (process.env.VITEST && globalThis.fetch !== nativeGlobalFetch) {
    return fetchObservedAttempt(wireScope, input, init, () => globalThis.fetch(input, init));
  }
  const rawUrl = typeof input === "string" || input instanceof URL
    ? input.toString()
    : input.url;
  const requestSignal = init?.signal ??
    (typeof input === "string" || input instanceof URL ? undefined : input.signal);
  // 首次物理尝试在预检前建档：预检/主动中止若提前失败，同一行仍能如实归为 no_response；
  // 预检通过后复用该 attempt，不额外制造一条“预检行”。
  let firstWireAttempt = wireScope ? beginWireAttempt(wireScope, input, init) : undefined;
  try {
    await runModelFetchPreflight(rawUrl, process.env, requestSignal);
    requestSignal?.throwIfAborted();
  } catch (error) {
    if (firstWireAttempt) markWireAttemptError(firstWireAttempt, error);
    throw error;
  }
  const dispatcher = getModelDispatcher();
  const replayable = isReplayableModelRequest(input, init);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const currentWireAttempt = firstWireAttempt;
      firstWireAttempt = undefined;
      return await fetchObservedAttempt(wireScope, input, init, () => (
        undiciFetch(
          input as Parameters<typeof undiciFetch>[0],
          {
            ...(init as Parameters<typeof undiciFetch>[1]),
            dispatcher,
          },
        ) as unknown as Promise<Response>
      ), currentWireAttempt);
    } catch (error) {
      // fetch 只要 reject 就说明连响应头都没拿到（响应体中途出错是 resolve 之后在流上
      // 报），所以这里重发不会产生重复的可见内容，也不会重复触发已生效的服务端副作用。
      if (
        !replayable ||
        attempt >= MODEL_CONNECTION_RETRY_DELAYS_MS.length ||
        requestSignal?.aborted === true ||
        !isConnectionResetError(error)
      ) {
        throw error;
      }
      await sleep(MODEL_CONNECTION_RETRY_DELAYS_MS[attempt]!, requestSignal);
    }
  }
};

async function fetchObservedAttempt(
  scope: WireScope | undefined,
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  fetcher: () => Promise<Response>,
  existingAttempt?: WireAttempt,
): Promise<Response> {
  if (!scope) return fetcher();
  const attempt = existingAttempt ?? beginWireAttempt(scope, input, init);
  try {
    return observeWireResponse(scope, attempt, await fetcher());
  } catch (error) {
    markWireAttemptError(attempt, error);
    throw error;
  }
}

/** 仅供测试隔离 process.env 与连接池；生产代码不需要主动重置。 */
export async function resetModelTransportForTests(): Promise<void> {
  const previous = activeTransport?.dispatcher;
  activeTransport = null;
  preflightSuccessCache.clear();
  if (previous) await previous.destroy();
}
