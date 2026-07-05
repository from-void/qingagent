import type { SearchProvider, SearchResult } from "./provider.js";
import {
  asArray,
  asRecord,
  assertApiKey,
  fetchSearchJson,
  firstString,
  normalizeSearchLimit,
  pushSearchResult,
} from "./apiUtils.js";

const PROVIDER_ID = "exa";
const ENDPOINT = "https://api.exa.ai/search";

export class ExaProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const limit = normalizeSearchLimit(count);
    if (!query.trim() || limit <= 0) return [];
    const apiKey = assertApiKey(PROVIDER_ID, this.apiKey);
    const data = await fetchSearchJson(PROVIDER_ID, ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        numResults: limit,
        contents: { highlights: true },
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const root = asRecord(data);
    const out: SearchResult[] = [];
    for (const item of asArray(root?.results)) {
      const record = asRecord(item);
      if (!record) continue;
      pushSearchResult(
        out,
        limit,
        record.title,
        record.url,
        firstString(asArray(record.highlights)) || record.summary || record.text,
      );
    }
    return out;
  }
}
