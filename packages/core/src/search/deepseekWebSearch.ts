// DeepSeek 联网搜索:走 DeepSeek 的 anthropic 兼容端点 + 服务端 web_search_20250305 工具。
// answer 综合版已删(260706 拍板):掐流取链接是刻意取舍——速度优先、正文走自有抓取管线保证过程可视化;如需 answer 回看 git 历史。
// 参考 github.com/lyumeng/websearch-deepseek(MCP server,同一机制)。
import type { SearchResult } from "./provider.js";
import { DEEPSEEK_MODEL_IDS, type ApiKeyOrigin } from "../llm/modelConfig.js";
import { recordUsageEvent } from "../db/usageRepo.js";
import type { RequestContext } from "@mastra/core/request-context";
import { nextUsageAttempt } from "../llm/usageAttempt.js";

const DEEPSEEK_ANTHROPIC_MESSAGES_URL = "https://api.deepseek.com/anthropic/v1/messages";

export interface DeepseekSearchUsageContext {
  sessionId: string;
  runId?: string | null;
  keyOrigin: ApiKeyOrigin;
  requestContext?: RequestContext;
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
  model = DEEPSEEK_MODEL_IDS.flash,
  usageContext?: DeepseekSearchUsageContext,
): Promise<SearchResult[]> {
  const limit = Math.max(1, Math.floor(count));
  if (!query.trim() || !apiKey) return [];

  const controller = new AbortController();
  const recordMissing = (reason: string) => {
    if (!usageContext) return;
    void recordUsageEvent({
      ...usageContext,
      callSite: "webSearch",
      modelId: model,
      usageState: "missing",
      reason,
      attempt: nextUsageAttempt(usageContext.requestContext, "webSearch", null),
    });
  };
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
  } catch (error) {
    recordMissing(error instanceof Error && error.name === "AbortError"
      ? "provider_request_aborted"
      : "provider_request_error");
    return [];
  }
  if (!response.ok || !response.body) {
    controller.abort();
    recordMissing(response.ok ? "provider_stream_missing_body" : `provider_http_${response.status}`);
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

  let settleReason = "search_links_early_abort";
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
    settleReason = "provider_stream_error";
    /* 流读取异常:返回已拿到的链接(可能为空) */
  } finally {
    controller.abort(); // 关连接 → 服务端停止继续生成综述
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    // 设计上拿到链接立即掐流，永远等不到 provider usage；只留请求事实，不伪造 token。
    recordMissing(settleReason);
  }

  return links.slice(0, limit);
}
