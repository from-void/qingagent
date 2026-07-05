import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 端点默认必须为空:源码构建/本地构建不带官方注入时,遥测整体静默不启用。
export const TELEMETRY_BUILD_INFO_FILENAME = "telemetry-build-info.json";
export const DEFAULT_UPDATE_POLICY_URL =
  "https://raw.githubusercontent.com/from-void/qingagent/main/update-policy.json";

const DEFAULT_WEBSITE_ID = "6a9cf3e2-5c5b-4bb3-919f-5c24e2260b61";
const DEFAULT_POLICY_TIMEOUT_MS = 1200;

type TelemetrySource = "build" | "policy";
type DisabledReason = "disabled" | "empty" | "invalid" | "policy";

export type TelemetryBuildInfo = {
  telemetryEndpoint?: unknown;
  updatePolicyUrl?: unknown;
};

export type TelemetryConfig =
  | {
      enabled: true;
      endpoint: string;
      sendUrl: string;
      batchUrl: string | null;
      websiteId: string;
      source: TelemetrySource;
    }
  | {
      enabled: false;
      endpoint: string;
      sendUrl: null;
      batchUrl: null;
      websiteId: string | null;
      source: DisabledReason;
    };

type PolicyFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type PolicyFetch = (url: string, init: RequestInit) => Promise<PolicyFetchResponse>;

export type LoadTelemetryConfigOptions = {
  env?: NodeJS.ProcessEnv;
  buildInfo?: TelemetryBuildInfo | null;
  fetchPolicy?: PolicyFetch;
  logger?: Pick<Console, "warn">;
  policyTimeoutMs?: number;
};

type ResolvedTelemetryUrls = {
  endpoint: string;
  sendUrl: string;
  batchUrl: string | null;
};

type PolicyEndpointResult =
  | { found: true; endpoint: string }
  | { found: false };

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEndpoint(value: unknown): string {
  return optionalString(value).replace(/\/+$/, "");
}

function formatUrl(url: URL): string {
  return url.toString().replace(/\/+$/, "");
}

export function resolveTelemetryUrls(value: unknown): ResolvedTelemetryUrls | null {
  const endpoint = normalizeEndpoint(value);
  if (!endpoint) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  const normalizedPathname = pathname === "" ? "/" : pathname;

  if (normalizedPathname === "/") {
    const send = new URL(url);
    send.pathname = "/api/send";
    send.search = "";
    const batch = new URL(url);
    batch.pathname = "/api/batch";
    batch.search = "";
    return { endpoint: formatUrl(send), sendUrl: formatUrl(send), batchUrl: formatUrl(batch) };
  }

  if (normalizedPathname.endsWith("/api/send")) {
    const send = new URL(url);
    send.pathname = normalizedPathname;
    send.search = "";
    const batch = new URL(send);
    batch.pathname = `${normalizedPathname.slice(0, -"/api/send".length)}/api/batch`;
    return { endpoint: formatUrl(send), sendUrl: formatUrl(send), batchUrl: formatUrl(batch) };
  }

  if (normalizedPathname.endsWith("/api/batch")) {
    const batch = new URL(url);
    batch.pathname = normalizedPathname;
    batch.search = "";
    const send = new URL(batch);
    send.pathname = `${normalizedPathname.slice(0, -"/api/batch".length)}/api/send`;
    return { endpoint: formatUrl(send), sendUrl: formatUrl(send), batchUrl: formatUrl(batch) };
  }

  // 非 Umami 标准路径按“完整 send endpoint”处理,不猜测批量端点。
  url.pathname = normalizedPathname;
  url.search = "";
  return { endpoint: formatUrl(url), sendUrl: formatUrl(url), batchUrl: null };
}

export function readTelemetryBuildInfo(): TelemetryBuildInfo | null {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(dir, TELEMETRY_BUILD_INFO_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TelemetryBuildInfo) : null;
  } catch {
    return null;
  }
}

function disabledConfig(
  source: DisabledReason,
  endpoint: string,
  websiteId: string | null,
): TelemetryConfig {
  return { enabled: false, endpoint, sendUrl: null, batchUrl: null, websiteId, source };
}

function parsePolicyEndpoint(policy: unknown): PolicyEndpointResult {
  if (!policy || typeof policy !== "object") return { found: false };
  if (!Object.prototype.hasOwnProperty.call(policy, "telemetryEndpoint")) return { found: false };
  const value = (policy as { telemetryEndpoint?: unknown }).telemetryEndpoint;
  if (typeof value !== "string") return { found: false };
  return { found: true, endpoint: normalizeEndpoint(value) };
}

async function loadPolicyEndpoint(
  policyUrl: string,
  fetchPolicy: PolicyFetch | undefined,
  timeoutMs: number,
  logger: Pick<Console, "warn">,
): Promise<PolicyEndpointResult> {
  const fetcher = fetchPolicy ?? (globalThis.fetch as unknown as PolicyFetch | undefined);
  if (!fetcher || !policyUrl) return { found: false };

  try {
    const res = await fetcher(policyUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parsePolicyEndpoint(await res.json());
  } catch (err) {
    logger.warn("[telemetry] update policy unavailable, using build-time endpoint:", err);
    return { found: false };
  }
}

export async function loadTelemetryConfig(
  options: LoadTelemetryConfigOptions = {},
): Promise<TelemetryConfig> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const websiteId = optionalString(env.QINGAGENT_TELEMETRY_WEBSITE_ID) || DEFAULT_WEBSITE_ID;

  if (env.QINGAGENT_TELEMETRY_DISABLED === "1") {
    return disabledConfig("disabled", "", websiteId || null);
  }

  const buildInfo =
    Object.prototype.hasOwnProperty.call(options, "buildInfo")
      ? options.buildInfo
      : readTelemetryBuildInfo();
  const buildEndpoint = normalizeEndpoint(buildInfo?.telemetryEndpoint);

  if (!buildEndpoint) {
    return disabledConfig("empty", "", websiteId || null);
  }

  const policyUrl = optionalString(buildInfo?.updatePolicyUrl) || DEFAULT_UPDATE_POLICY_URL;
  const policyEndpoint = await loadPolicyEndpoint(
    policyUrl,
    options.fetchPolicy,
    options.policyTimeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS,
    logger,
  );
  const source: TelemetrySource = policyEndpoint.found ? "policy" : "build";
  const endpoint = policyEndpoint.found ? policyEndpoint.endpoint : buildEndpoint;
  const urls = resolveTelemetryUrls(endpoint);
  if (!urls || !websiteId) {
    return disabledConfig(policyEndpoint.found ? "policy" : "invalid", endpoint, websiteId || null);
  }

  return { enabled: true, ...urls, websiteId, source };
}
