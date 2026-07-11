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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("github request timeout"), this.timeoutMs);
    timer.unref?.();
    const forwardAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/vnd.github+json");
      headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
      headers.set("User-Agent", "QingAgent-Connector/1.0");
      if (this.options.token) headers.set("Authorization", `Bearer ${this.options.token}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) throw new GithubConnectorError("拒绝 GitHub API 重定向", "UNSAFE_REDIRECT", 502);
      const rateLimit = parseGithubRateLimit(response.headers);
      if (response.status === 401) throw new GithubConnectorError("GitHub 授权已失效", "NEEDS_REAUTH", 401);
      if (response.status === 403 || response.status === 429) {
        throw new GithubConnectorError("GitHub 请求已限速", "RATE_LIMIT", response.status, rateLimit.resetAt);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (cause) {
        throw new GithubConnectorError(`GitHub 返回了畸形 JSON: ${String(cause)}`, "INVALID_RESPONSE", 502);
      }
      if (!response.ok) throw new GithubConnectorError(`GitHub API 请求失败 (${response.status})`, "GITHUB_API_ERROR", response.status);
      return { data: data as T, rateLimit };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  user(signal?: AbortSignal) { return this.request<{ id: number; login: string }>("/user", { signal }); }
  listRepos(owner?: string, signal?: AbortSignal) {
    const path = owner ? `/users/${encodeGithubPathSegment(owner)}/repos?per_page=100` : "/user/repos?per_page=100&sort=updated";
    return this.request<Array<Record<string, unknown>>>(path, { signal });
  }
  tree(owner: string, repo: string, ref: string, signal?: AbortSignal) {
    return this.request<{ tree: Array<Record<string, unknown>>; truncated?: boolean }>(`/repos/${encodeGithubPathSegment(owner)}/${encodeGithubPathSegment(repo)}/git/trees/${encodeGithubPathSegment(ref)}?recursive=1`, { signal });
  }
  contents(owner: string, repo: string, path: string, ref?: string, signal?: AbortSignal) {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request<Record<string, unknown>>(`/repos/${encodeGithubPathSegment(owner)}/${encodeGithubPathSegment(repo)}/contents/${encodeGithubFilePath(path)}${suffix}`, { signal });
  }
}
