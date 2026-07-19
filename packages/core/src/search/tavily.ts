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

const PROVIDER_ID = "tavily";
const ENDPOINT = "https://api.tavily.com/search";

export class TavilyProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = normalizeSearchLimit(count);
    if (!query.trim() || limit <= 0) return [];
    const apiKey = assertApiKey(PROVIDER_ID, this.apiKey);
    const data = await fetchSearchJson(PROVIDER_ID, ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: searchRequestSignal(options?.signal, 12_000),
    });

    const root = asRecord(data);
    const out: SearchResult[] = [];
    for (const item of asArray(root?.results)) {
      const record = asRecord(item);
      if (!record) continue;
      pushSearchResult(out, limit, record.title, record.url, record.content);
    }
    return out;
  }
}
