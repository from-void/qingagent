import { createTool } from "@mastra/core/tools";
import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchCardBody, ResearchCardItem } from "@qingagent/contract-ts";
import {
  getManagedSearchProvider,
  getPrimarySearchConfig,
} from "../search/managedSearch.js";
import { DEEPSEEK_MODEL_IDS, resolveDeepseekAuth, resolveModelId } from "../llm/modelConfig.js";
import {
  fetchDeepseekSearchLinks,
  type DeepseekSearchUsageContext,
} from "../search/deepseekWebSearch.js";
import type { SearchResult } from "../search/provider.js";
import { getCachedSearch, setCachedSearch } from "../search/searchCache.js";
import { isSubstantiveContent } from "@qingagent/doc-render/browser";
import { fetchArticleTool } from "./fetchArticle.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";
import { getObservability } from "../mastra.js";

const MAX_QUERY_LEN = 400;
// 单轮召回条数放宽(用户走查:每轮只回 4 条,模型要多搜好几轮才够素材,又慢又费)。
// DeepSeek 官方 web_search 一次通常能给 8-10 条相关来源,默认拉到 8、上限 10,
// 让模型一轮就拿够,减少重复检索轮次。
const DEFAULT_COUNT = 8;
const MAX_COUNT = 10;
// 抓取并发 = 召回上限:一次把召回的所有链接并行抓完(不再分批分轮,用户要求全并行)。
const FETCH_CONCURRENCY = MAX_COUNT;
const WEBSEARCH_EXCERPT_CHARS = 2500;
// 整体超时:DeepSeek(只取链接,流式掐断,~2s)与多源(Bing/DDG,~1-3s)并发竞速,
// DeepSeek 质量更好故优先;5s 内 DeepSeek 没回来就用多源,谁都没回就返回空。
const SEARCH_TIMEOUT_MS = 5000;
const ZERO_HIT_NOTE = "未检索到相关结果;请精简为 2-6 个关键词后重试,或改写检索角度";

type SearchLinksSource = "deepseek" | "multisource(DS兜底)" | "multisource(无DeepSeek)" | "cache";

type ToolWriter = {
  write: (chunk: Record<string, unknown>) => Promise<unknown> | unknown;
};

type ArticleFetchResult = {
  ok?: boolean;
  title?: string;
  text?: string;
  wordCount?: number;
  materialId?: string;
  via?: "static" | "browser";
};

type WebSearchItemStatus = "done" | "browser" | "skipped";

type WebSearchItem = {
  url: string;
  title: string;
  snippet: string;
  status: WebSearchItemStatus;
  wordCount: number;
  materialId: string;
  truncated: boolean;
  text: string;
};

type WebSearchItemInternal = WebSearchItem & {
  __fullText: string;
};

/** 给一个 promise 套超时:超时返回 fallback,并清掉定时器避免泄漏。 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function normalizeSearchCachePart(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildSearchCacheKey(
  query: string,
  keywords: string | null,
  limit: number,
  useDeepseek: boolean,
  deepseekModel?: string,
): string {
  return [
    normalizeSearchCachePart(query),
    normalizeSearchCachePart(keywords ?? ""),
    String(limit),
    `ds:${useDeepseek ? 1 : 0}`,
    ...(useDeepseek && deepseekModel && deepseekModel !== DEEPSEEK_MODEL_IDS.flash
      ? [`model:${normalizeSearchCachePart(deepseekModel)}`]
      : []),
  ].join("|");
}

function recordSearchLinksSpan(opts: {
  query: string;
  keywords: string | null;
  source: SearchLinksSource;
  elapsedMs: number;
  resultCount: number;
  cacheHit: boolean;
  gateDropped?: number;
}): void {
  let span: Span<SpanType.GENERIC> | null = null;
  const telemetry = {
    queryLen: opts.query.length,
    keywordsProvided: !!opts.keywords?.trim(),
    source: opts.source,
    elapsedMs: opts.elapsedMs,
    resultCount: opts.resultCount,
    zeroHit: opts.resultCount === 0,
    cacheHit: opts.cacheHit,
    ...(typeof opts.gateDropped === "number" ? { gateDropped: opts.gateDropped } : {}),
  };
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "webSearch.links",
      attributes: telemetry as never,
      metadata: {
        eventKind: "web_search_links",
        ...telemetry,
      },
      input: {
        queryLen: telemetry.queryLen,
        keywordsProvided: telemetry.keywordsProvided,
      },
    }) as Span<SpanType.GENERIC>;
  } catch {
    return;
  }

  try {
    span.end({
      attributes: {
        success: true,
        ...telemetry,
      } as never,
      metadata: {
        status: "done",
        ...telemetry,
      },
      output: {
        resultCount: opts.resultCount,
        zeroHit: telemetry.zeroHit,
        cacheHit: opts.cacheHit,
        source: opts.source,
      },
    });
  } catch {
    // 可观测写入失败不能影响搜索主链。
  }
}

async function searchLinks(
  query: string,
  keywords: string | null,
  limit: number,
  requestDeepseekKey: string,
  deepseekModel?: string,
  usageContext?: DeepseekSearchUsageContext,
): Promise<SearchResult[]> {
  const t0 = Date.now();
  const done = (results: SearchResult[], src: SearchLinksSource) => {
    const elapsedMs = Date.now() - t0;
    const msg = `[webSearch] "${query.slice(0, 24)}" ${elapsedMs}ms via ${src} ${results.length}条`;
    // 0 召回升级为 warn,便于生产里定位"搜了个常见词却空"的瞬时双重落空。
    // eslint-disable-next-line no-console
    if (results.length === 0) console.warn(`${msg} ⚠0召回`);
    // eslint-disable-next-line no-console
    else console.log(msg);
    recordSearchLinksSpan({
      query,
      keywords,
      source: src,
      elapsedMs,
      resultCount: results.length,
      cacheHit: src === "cache",
    });
    return results;
  };

  const primaryConfig = await getPrimarySearchConfig();
  // key 优先级:① 搜索专配 key(SETTING_SEARCH_PRIMARY.apiKey) ② 本请求 agent 正在用的 DeepSeek key
  //(requestDeepseekKey = resolveDeepseekAuth: visitor > global-db > env)。
  // 关键修复(0702 桌面验收):桌面端 key 是 **visitor 层**(x-deepseek-key header,服务端不落盘,
  // 见 visitorKeyStore),只读 DB 设置/env 一律取不到 → useDeepseek 恒为 false → **永远回退 Bing**。
  // 而 Bing 对中文实体/多词意图做浅层分词匹配(实测"特斯拉 Q4 财报"返回单字"特"的新华字典、
  // "2026世界杯 英格兰 刚果金"只匹配"2026"返回年份百科),质量极差;DeepSeek 官方 web_search 精准
  //(实测 2.3-3.9s 全相关)。改从 requestContext 取本请求 key 后,凡配了 DeepSeek 聊天 key 者
  // web_search 即自动走 DeepSeek。
  const deepseekKey = primaryConfig.apiKey || requestDeepseekKey || "";
  const effectiveUsageContext = usageContext
    ? { ...usageContext, keyOrigin: primaryConfig.apiKey ? "global-db" as const : usageContext.keyOrigin }
    : undefined;
  const useDeepseek = primaryConfig.enabled && !!deepseekKey;
  const cacheKey = buildSearchCacheKey(query, keywords, limit, useDeepseek, deepseekModel);
  const cached = getCachedSearch(cacheKey);
  if (cached) return done(cached, "cache");

  const doneAndCache = (results: SearchResult[], src: Exclude<SearchLinksSource, "cache">) => {
    if (results.length > 0) setCachedSearch(cacheKey, results);
    return done(results, src);
  };

  // 多源(Bing/DuckDuckGo + 已配置 API 源)始终并发起跑,作为兜底/补充。
  const effectiveKeywords = keywords?.trim() || query;
  const fastPromise: Promise<SearchResult[]> = getManagedSearchProvider()
    .then((provider) => provider.search(effectiveKeywords, limit))
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn(`[webSearch] 多源失败: ${String(e).slice(0, 80)}`);
      return [];
    });

  if (!useDeepseek) {
    return doneAndCache(await withTimeout(fastPromise, SEARCH_TIMEOUT_MS, []), "multisource(无DeepSeek)");
  }

  // DeepSeek 只取来源链接(流式读到搜索结果即掐断,不等综述,典型 ~2s),质量优先。
  const deepseekPromise = (
    deepseekModel && deepseekModel !== DEEPSEEK_MODEL_IDS.flash
      ? fetchDeepseekSearchLinks(query, deepseekKey, limit, deepseekModel, effectiveUsageContext)
      : fetchDeepseekSearchLinks(query, deepseekKey, limit, DEEPSEEK_MODEL_IDS.flash, effectiveUsageContext)
  ).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[webSearch] DeepSeek 链接失败: ${String(e).slice(0, 80)}`);
    return [] as SearchResult[];
  });

  // 质量优先:5s 内等 DeepSeek;有结果就用它。
  const startedAt = Date.now();
  const deepseekLinks = await withTimeout(deepseekPromise, SEARCH_TIMEOUT_MS, []);
  if (deepseekLinks.length > 0) return doneAndCache(deepseekLinks, "deepseek");

  // DeepSeek 超时/空 → 用并发已就绪的多源(在 5s 总预算的剩余时间内)。
  const remain = SEARCH_TIMEOUT_MS - (Date.now() - startedAt);
  return doneAndCache(await withTimeout(fastPromise, remain, []), "multisource(DS兜底)");
}

export async function searchLinksForEval(
  query: string,
  keywords: string | null,
  limit: number,
  requestDeepseekKey: string,
  deepseekModel?: string,
): Promise<SearchResult[]> {
  return searchLinks(query, keywords, limit, requestDeepseekKey, deepseekModel, {
    sessionId: "web-search-eval",
    runId: null,
    keyOrigin: "env",
  });
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 单条来源抓取硬超时(ms):一个慢/被代理 reset 的源不应拖死整次 webSearch。 */
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

/**
 * 给单源抓取套硬超时 + 吞掉"输掉 race 后晚到的 rejection"。
 * 后者是关键健壮性点:慢源的连接错误若在 worker 已往下走后才 reject,会变成
 * unhandledRejection 把整个后端进程崩掉(R1 实测:搜索重场景拖崩 8203)。给原 promise
 * 挂一个 no-op catch 即可让晚到的错误被吞、不冒泡成进程级未处理拒绝。
 */
function withSourceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function progressCounts(items: ResearchCardItem[]) {
  const okCount = items.filter((item) => item.status === "done").length;
  const skippedCount = items.filter((item) => item.status === "skipped").length;
  return {
    fetchedCount: okCount + skippedCount,
    okCount,
    skippedCount,
  };
}

export const webSearchTool = createTool({
  id: "webSearch",
  description:
    "联网检索并自动抓取每条来源正文(静态抓取,必要时自动浏览器降级),返回带正文的结果。" +
    "query 写完整问题,keywords 给 2-6 个关键词——两者都给,检索质量最好。" +
    "是否采用/重新检索/对某条重抓(用 fetchArticle)/存为素材(storeMaterial)由你判断。",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(MAX_QUERY_LEN)
      .describe("检索问题,可用自然语言完整表述(交给 DeepSeek 联网检索,它会自行改写检索词)"),
    keywords: z
      .string()
      .min(1)
      .max(80)
      .nullable()
      .optional()
      .describe("2-6 个空格分隔的检索关键词(给传统搜索引擎用,例:特斯拉 Q4 财报 2025)。请总是提供;整句放 query、关键词放这里"),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_COUNT)
      .default(DEFAULT_COUNT)
      .describe(`抓取的结果条数，默认 ${DEFAULT_COUNT}，最多 ${MAX_COUNT}`),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    query: z.string(),
    note: z.string().optional(),
    items: z.array(
      z.object({
        url: z.string(),
        title: z.string(),
        snippet: z.string(),
        status: z.enum(["done", "browser", "skipped"]),
        wordCount: z.number(),
        materialId: z.string(),
        truncated: z.boolean(),
        text: z.string().describe("来源正文节选；truncated=true 表示存在更长全文"),
      }),
    ),
  }),
  execute: async (input, context) => {
    const stopHeartbeat = startToolHeartbeat(context, { tool: "webSearch" });
    const query = input.query
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_QUERY_LEN);
    const keywords =
      input.keywords
        ?.replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80) || null;
    const limit = Math.min(input.count ?? DEFAULT_COUNT, MAX_COUNT);
    const writer = (context as { writer?: ToolWriter } | undefined)?.writer;

    const emitProgress = async (body: ResearchCardBody) => {
      try {
        await writer?.write({ type: "research-progress", progress: body });
      } catch {
        // 进度推送只是 UI/保活信号,失败不影响主链。
      }
    };

    const progressItems: ResearchCardItem[] = [];
    const emitSnapshot = async (phase: ResearchCardBody["phase"], total: number | null) => {
      const counts = progressCounts(progressItems);
      await emitProgress({
        query,
        phase,
        items: progressItems.map((item) => ({ ...item })),
        total,
        ...counts,
      });
    };

    try {
      await emitProgress({
        query,
        phase: "searching",
        items: [],
        total: null,
        fetchedCount: 0,
        okCount: 0,
        skippedCount: 0,
      });

      if (!query) {
        await emitProgress({
          query,
          phase: "done",
          items: [],
          total: 0,
          fetchedCount: 0,
          okCount: 0,
          skippedCount: 0,
        });
        return { ok: true, query, items: [], note: ZERO_HIT_NOTE };
      }

      // 本请求 agent 用的 DeepSeek key(桌面端=visitor 层 header,只能从 requestContext 取)。
      const requestAuth = resolveDeepseekAuth(context?.requestContext);
      const requestDeepseekKey = requestAuth.apiKey;
      const deepseekModel = resolveModelId(context?.requestContext, "flash");
      const results = (await searchLinks(
        query,
        keywords,
        limit,
        requestDeepseekKey,
        deepseekModel,
        {
          sessionId: (context?.requestContext?.get("sessionId") as string | undefined) ?? "unknown",
          runId: (context?.requestContext?.get("runId") as string | null | undefined) ?? null,
          keyOrigin: requestAuth.origin,
          requestContext: context?.requestContext,
        },
      )).slice(0, limit);
      progressItems.push(
        ...results.map((result) => ({
          url: result.url,
          title: result.title,
          status: "pending" as const,
          wordCount: null,
        })),
      );
      await emitSnapshot("fetching", results.length);

      const fetchOne = async (result: SearchResult, index: number): Promise<WebSearchItemInternal> => {
        progressItems[index] = { ...progressItems[index]!, status: "fetching", wordCount: null };
        await emitSnapshot("fetching", results.length);

        let best: ArticleFetchResult = {
          title: result.title,
          text: "",
          wordCount: 0,
          via: "static",
        };

        try {
          const article = (await withSourceTimeout(
            fetchArticleTool.execute!({ url: result.url }, context) as Promise<ArticleFetchResult>,
            SOURCE_FETCH_TIMEOUT_MS,
            "fetchArticle",
          )) as ArticleFetchResult;
          best = article;
          if (article.via === "browser") {
            progressItems[index] = { ...progressItems[index]!, status: "browser", wordCount: null };
            await emitSnapshot("fetching", results.length);
          }
        } catch {
          // 单条来源失败不应拖垮整次 webSearch。
        }

        const substantive = isSubstantiveContent(best.text);
        const progressStatus = substantive ? "done" : "skipped";
        const progressWordCount = substantive ? (best.wordCount ?? 0) : null;
        const materialId =
          best.materialId ?? "mat-" + createHash("sha256").update(result.url).digest("hex").slice(0, 12);
        const fullText = substantive ? (best.text ?? "") : "";
        const excerpt = fullText.slice(0, WEBSEARCH_EXCERPT_CHARS);
        const truncated = fullText.length > WEBSEARCH_EXCERPT_CHARS;
        progressItems[index] = {
          ...progressItems[index]!,
          title: typeof best.title === "string" && best.title.trim() ? best.title : result.title,
          status: progressStatus,
          wordCount: progressWordCount,
        };
        await emitSnapshot("fetching", results.length);

        return {
          url: result.url,
          title: typeof best.title === "string" && best.title.trim() ? best.title : result.title,
          snippet: result.snippet,
          status: substantive ? (best.via === "browser" ? "browser" : "done") : "skipped",
          wordCount: progressWordCount ?? 0,
          materialId,
          truncated,
          text: excerpt,
          __fullText: fullText,
        };
      };

      const items = await mapWithConcurrency(results, FETCH_CONCURRENCY, fetchOne);
      await emitSnapshot("done", results.length);
      const fullTexts = items
        .filter((item) => item.__fullText && isSubstantiveContent(item.__fullText))
        .map((item) => ({
          url: item.url,
          title: item.title,
          materialId: item.materialId,
          text: item.__fullText,
        }));
      if (fullTexts.length > 0) {
        try {
          await writer?.write({ type: "research-fulltext", items: fullTexts });
        } catch {
          // 全文旁路只服务 bridge 落库,失败不影响模型侧搜索结果。
        }
      }
      const modelItems: WebSearchItem[] = items.map(({ __fullText: _fullText, ...item }) => item);
      return {
        ok: true,
        query,
        items: modelItems,
        ...(modelItems.length === 0 ? { note: ZERO_HIT_NOTE } : {}),
      };
    } finally {
      stopHeartbeat();
    }
  },
});
