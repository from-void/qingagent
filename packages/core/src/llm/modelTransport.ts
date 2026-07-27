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

export const DEFAULT_MODEL_CONNECT_TIMEOUT_MS = 5_000;

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
  let { host: hostname, port } = url;
  // 与 EnvHttpProxyAgent 保持一致：移除端口但保留 IPv6 方括号。
  hostname = hostname.replace(/:\d*$/, "").toLowerCase();
  return {
    hostname,
    port: Number.parseInt(port, 10) || DEFAULT_PORTS[url.protocol] || 0,
  };
}

function matchesNoProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy === "*") return true;
  const { hostname, port } = normalizedHostAndPort(url);
  for (const entry of noProxy.split(/[,\s]/)) {
    if (!entry) continue;
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = (parsed ? parsed[1]! : entry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2]!, 10) : 0;
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

/**
 * 模型专用 fetch。npm undici 的 fetch 与 dispatcher 来自同一包，避免 Node 24 内建
 * fetch 的 undici.globalDispatcher.1 与 npm undici@8 的 .2 符号/handler 协议不兼容。
 */
export const modelFetch: typeof globalThis.fetch = async (input, init) => {
  // 既有 provider/BranchCall 单测通过 vi.stubGlobal 拦截 wire body；测试替身不是生产
  // 传输路径，显式保留这个观测缝，黑洞集成测试不 stub global fetch，仍走真实 dispatcher。
  if (process.env.VITEST && globalThis.fetch !== nativeGlobalFetch) {
    return globalThis.fetch(input, init);
  }
  const rawUrl = typeof input === "string" || input instanceof URL
    ? input.toString()
    : input.url;
  const requestSignal = init?.signal ??
    (typeof input === "string" || input instanceof URL ? undefined : input.signal);
  const preflightController = new AbortController();
  const relayAbort = () => preflightController.abort(requestSignal?.reason);
  if (requestSignal?.aborted) relayAbort();
  else requestSignal?.addEventListener("abort", relayAbort, { once: true });
  const preflightTimer = setTimeout(
    () => preflightController.abort(
      new DOMException("Model DNS preflight timed out", "TimeoutError"),
    ),
    resolveModelConnectTimeoutMs(),
  );
  try {
    await validateModelFetchUrl(rawUrl, process.env, preflightController.signal);
  } finally {
    clearTimeout(preflightTimer);
    requestSignal?.removeEventListener("abort", relayAbort);
  }
  requestSignal?.throwIfAborted();
  const dispatcher = getModelDispatcher();
  return await undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    },
  ) as unknown as Response;
};

/** 仅供测试隔离 process.env 与连接池；生产代码不需要主动重置。 */
export async function resetModelTransportForTests(): Promise<void> {
  const previous = activeTransport?.dispatcher;
  activeTransport = null;
  if (previous) await previous.destroy();
}
