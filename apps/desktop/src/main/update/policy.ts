import { DEFAULT_UPDATE_POLICY_URL, readTelemetryBuildInfo } from "../telemetry/config.js";

const DEFAULT_POLICY_TIMEOUT_MS = 1200;
const TRUSTED_POLICY_HOST = "raw.githubusercontent.com";
const TRUSTED_POLICY_PATH = "/void2anything/qingagent/main/update-policy.json";

// 强更策略只能来自官方仓库的固定 raw 文件。构建时注入的 URL 也必须经过同一校验，
// 不能把一次构建配置错误扩大为任意远端可强制升级的能力。
export function isTrustedUpdatePolicyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === TRUSTED_POLICY_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === TRUSTED_POLICY_PATH &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export type UpdatePolicy = {
  minSupported: string | null;
};

type PolicyFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type UpdatePolicyFetch = (url: string, init: RequestInit) => Promise<PolicyFetchResponse>;

type PrereleaseIdentifier =
  | { type: "number"; value: number; raw: string }
  | { type: "string"; value: string };

type ParsedSemVer = {
  major: number;
  minor: number;
  patch: number;
  prerelease: PrereleaseIdentifier[];
};

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveUpdatePolicyUrl(): string {
  const configuredUrl = optionalString(readTelemetryBuildInfo()?.updatePolicyUrl);
  return isTrustedUpdatePolicyUrl(configuredUrl) ? configuredUrl : DEFAULT_UPDATE_POLICY_URL;
}

function parsePrerelease(value: string | undefined): PrereleaseIdentifier[] | null {
  if (!value) return [];
  const parts = value.split(".");
  const out: PrereleaseIdentifier[] = [];
  for (const part of parts) {
    if (!part || !/^[0-9A-Za-z-]+$/.test(part)) return null;
    if (/^\d+$/.test(part)) {
      if (part.length > 1 && part.startsWith("0")) return null;
      out.push({ type: "number", value: Number(part), raw: part });
    } else {
      out.push({ type: "string", value: part });
    }
  }
  return out;
}

function parseSemVer(value: string): ParsedSemVer | null {
  const raw = value.trim();
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return null;
  const prerelease = parsePrerelease(match[4]);
  if (!prerelease) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function normalizeSemVer(value: string): string | null {
  return parseSemVer(value) ? value.trim().replace(/^v/, "") : null;
}

function comparePrerelease(a: PrereleaseIdentifier[], b: PrereleaseIdentifier[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    const left = a[index];
    const right = b[index];
    if (!left) return -1;
    if (!right) return 1;
    if (left.type === "number" && right.type === "number") {
      if (left.value !== right.value) return left.value < right.value ? -1 : 1;
      continue;
    }
    if (left.type === "number") return -1;
    if (right.type === "number") return 1;
    if (left.value !== right.value) return left.value < right.value ? -1 : 1;
  }
  return 0;
}

function compareSemVer(a: ParsedSemVer, b: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isBelowMinSupported(current: string, minSupported: string): boolean {
  const parsedCurrent = parseSemVer(current);
  const parsedMin = parseSemVer(minSupported);
  if (!parsedCurrent || !parsedMin) return false;
  return compareSemVer(parsedCurrent, parsedMin) < 0;
}

function parseUpdatePolicy(policy: unknown): UpdatePolicy {
  if (!policy || typeof policy !== "object") return { minSupported: null };
  const value = (policy as { minSupported?: unknown }).minSupported;
  if (typeof value !== "string") return { minSupported: null };
  return { minSupported: normalizeSemVer(value) };
}

export async function fetchUpdatePolicy(
  url = resolveUpdatePolicyUrl(),
  fetchImpl?: UpdatePolicyFetch,
  timeoutMs = DEFAULT_POLICY_TIMEOUT_MS,
): Promise<UpdatePolicy> {
  const fetcher = fetchImpl ?? (globalThis.fetch as unknown as UpdatePolicyFetch | undefined);
  if (!fetcher || !isTrustedUpdatePolicyUrl(url)) return { minSupported: null };

  // 用手动 AbortController + 可清理 timer 代替 AbortSignal.timeout:后者内部 timer 是 unref 的,
  // 会在 node:test(Node 22.x)里让"event loop 已 resolve 但 promise 仍 pending"误报整文件失败。
  // finally clearTimeout 恒清 → 无悬挂 timer;功能等价(超时即 abort)。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      headers: { Accept: "application/json" },
      // 策略端点没有重定向需求；拒绝重定向，避免 TLS 校验后的请求被带往非受信任源。
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseUpdatePolicy(await res.json());
  } catch {
    return { minSupported: null };
  } finally {
    clearTimeout(timer);
  }
}
