// DeepSeek 联网搜索:走 DeepSeek 的 anthropic 兼容端点 + 服务端 web_search_20250305 工具。
// 一次请求里 DeepSeek 自动生成检索词、抓全页、综合出答案,并回传来源列表。
// 参考 github.com/lyumeng/websearch-deepseek(MCP server,同一机制)。
import type { SearchProvider, SearchResult } from "./provider.js";

const DEEPSEEK_ANTHROPIC_MESSAGES_URL = "https://api.deepseek.com/anthropic/v1/messages";

export interface DeepseekWebSearchOutcome {
  /** model 读全页后综合的答案 */
  answer: string;
  /** 检索来源(标题 + 链接;正文是加密的,拿不到明文摘要) */
  sources: SearchResult[];
}

/** 调一次 DeepSeek web_search,解析出综合答案 + 来源。失败抛错(由调用方兜底)。 */
export async function callDeepseekWebSearch(
  query: string,
  apiKey: string,
  model = "deepseek-v4-flash",
  maxResults = 8,
): Promise<DeepseekWebSearchOutcome> {
  const response = await fetch(DEEPSEEK_ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`DeepSeek web_search HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as unknown;
  return parseDeepseekWebSearchResult(data, maxResults);
}

/**
 * 解析 DeepSeek web_search 响应 → 综合答案 + 来源。
 * 对付不可信响应:content 缺失/非数组、block 字段缺失/类型不符、result 无 url 等一律安全跳过,绝不抛。
 */
export function parseDeepseekWebSearchResult(data: unknown, maxResults = 8): DeepseekWebSearchOutcome {
  const content = (data as { content?: unknown } | null)?.content;
  const blocks = Array.isArray(content) ? content : [];
  const sources: SearchResult[] = [];
  let answer = "";
  for (const blockRaw of blocks) {
    if (!blockRaw || typeof blockRaw !== "object") continue;
    const block = blockRaw as Record<string, unknown>;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const rRaw of block.content) {
        if (!rRaw || typeof rRaw !== "object") continue;
        const r = rRaw as Record<string, unknown>;
        if (r.type === "web_search_result" && typeof r.url === "string" && r.url) {
          sources.push({
            title: typeof r.title === "string" && r.title ? r.title : r.url,
            url: r.url,
            snippet: "",
          });
        }
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      answer += block.text;
    }
  }
  return { answer: answer.trim(), sources: sources.slice(0, Math.max(1, maxResults)) };
}

/**
 * DeepSeek 联网作为 SearchProvider:首条返回 model 综合答案(snippet=答案),
 * 其后是来源列表。空答案/无来源时回退为纯来源,异常则返回 [](best-effort)。
 */
export class DeepSeekWebSearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = "deepseek-v4-flash",
  ) {}

  async search(query: string, count: number): Promise<SearchResult[]> {
    const limit = Math.max(0, Math.floor(count));
    if (!query.trim() || limit <= 0 || !this.apiKey) return [];
    try {
      const { answer, sources } = await callDeepseekWebSearch(query, this.apiKey, this.model, limit);
      if (!answer && sources.length === 0) return [];
      const results: SearchResult[] = [];
      if (answer) {
        results.push({
          title: `联网检索综述:${query}`.slice(0, 80),
          url: sources[0]?.url ?? "",
          snippet: answer.slice(0, 800),
        });
      }
      results.push(...sources);
      return results;
    } catch {
      return [];
    }
  }
}

/**
 * 流式调 DeepSeek web_search,**只取来源链接就掐断**(不等它写综述)。
 * 实测:一次搜索 80-90% 的时间花在模型写那段综述上,而来源链接(web_search_tool_result)
 * 在 ~2s 就整块到达。读到该块即 abort 关连接,典型 ~2s 拿到链接;失败/无结果返回 []。
 * 注:为防模型偷懒只凭记忆答(不产生 web_search_tool_result),加 system 强制先检索。
 */
export async function fetchDeepseekSearchLinks(
  query: string,
  apiKey: string,
  count: number,
  model = "deepseek-v4-flash",
): Promise<SearchResult[]> {
  const limit = Math.max(1, Math.floor(count));
  if (!query.trim() || !apiKey) return [];

  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        stream: true,
        system: "必须先调用 web_search 检索实时网页再回答,不要只凭记忆。",
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
      signal: controller.signal,
    });
  } catch {
    return [];
  }
  if (!response.ok || !response.body) {
    controller.abort();
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const links: SearchResult[] = [];
  let buffer = "";
  let wsIndex: number | null = null;
  let partialJson = "";
  const pushResult = (r: unknown): void => {
    if (!r || typeof r !== "object") return;
    const rec = r as Record<string, unknown>;
    if (rec.type === "web_search_result" && typeof rec.url === "string" && rec.url) {
      links.push({
        title: typeof rec.title === "string" && rec.title ? rec.title : rec.url,
        url: rec.url,
        snippet: "",
      });
    }
  };

  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = ev.type;
        if (type === "content_block_start") {
          const cb = (ev.content_block as Record<string, unknown> | undefined) ?? {};
          if (cb.type === "web_search_tool_result") {
            wsIndex = typeof ev.index === "number" ? ev.index : null;
            if (Array.isArray(cb.content)) for (const r of cb.content) pushResult(r);
          }
        } else if (type === "content_block_delta" && ev.index === wsIndex) {
          const delta = (ev.delta as Record<string, unknown> | undefined) ?? {};
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            partialJson += delta.partial_json;
          }
        } else if (type === "content_block_stop" && ev.index === wsIndex) {
          if (links.length === 0 && partialJson) {
            try {
              const arr = JSON.parse(partialJson);
              if (Array.isArray(arr)) for (const r of arr) pushResult(r);
            } catch {
              /* 忽略半截 JSON */
            }
          }
          done = true; // 链接已拿全 → 掐断,不等综述
          break;
        }
      }
    }
  } catch {
    /* 流读取异常:返回已拿到的链接(可能为空) */
  } finally {
    controller.abort(); // 关连接 → 服务端停止继续生成综述
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  return links.slice(0, limit);
}
