import * as cheerio from "cheerio";
import { cleanText } from "@qingagent/doc-render/browser";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function toHttpUrl(rawHref: string | undefined): string | null {
  if (!rawHref) return null;

  try {
    const url = new URL(unwrapDdgUrl(rawHref), "https://duckduckgo.com");
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function unwrapDdgUrl(rawHref: string): string {
  try {
    const url = new URL(rawHref, "https://duckduckgo.com");
    const hostname = url.hostname.toLowerCase();
    if (
      (hostname === "duckduckgo.com" || hostname.endsWith(".duckduckgo.com")) &&
      url.pathname === "/l/"
    ) {
      return url.searchParams.get("uddg") ?? rawHref;
    }
  } catch {
    return rawHref;
  }

  return rawHref;
}

function pushResult(
  results: SearchResult[],
  title: string,
  url: string | null,
  snippet: string,
  limit: number,
): void {
  if (results.length >= limit || !url) return;

  const cleanedTitle = cleanText(title);
  if (!cleanedTitle) return;

  results.push({
    title: cleanedTitle,
    url,
    snippet: cleanText(snippet),
  });
}

export function parseDdgHtml(html: string, limit = 10): SearchResult[] {
  if (!html || limit <= 0) return [];

  try {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $(".result, .web-result").each((_, element) => {
      const item = $(element);
      const anchor = item.find("a.result__a").first();
      pushResult(
        results,
        anchor.text(),
        toHttpUrl(anchor.attr("href")),
        item.find(".result__snippet").first().text(),
        limit,
      );
    });

    return results;
  } catch {
    return [];
  }
}

export function parseLiteSerp(html: string, limit = 10): SearchResult[] {
  if (!html || limit <= 0) return [];

  try {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $("a.result-link").each((_, element) => {
      const anchor = $(element);
      const row = anchor.closest("tr");
      const snippet =
        anchor.nextAll(".result-snippet").first().text() ||
        row.nextAll("tr").find(".result-snippet").first().text() ||
        anchor.parent().nextAll().find(".result-snippet").first().text();

      pushResult(results, anchor.text(), toHttpUrl(anchor.attr("href")), snippet, limit);
    });

    return results;
  } catch {
    return [];
  }
}
