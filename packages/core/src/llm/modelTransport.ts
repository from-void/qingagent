import {
  Client,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from "undici";

export const DEFAULT_MODEL_CONNECT_TIMEOUT_MS = 5_000;

type Env = Readonly<Record<string, string | undefined>>;

export interface ModelDispatcherConfig {
  connectTimeout: number;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

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
  };
}

export function createModelDispatcher(env: Env = process.env): EnvHttpProxyAgent {
  const config = resolveModelDispatcherConfig(env);
  return new EnvHttpProxyAgent({
    ...config,
    // EnvHttpProxyAgent 的 connectTimeout 只覆盖“连到代理”的 TCP；代理接受 TCP 后若
    // CONNECT 永不响应，默认还会等 300s。这里只缩短内部代理 Client 的 CONNECT
    // 响应头等待，不把 headersTimeout/bodyTimeout 施加到真正的模型请求。
    clientFactory: (origin, options) => new Client(origin, {
      ...(options as Client.Options),
      headersTimeout: config.connectTimeout,
    }),
  });
}

let activeTransport: {
  key: string;
  dispatcher: EnvHttpProxyAgent;
} | null = null;
const nativeGlobalFetch = globalThis.fetch;

function dispatcherKey(config: ModelDispatcherConfig): string {
  return JSON.stringify(config);
}

function getModelDispatcher(env: Env = process.env): EnvHttpProxyAgent {
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
