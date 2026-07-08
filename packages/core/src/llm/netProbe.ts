import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

type LogFn = (line: string) => void;
type DiagnosticMessage = Record<string, unknown>;
type RequestMeta = {
  origin: string;
  path: string;
  startedAt: number;
};

const CHANNELS = {
  beforeConnect: "undici:client:beforeConnect",
  connected: "undici:client:connected",
  connectError: "undici:client:connectError",
  requestCreate: "undici:request:create",
  requestHeaders: "undici:request:headers",
} as const;

let activeProbe: { uninstall: () => void } | null = null;

export function formatElapsedMs(startedAt: number, now: number = performance.now()): number {
  return Math.max(0, Math.round(now - startedAt));
}

export function shouldLogOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]";
  } catch {
    return false;
  }
}

export function pathnameOnly(path: string | null | undefined): string {
  if (!path) return "/";
  try {
    return new URL(path, "https://probe.invalid").pathname || "/";
  } catch {
    const [withoutQuery] = path.split("?");
    return withoutQuery || "/";
  }
}

/** freshConn 是近似诊断:同 origin 在本请求 create 之后出现 connected,即视为本请求触发了新连接。 */
export function isFreshConnection(requestStartedAt: number, connectedAt: number | undefined): boolean {
  return connectedAt !== undefined && connectedAt >= requestStartedAt;
}

export function installNetProbe(log: LogFn = console.log): () => void {
  if (process.env.QINGAGENT_NET_PROBE === "0") return () => {};
  if (activeProbe) return activeProbe.uninstall;

  const connectStartedAt = new Map<string, number>();
  const connectedAtByOrigin = new Map<string, number>();
  const requestMeta = new WeakMap<object, RequestMeta>();
  const subscriptions: Array<readonly [string, (message: unknown) => void]> = [];

  const subscribe = (name: string, handler: (message: DiagnosticMessage) => void): void => {
    const subscriber = (message: unknown): void => {
      handler(asRecord(message));
    };
    channel(name).subscribe(subscriber);
    subscriptions.push([name, subscriber]);
  };

  subscribe(CHANNELS.beforeConnect, (message) => {
    const origin = originFromConnectParams(message.connectParams);
    if (!shouldLogOrigin(origin)) return;
    connectStartedAt.set(origin, performance.now());
  });

  subscribe(CHANNELS.connected, (message) => {
    const origin = originFromConnectParams(message.connectParams);
    if (!shouldLogOrigin(origin)) return;
    const now = performance.now();
    connectedAtByOrigin.set(origin, now);
    const startedAt = connectStartedAt.get(origin) ?? now;
    log(`[netprobe] connect origin=${origin} ms=${formatElapsedMs(startedAt, now)}`);
  });

  subscribe(CHANNELS.connectError, (message) => {
    const origin = originFromConnectParams(message.connectParams);
    if (!shouldLogOrigin(origin)) return;
    const now = performance.now();
    const startedAt = connectStartedAt.get(origin) ?? now;
    log(
      `[netprobe] connectError origin=${origin} ms=${formatElapsedMs(startedAt, now)} err=${errorMessage(message.error)}`,
    );
  });

  subscribe(CHANNELS.requestCreate, (message) => {
    const request = requestFromMessage(message);
    if (!request) return;
    const origin = originFromRequest(request);
    if (!shouldLogOrigin(origin)) return;
    requestMeta.set(request, {
      origin,
      path: pathnameOnly(pathFromRequest(request)),
      startedAt: performance.now(),
    });
  });

  subscribe(CHANNELS.requestHeaders, (message) => {
    const request = requestFromMessage(message);
    if (!request) return;
    const meta = requestMeta.get(request);
    if (!meta) return;
    const now = performance.now();
    const freshConn = isFreshConnection(meta.startedAt, connectedAtByOrigin.get(meta.origin));
    log(
      `[netprobe] ttfb origin=${meta.origin} path=${meta.path} ms=${formatElapsedMs(meta.startedAt, now)} freshConn=${freshConn}`,
    );
  });

  const uninstall = (): void => {
    for (const [name, subscriber] of subscriptions) {
      channel(name).unsubscribe(subscriber);
    }
    subscriptions.length = 0;
    activeProbe = null;
  };
  activeProbe = { uninstall };
  return uninstall;
}

function asRecord(value: unknown): DiagnosticMessage {
  return value && typeof value === "object" ? value as DiagnosticMessage : {};
}

function originFromConnectParams(value: unknown): string | null {
  const params = asRecord(value);
  const direct = stringValue(params.origin);
  if (direct) return normalizeOrigin(direct);
  const protocol = stringValue(params.protocol) ?? "https:";
  const hostname = stringValue(params.hostname) ?? stringValue(params.host);
  if (!hostname) return null;
  const port = numberOrString(params.port);
  return normalizeOrigin(`${protocol}//${stripPort(hostname)}${port ? `:${port}` : ""}`);
}

function originFromRequest(request: object): string | null {
  const rec = asRecord(request);
  const origin = stringValue(rec.origin);
  if (origin) return normalizeOrigin(origin);
  const host = stringValue(rec.host) ?? stringValue(rec.hostname);
  if (!host) return null;
  const protocol = stringValue(rec.protocol) ?? "https:";
  const port = numberOrString(rec.port);
  return normalizeOrigin(`${protocol}//${stripPort(host)}${port ? `:${port}` : ""}`);
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function pathFromRequest(request: object): string | null {
  const rec = asRecord(request);
  return stringValue(rec.path) ?? stringValue(rec.pathname) ?? stringValue(rec.url);
}

function requestFromMessage(message: DiagnosticMessage): object | null {
  const request = message.request;
  return request && typeof request === "object" ? request : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrString(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  return stringValue(value);
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}
