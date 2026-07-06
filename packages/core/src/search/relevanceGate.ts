import type { SearchResult } from "./provider.js";

export const RELEVANCE_MIN_SCORE = 0.25;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function tokenizeKeywords(keywords: string): string[] {
  return keywords
    .trim()
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsLooseWord(haystack: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i").test(haystack);
}

function bigrams(value: string): Set<string> {
  const chars = Array.from(value);
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    out.add(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

function scoreCjkToken(haystack: string, token: string): number {
  if (haystack.includes(token)) return 1;

  const tokenBigrams = bigrams(token);
  if (tokenBigrams.size === 0) return 0;

  const haystackBigrams = bigrams(haystack);
  let hits = 0;
  for (const item of tokenBigrams) {
    if (haystackBigrams.has(item)) hits += 1;
  }
  return hits / tokenBigrams.size >= 0.6 ? 0.6 : 0;
}

export function scoreRelevance(
  result: { title: string; snippet: string },
  keywords: string,
): number {
  const tokens = tokenizeKeywords(keywords);
  if (tokens.length === 0) return 1;

  const haystack = `${result.title} ${result.snippet}`.toLowerCase();
  const score = tokens.reduce((sum, token) => {
    if (CJK_RE.test(token)) return sum + scoreCjkToken(haystack, token);
    return sum + (containsLooseWord(haystack, token) ? 1 : 0);
  }, 0);
  return score / tokens.length;
}

export function filterByRelevance(
  results: SearchResult[],
  keywords: string,
): { kept: SearchResult[]; dropped: number } {
  const tokens = tokenizeKeywords(keywords);
  if (tokens.length === 0) return { kept: results, dropped: 0 };

  const kept = results.filter((result) => scoreRelevance(result, keywords) >= RELEVANCE_MIN_SCORE);
  return { kept, dropped: results.length - kept.length };
}
