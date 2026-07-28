// 0603 — 多源搜索 provider:并行竞速 + 去重聚合 + 全失败兜底。
// 纯逻辑(provider 注入),不依赖网络,便于单测。各具体源(SearXNG/Bing/Mojeek…)各自实现
// SearchProvider 接口,组合进这里。
import type { SearchOptions, SearchProvider, SearchResult } from "./provider.js";

export interface SearchSource {
  /** 源名(日志/调试用) */
  name: string;
  provider: SearchProvider;
}

/**
 * 规范化结果 URL 用于去重:仅统一协议/主机大小写、去末尾斜杠、常见跟踪参数与 fragment。
 * pathname 和 query 保留原始大小写；解析失败则只 trim。
 */
export function normalizeResultUrl(url: string): string {
  try {
    const u = new URL(url);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "spm"];
    for (const k of drop) u.searchParams.delete(k);
    let s = u.toString();
    s = s.replace(/\/$/, "");
    return s;
  } catch {
    return url.trim();
  }
}

/** 按规范化 URL 去重,保留首次出现(更靠前的源/结果优先)。 */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r.url) continue;
    const key = normalizeResultUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * 竞速取优:并行跑所有 promise,任一源率先返回 ≥ count 条即立即采用(低时延);
 * 若无源达标,则等全部结束、按源顺序合并全部结果返回(交给上层去重/截断)。
 * 单个源抛错视为空结果(best-effort),绝不让整体 reject。
 */
export async function raceToGood(
  promises: Array<Promise<SearchResult[]>>,
  count: number,
): Promise<SearchResult[]> {
  if (promises.length === 0) return [];
  const safe = promises.map((p) => Promise.resolve(p).catch((): SearchResult[] => []));
  return new Promise<SearchResult[]>((resolve) => {
    const collected: SearchResult[][] = new Array(safe.length);
    let remaining = safe.length;
    let done = false;
    safe.forEach((p, i) => {
      void p.then((r) => {
        collected[i] = r;
        remaining -= 1;
        if (done) return;
        if (count > 0 && r.length >= count) {
          done = true;
          resolve(r);
        } else if (remaining === 0) {
          done = true;
          resolve(collected.filter(Boolean).flat());
        }
      });
    });
  });
}

/**
 * 多源搜索 provider。实现现有 SearchProvider 接口 → webSearch.ts 可直接换上,I/O 不变。
 */
export class MultiSourceSearchProvider implements SearchProvider {
  constructor(private readonly sources: SearchSource[]) {}

  async search(query: string, count: number, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = Math.max(0, Math.floor(count));
    if (!query.trim() || limit <= 0 || this.sources.length === 0) return [];
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) abortFromParent();
    else options?.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const childOptions = { ...options, signal: controller.signal };
      const merged = await raceToGood(
        this.sources.map((s) => s.provider.search(query, limit, childOptions)),
        limit,
      );
      return dedupeResults(merged).slice(0, limit);
    } finally {
      options?.signal?.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Search race settled", "AbortError"));
      }
    }
  }
}
