// 0603 — SearXNG 元搜索 provider(开源、自建优先):format=json 直出、无广告、聚合多引擎。
// 由搜索设置里的 SearXNG URL 配置(缺省关 → 直接返回 []);best-effort,异常吞成 []。
// SSRF 说明:SearXNG URL 是运维显式配置的可信内网/自建地址,故**不过** validateFetchUrl
// (那会拦死 localhost/私网);其返回的【结果链接】在后续 fetchArticle 时才做 SSRF 校验。
import {
  searchRequestSignal,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from "./provider.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SearxngJsonResult {
  title?: string;
  url?: string;
  content?: string;
}

export class SearxngProvider implements SearchProvider {
  constructor(private readonly baseUrl: string | undefined) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const base = this.baseUrl;
    if (!base || !query.trim() || count <= 0) return [];
    try {
      const normalizedBase = new URL(base);
      if (!normalizedBase.pathname.endsWith("/")) normalizedBase.pathname += "/";
      const url = new URL("search", normalizedBase);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const resp = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: searchRequestSignal(options?.signal, 8_000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { results?: SearxngJsonResult[] };
      const out: SearchResult[] = [];
      for (const r of data.results ?? []) {
        if (out.length >= count) break;
        if (!r.url || !/^https?:/i.test(r.url) || !r.title) continue;
        out.push({ title: r.title, url: r.url, snippet: r.content ?? "" });
      }
      return out;
    } catch {
      return [];
    }
  }
}
