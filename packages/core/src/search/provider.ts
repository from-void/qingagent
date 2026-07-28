import { Buffer } from "node:buffer";
import { decodeHtml, validateFetchUrl } from "@qingagent/doc-render/browser";
import {
  parseDdgHtml,
  parseLiteSerp,
  type SearchResult,
} from "./parseDuckDuckGo.js";
import { markSearchProviderQuota, shouldSkipSearchProvider } from "./health.js";

export type { SearchResult } from "./parseDuckDuckGo.js";

export interface SearchOptions {
  signal?: AbortSignal;
}

export interface SearchProvider {
  /** Best-effort: rate limits, network errors, and empty SERPs return [] rather than throwing. */
  search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]>;
}

export function searchRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ENDPOINTS = [
  {
    healthId: "ddg:html",
    url: "https://html.duckduckgo.com/html/",
    parse: parseDdgHtml,
  },
  {
    healthId: "ddg:lite",
    url: "https://lite.duckduckgo.com/lite/",
    parse: parseLiteSerp,
  },
] as const;

function isConnectionFailure(err: unknown): boolean {
  const record =
    err && typeof err === "object" ? (err as { name?: unknown; message?: unknown }) : null;
  const name = typeof record?.name === "string" ? record.name : "";
  const message = typeof record?.message === "string" ? record.message : String(err);
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(message)
  );
}

export class DuckDuckGoProvider implements SearchProvider {
  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = Math.max(0, Math.floor(count));
    if (!query.trim() || limit <= 0) return [];

    for (const endpoint of ENDPOINTS) {
      if (shouldSkipSearchProvider(endpoint.healthId)) continue;
      try {
        const results = await this.searchOne(
          endpoint.url,
          endpoint.parse,
          query,
          limit,
          options?.signal,
        );
        if (results.length > 0) return results;
      } catch (err) {
        if (options?.signal?.aborted) return [];
        if (isConnectionFailure(err)) {
          markSearchProviderQuota(endpoint.healthId, 10 * 60 * 1000);
        }
        // Best-effort provider: try the next endpoint, then return [].
      }
    }

    return [];
  }

  private async searchOne(
    endpoint: string,
    parse: (html: string, limit: number) => SearchResult[],
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const url = await validateFetchUrl(endpoint);
    const response = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
      signal: searchRequestSignal(signal, 2_500),
    });

    if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);

    const html = decodeHtml(
      Buffer.from(await response.arrayBuffer()),
      response.headers.get("content-type"),
    );
    return parse(html, limit);
  }
}
