import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { SearchProviderError, searchProviderErrorFromStatus } from "./errors.js";
import type { SearchResult } from "./provider.js";

// WSL/受限网络下国外搜索 API 需经代理,而 Node fetch 不读 proxy env。
// 这里按需注入 dispatcher:SEARCH_PROXY_URL 优先,否则 HTTPS_PROXY/https_proxy。
// 只作用于搜索 API 请求,不影响 DeepSeek 等其它出网(生产 VPS 不设 env 即直连)。
// 测试注入点:单测 mock 走这里(undiciFetch 不受 vi.stubGlobal("fetch") 影响)。
type FetchLike = typeof undiciFetch;
let activeFetch: FetchLike = undiciFetch;
export function __setSearchFetchForTest(fn: FetchLike | null): void {
  activeFetch = fn ?? undiciFetch;
}

let proxyDispatcher: Dispatcher | null | undefined;
function getSearchDispatcher(): Dispatcher | undefined {
  if (proxyDispatcher === undefined) {
    const url =
      process.env.SEARCH_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || "";
    proxyDispatcher = url ? new ProxyAgent(url) : null;
  }
  return proxyDispatcher ?? undefined;
}

export function normalizeSearchLimit(count: number): number {
  return Math.max(0, Math.floor(count));
}

export function assertApiKey(providerId: string, apiKey: string): string {
  const value = apiKey.trim();
  if (!value) {
    throw new SearchProviderError("auth", `${providerId} API key is required`, {
      providerId,
    });
  }
  return value;
}

export async function readSearchJson(response: Response, providerId: string): Promise<unknown> {
  if (!response.ok) throw searchProviderErrorFromStatus(providerId, response.status);
  try {
    return await response.json();
  } catch (err) {
    throw new SearchProviderError("network", `${providerId} returned invalid JSON`, {
      providerId,
      cause: err,
    });
  }
}

export async function fetchSearchJson(
  providerId: string,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<unknown> {
  try {
    // 必须用 undici 包自身的 fetch:Node 内置 fetch 对外部 undici 实例的 ProxyAgent
    // 会报 invalid onRequestStart(实例不兼容),静默变 network 错误。
    const dispatcher = getSearchDispatcher();
    const response = (await activeFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      ...(dispatcher ? { dispatcher } : {}),
    })) as unknown as Response;
    return await readSearchJson(response, providerId);
  } catch (err) {
    if (err instanceof SearchProviderError) throw err;
    throw new SearchProviderError("network", `${providerId} search request failed`, {
      providerId,
      cause: err,
    });
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function cleanSnippet(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function pushSearchResult(
  out: SearchResult[],
  count: number,
  title: unknown,
  url: unknown,
  snippet: unknown,
): void {
  if (out.length >= count) return;
  const normalizedTitle = stringValue(title).trim();
  const normalizedUrl = stringValue(url).trim();
  if (!normalizedTitle || !/^https?:\/\//i.test(normalizedUrl)) return;
  out.push({
    title: normalizedTitle,
    url: normalizedUrl,
    snippet: cleanSnippet(stringValue(snippet)),
  });
}
