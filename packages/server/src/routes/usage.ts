import { Hono } from "hono";
import {
  aggregateUsageByDay,
  aggregateUsageBySession,
  aggregateUsageTotal,
  estimateCostCny,
  hasDeepseekPricing,
  listSessionThreads,
} from "@qingagent/core";
import type { QingagentThreadMetadata } from "@qingagent/core";
import type { UsageSummaryResponse } from "@qingagent/contract-ts";
import { countDocVisibleChars, legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";

export const usageRoutes = new Hono();

type UsageView = "day" | "session" | "total";

usageRoutes.get("/usage/summary", async (c) => {
  const view = (c.req.query("view") ?? "day") as UsageView;
  if (view !== "day" && view !== "session" && view !== "total") {
    return c.json({ error: "view must be day, session, or total" }, 400);
  }

  const rows =
    view === "day"
      ? await aggregateUsageByDay()
      : view === "session"
        ? await aggregateUsageBySession()
        : await aggregateUsageTotal();

  // 会话视图沿用 bucket→标题；按天视图在 documents.title 为空时兼容旧线程 metadata 标题。
  let titleMap: Map<string, string> | null = null;
  if (view === "session" || view === "day") {
    const { threads } = await listSessionThreads({ page: 0, perPage: 200 });
    titleMap = new Map(
      threads.map((t) => {
        const meta = (t.metadata ?? {}) as unknown as QingagentThreadMetadata;
        return [t.id, meta.title || t.title || ""];
      }),
    );
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
        ...(hasDeepseekPricing(row.modelId)
          ? {
              costCny: estimateCostCny(row.modelId, {
                input: row.inputTokens,
                output: row.outputTokens,
                cacheHit: row.cacheHitTokens,
                cacheMiss: row.cacheMissTokens,
              }),
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
  const { threads } = await listSessionThreads({ page: 0, perPage: 200 });
  let docs = 0;
  let words = 0;
  for (const t of threads) {
    if (t.createdAt.getTime() < cutoff) continue;
    docs += 1;
    const doc = resolveThreadDoc((t.metadata ?? {}) as unknown as QingagentThreadMetadata);
    if (doc) words += countDocVisibleChars(doc);
  }
  return c.json({ days, docs, words });
});

function resolveThreadDoc(meta: QingagentThreadMetadata): PmDoc | null {
  if (meta.doc) return meta.doc;
  if (!meta.legacySections || meta.legacySections.length === 0) return null;
  try {
    return legacySectionsToPm(meta.legacySections as never);
  } catch {
    return null;
  }
}
