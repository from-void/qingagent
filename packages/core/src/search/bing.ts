// 0603 — Bing(国内 cn.bing.com)SERP 抓取 provider:确定性 fetch + parseBingSerp。
// best-effort:网络/反爬失败吞成 []。链接为真实 URL;广告在 parseBingSerp 里按 li.b_algo 天然剔除。
import { Buffer } from "node:buffer";
import { decodeHtml } from "@qingagent/doc-render/browser";
import {
  searchRequestSignal,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from "./provider.js";
import { parseBingSerp } from "./parseBing.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class BingProvider implements SearchProvider {
  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    if (!query.trim() || count <= 0) return [];
    try {
      const url = new URL("https://cn.bing.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("setlang", "zh-CN");
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: searchRequestSignal(options?.signal, 10_000),
      });
      if (!resp.ok) return [];
      const html = decodeHtml(
        Buffer.from(await resp.arrayBuffer()),
        resp.headers.get("content-type"),
      );
      return parseBingSerp(html, count);
    } catch {
      return [];
    }
  }
}
