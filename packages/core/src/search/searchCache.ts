import type { SearchResult } from "./provider.js";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 100;

type CachedSearch = {
  results: SearchResult[];
  expiresAt: number;
};

const cache = new Map<string, CachedSearch>();

export function getCachedSearch(key: string): SearchResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, entry);
  return entry.results;
}

export function setCachedSearch(key: string, results: SearchResult[]): void {
  if (results.length === 0) return;

  cache.delete(key);
  cache.set(key, {
    results,
    expiresAt: Date.now() + TTL_MS,
  });

  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
}

export function __resetSearchCacheForTest(): void {
  cache.clear();
}
