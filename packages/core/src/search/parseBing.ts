// 0603 — Bing SERP 解析(确定性,cheerio)。organic = #b_results > li.b_algo;
// 广告是 li.b_ad / .b_adTop / .b_adBottom,因只选 li.b_algo 故天然剔除。链接是真实 URL。
import * as cheerio from "cheerio";
import { cleanText } from "@qingagent/doc-render/browser";
import type { SearchResult } from "./provider.js";

export function parseBingSerp(
  html: string,
  limit = 10,
  options?: { strict?: boolean },
): SearchResult[] {
  if (limit <= 0) return [];
  if (!html) {
    if (options?.strict) throw new Error("Bing search returned invalid HTML");
    return [];
  }
  try {
    const $ = cheerio.load(html);
    if (options?.strict && $("#b_results").length === 0) {
      throw new Error("Bing search returned invalid HTML");
    }
    const results: SearchResult[] = [];
    $("#b_results > li.b_algo").each((_, el) => {
      if (results.length >= limit) return;
      const item = $(el);
      const a = item.find("h2 a").first();
      const href = a.attr("href");
      const title = cleanText(a.text());
      const snippet = cleanText(
        item.find(".b_caption p").first().text() ||
          item.find(".b_caption").first().text(),
      );
      if (!href || !title) return;
      if (!/^https?:/i.test(href)) return; // 只收 http(s),挡广告跳转/相对链接
      results.push({ title, url: href, snippet });
    });
    return results;
  } catch (error) {
    if (options?.strict) throw error;
    return [];
  }
}
