import { Hono } from "hono";
import {
  aggregateUsageByDay,
  aggregateUsageBySession,
  aggregateUsageTotal,
  estimateCostCny,
  getSessionDocumentStatsSince,
  getSessionThreadTitles,
  hasModelPricing,
} from "@qingagent/core";
import type { UsageSummaryResponse } from "@qingagent/contract-ts";

export const usageRoutes = new Hono();

type UsageView = "day" | "session" | "total";

usageRoutes.get("/usage/summary", async (c) => {
  const view = (c.req.query("view") ?? "day") as UsageView;
  if (view !== "day" && view !== "session" && view !== "total") {
    return c.json({ error: "view must be day, session, or total" }, 400);
  }
  const timeZone = c.req.query("timeZone") ?? "UTC";
  try {
    if (!timeZone || timeZone.length > 128 || timeZone.trim() !== timeZone) throw new Error();
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    return c.json({ error: "timeZone must be a valid IANA time zone" }, 400);
  }

  const rows =
    view === "day"
      ? await aggregateUsageByDay(30, timeZone)
      : view === "session"
        ? await aggregateUsageBySession()
        : await aggregateUsageTotal();

  // 会话视图沿用 bucket→标题；按天视图在 documents.title 为空时兼容旧线程 metadata 标题。
  let titleMap: Map<string, string> | null = null;
  if (view === "session" || view === "day") {
    const titleSessionIds = rows.flatMap((row) => {
      if (view === "day" && row.documentTitle) return [];
      return [row.sessionId ?? row.bucket];
    });
    titleMap = await getSessionThreadTitles(titleSessionIds);
  }

  const response = {
    view,
    rows: rows.map((row) => {
      const { sessionId, ...publicRow } = row;
      const fallbackTitle = titleMap?.get(sessionId ?? row.bucket) || undefined;
      return {
        ...publicRow,
        ...(view === "session" ? { label: fallbackTitle } : {}),
        ...(view === "day"
          ? { documentTitle: row.documentTitle || fallbackTitle }
          : {}),
        ...(hasModelPricing(row.modelId)
          ? {
              costCny: estimateCostCny(row.modelId, {
                input: row.inputTokens,
                output: row.outputTokens,
                cacheHit: row.cacheHitTokens,
                cacheMiss: row.cacheMissTokens,
              }),
              ...((row.estimatedCalls ?? 0) > 0
                ? {
                    estimatedCostCny: estimateCostCny(row.modelId, {
                      input: row.estimatedInputTokens,
                      output: row.estimatedOutputTokens,
                      cacheHit: row.estimatedCacheHitTokens,
                      cacheMiss: row.estimatedCacheMissTokens,
                    }),
                  }
                : {}),
            }
          : {}),
      };
    }),
  } satisfies UsageSummaryResponse;
  return c.json(response);
});

// 近 N 天创建的文档数 + 总字数(用于模型看板的"每篇成本/还能建几篇"指标)
usageRoutes.get("/usage/docstats", async (c) => {
  const days = Math.max(1, Math.min(90, Math.round(Number(c.req.query("days") ?? 7)) || 7));
  const cutoff = Date.now() - days * 86_400_000;
  const { docs, words } = await getSessionDocumentStatsSince(cutoff);
  return c.json({ days, docs, words });
});
