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

const PROVIDER_ID = "brave";
const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export class BraveProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = normalizeSearchLimit(count);
    if (!query.trim() || limit <= 0) return [];
    const apiKey = assertApiKey(PROVIDER_ID, this.apiKey);
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 20)));
    const data = await fetchSearchJson(PROVIDER_ID, url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: searchRequestSignal(options?.signal, 12_000),
    });

    const root = asRecord(data);
    const web = asRecord(root?.web);
    const out: SearchResult[] = [];
    for (const item of asArray(web?.results)) {
      const record = asRecord(item);
      if (!record) continue;
      pushSearchResult(out, limit, record.title, record.url, record.description);
    }
    return out;
  }
}
