import { GithubConnectorError } from "./githubErrors.js";

export const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GithubClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GithubRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  resource: string | null;
}

export interface GithubResponse<T> {
  data: T;
  rateLimit: GithubRateLimit;
  nextPage: number | null;
}

function finiteHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseGithubRateLimit(headers: Headers): GithubRateLimit {
  const reset = finiteHeader(headers, "x-ratelimit-reset");
  return {
    limit: finiteHeader(headers, "x-ratelimit-limit"),
    remaining: finiteHeader(headers, "x-ratelimit-remaining"),
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: headers.get("x-ratelimit-resource"),
  };
}

async function isGithubRateLimitResponse(
  response: Response,
  rateLimit: GithubRateLimit,
): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (rateLimit.remaining === 0 || response.headers.has("retry-after")) {
    return true;
  }
  try {
    const payload = await response.clone().json() as {
      message?: unknown;
      documentation_url?: unknown;
    };
    const detail = [payload.message, payload.documentation_url]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /(?:secondary\s+)?rate\s*limit|abuse\s+detection/i.test(detail);
  } catch {
    return false;
  }
}

export function parseGithubNextPage(headers: Headers): number | null {
  const link = headers.get("link");
  if (!link) return null;
  for (const match of link.matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
    if (!match[2]?.split(/\s+/).includes("next")) continue;
    try {
      const page = Number(new URL(match[1] ?? "").searchParams.get("page"));
      return Number.isSafeInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function encodeGithubPathSegment(value: string): string {
  if (!value || value.includes("\0")) throw new GithubConnectorError("GitHub 路径参数非法", "INVALID_ARGUMENT", 400);
  return encodeURIComponent(value);
}

export function encodeGithubFilePath(path: string): string {
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new GithubConnectorError("GitHub 文件路径非法", "INVALID_ARGUMENT", 400);
  }
  return segments.map(encodeGithubPathSegment).join("/");
}

export class GithubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GithubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    const parsedBase = new URL(this.baseUrl);
    const loopback = parsedBase.hostname === "127.0.0.1" || parsedBase.hostname === "localhost" || parsedBase.hostname === "::1";
    if (options.token && parsedBase.protocol !== "https:" && !loopback) {
      throw new GithubConnectorError("拒绝向非 HTTPS GitHub API 发送凭证", "UNSAFE_BASE_URL", 500);
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<GithubResponse<T>> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new GithubConnectorError("GitHub API 路径非法", "INVALID_ARGUMENT", 400);
    init.signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("github request timeout"), this.timeoutMs);
    timer.unref?.();
    const forwardAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
      headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
      headers.set("User-Agent", "QingAgent-Connector/1.0");
      if (this.options.token) headers.set("Authorization", `Bearer ${this.options.token}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) throw new GithubConnectorError("拒绝 GitHub API 重定向", "UNSAFE_REDIRECT", 502);
      const rateLimit = parseGithubRateLimit(response.headers);
      if (response.status === 401) throw new GithubConnectorError("GitHub 授权已失效", "NEEDS_REAUTH", 401);
      if (await isGithubRateLimitResponse(response, rateLimit)) {
        throw new GithubConnectorError("GitHub 请求已限速", "RATE_LIMIT", response.status, rateLimit.resetAt);
      }
      if (response.status === 403) {
        throw new GithubConnectorError("GitHub 权限不足或访问被拒绝", "ACCESS_DENIED", 403);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (cause) {
        throw new GithubConnectorError(`GitHub 返回了畸形 JSON: ${String(cause)}`, "INVALID_RESPONSE", 502);
      }
      if (!response.ok) throw new GithubConnectorError(`GitHub API 请求失败 (${response.status})`, "GITHUB_API_ERROR", response.status);
      return { data: data as T, rateLimit, nextPage: parseGithubNextPage(response.headers) };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  user(signal?: AbortSignal) { return this.request<{ id: number; login: string }>("/user", { signal }); }
  listRepos(owner?: string, page = 1, signal?: AbortSignal) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new GithubConnectorError("GitHub 页码非法", "INVALID_ARGUMENT", 400);
    }
    const path = owner
      ? `/users/${encodeGithubPathSegment(owner)}/repos?per_page=100&page=${page}`
      : `/user/repos?per_page=100&sort=updated&page=${page}`;
    return this.request<Array<Record<string, unknown>>>(path, { signal });
  }
  tree(owner: string, repo: string, ref: string, signal?: AbortSignal) {
    return this.request<{ tree: Array<Record<string, unknown>>; truncated?: boolean }>(`/repos/${encodeGithubPathSegment(owner)}/${encodeGithubPathSegment(repo)}/git/trees/${encodeGithubPathSegment(ref)}?recursive=1`, { signal });
  }
  contents(owner: string, repo: string, path: string, ref?: string, signal?: AbortSignal) {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<Record<string, unknown>>(`/repos/${encodeGithubPathSegment(owner)}/${encodeGithubPathSegment(repo)}/contents/${encodeGithubFilePath(path)}${suffix}`, { signal });
  }
  searchCode(query: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ q: query, per_page: "30" });
    return this.request<{ total_count?: number; incomplete_results?: boolean; items?: Array<Record<string, unknown>> }>(`/search/code?${params.toString()}`, {
      signal,
      headers: { Accept: "application/vnd.github.text-match+json, application/vnd.github+json" },
    });
  }
}
