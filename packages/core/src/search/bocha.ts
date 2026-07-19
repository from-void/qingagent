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

const PROVIDER_ID = "bocha";
const ENDPOINT = "https://api.bochaai.com/v1/web-search";

export class BochaProvider implements SearchProvider {
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
        count: limit,
        summary: true,
      }),
      signal: searchRequestSignal(options?.signal, 12_000),
    });

    const root = asRecord(data);
    const dataRecord = asRecord(root?.data);
    const webPages = asRecord(dataRecord?.webPages) ?? asRecord(root?.webPages);
    const out: SearchResult[] = [];
    for (const item of asArray(webPages?.value)) {
      const record = asRecord(item);
      if (!record) continue;
      pushSearchResult(out, limit, record.name, record.url, record.summary || record.snippet);
    }
    return out;
  }
}
