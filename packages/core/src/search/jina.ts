import {
  searchRequestSignal,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from "./provider.js";
import {
  asArray,
  asRecord,
  assertApiKey,
  fetchSearchJson,
  normalizeSearchLimit,
  pushSearchResult,
} from "./apiUtils.js";

const PROVIDER_ID = "jina";
const ENDPOINT = "https://s.jina.ai/";

export class JinaProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = normalizeSearchLimit(count);
    if (!query.trim() || limit <= 0) return [];
    const apiKey = assertApiKey(PROVIDER_ID, this.apiKey);
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);
    const data = await fetchSearchJson(PROVIDER_ID, url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: searchRequestSignal(options?.signal, 12_000),
    });

    const root = asRecord(data);
    const rows = Array.isArray(data) ? data : asArray(root?.data);
    const out: SearchResult[] = [];
    for (const item of rows) {
      const record = asRecord(item);
      if (!record) continue;
      pushSearchResult(out, limit, record.title, record.url, record.content);
    }
    return out;
  }
}
