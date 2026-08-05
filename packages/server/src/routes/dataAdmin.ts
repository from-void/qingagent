// 设置·数据管理:存储统计 / usage 账本导出(CSV) / 账本清空。
// 会话删除复用既有 DELETE /sessions/:id(home.ts)。

import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getDocumentsClient, listSessionThreads } from "@qingagent/core";
import { resolveDbUrl } from "@qingagent/db";
import { isDebugEndpointEnabled } from "../lib/debugGate";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

export const dataAdminRoutes = new Hono();

function isDataAdminRoutePath(path: string): boolean {
  // 前缀精确匹配(挂载于 /api/v1 或裸挂两种形态),不能用 includes——
  // 否则 /api/v1/skills/data/enable 这类"参数恰为 data"的兄弟路由会被误拦。
  return (
    path === "/data" ||
    path.startsWith("/data/") ||
    path === "/api/v1/data" ||
    path.startsWith("/api/v1/data/")
  );
}

dataAdminRoutes.use("*", async (c, next) => {
  // Hono 子 app 挂到 /api/v1 时,use("*") 也会看到后续兄弟路由;只拦 dataAdmin 段。
  if (!isDataAdminRoutePath(c.req.path)) return next();
  // 默认 404(不用 403:不向探测者确认路由存在)。开放条件见 debugGate。
  if (!isDebugEndpointEnabled()) return c.json({ error: "not found" }, 404);
  return next();
});

const CLEAR_USAGE_CONFIRM_HEADER = "x-qingagent-confirm";
const CLEAR_USAGE_CONFIRM_VALUE = "clear-usage-ledger";

function resolveLocalDatabasePath(dbUrl: string): string | null {
  if (!dbUrl.startsWith("file:")) return null;
  if (dbUrl.startsWith("file://")) {
    try {
      return fileURLToPath(dbUrl);
    } catch {
      return null;
    }
  }
  const rawPath = dbUrl.slice("file:".length).split(/[?#]/, 1)[0];
  return rawPath ? decodeURIComponent(rawPath) : null;
}

function isMissingUsageTableError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no such table:\s*llm_usage_events/i.test(text);
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

dataAdminRoutes.get("/data/stats", async (c) => {
  try {
    const client = getDocumentsClient();
    const [docs, usage, versions] = await Promise.all([
      client.execute("SELECT COUNT(*) n FROM documents"),
      client.execute("SELECT COUNT(*) n, MIN(created_at) oldest FROM llm_usage_events").catch(() => null),
      client.execute("SELECT COUNT(*) n FROM document_versions").catch(() => null),
    ]);
    const dbUrl = resolveDbUrl();
    let dbSizeBytes: number | null = null;
    const dbPath = resolveLocalDatabasePath(dbUrl);
    if (dbPath) {
      dbSizeBytes = await stat(dbPath).then((s) => s.size).catch(() => null);
    }
    const num = (r: { rows: unknown[] } | null, key = "n") =>
      r ? Number((r.rows[0] as Record<string, unknown>)?.[key] ?? 0) : 0;
    return c.json({
      documents: num(docs),
      documentVersions: num(versions),
      usageEvents: num(usage),
      usageOldest: usage ? ((usage.rows[0] as Record<string, unknown>)?.oldest ?? null) : null,
      dbSizeBytes,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "stats failed" }, 500);
  }
});

dataAdminRoutes.get("/data/sessions", async (c) => {
  // 数据管理里的会话清单(轻量:id/标题/更新时间),删除走既有 DELETE /sessions/:id
  const { threads } = await listSessionThreads({ page: 0, perPage: 200 });
  return c.json({
    sessions: threads.map((t) => ({
      id: t.id,
      title: t.title || "无题",
      updatedAt: (t.updatedAt ?? t.createdAt)?.toISOString?.() ?? null,
    })),
  });
});

dataAdminRoutes.get("/data/usage/export", async (c) => {
  const client = getDocumentsClient();
  let result: Awaited<ReturnType<typeof client.execute>> | null = null;
  try {
    result = await client.execute("SELECT created_at, session_id, run_id, call_site, model_id, key_origin, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, cache_creation_tokens, cache_accounting_state, usage_state, reason, lane, attempt, cost_cny, pricing_tier, pricing_multiplier FROM llm_usage_events ORDER BY created_at");
  } catch (err) {
    if (!isMissingUsageTableError(err)) throw err;
  }
  const header = "created_at,session_id,run_id,call_site,model_id,key_origin,input_tokens,output_tokens,cache_hit_tokens,cache_miss_tokens,cache_creation_tokens,cache_accounting_state,usage_state,reason,lane,attempt,cost_cny,pricing_tier,pricing_multiplier";
  const lines = (result?.rows ?? []).map((r) => {
    const row = r as unknown as Record<string, unknown>;
    // CSV 注入防护:统一包引号、转义内部引号,并中和电子表格公式前缀。
    return [
      row.created_at, row.session_id, row.run_id, row.call_site, row.model_id, row.key_origin,
      row.input_tokens, row.output_tokens, row.cache_hit_tokens, row.cache_miss_tokens,
      row.cache_creation_tokens, row.cache_accounting_state, row.usage_state, row.reason, row.lane, row.attempt,
      row.cost_cny, row.pricing_tier, row.pricing_multiplier,
    ].map(csvCell).join(",");
  });
  return c.body([header, ...lines].join("\n"), 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="qingagent-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
});

dataAdminRoutes.delete("/data/usage", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  if (c.req.header(CLEAR_USAGE_CONFIRM_HEADER) !== CLEAR_USAGE_CONFIRM_VALUE) {
    return c.json({ error: "Missing clear usage confirmation" }, 400);
  }
  const client = getDocumentsClient();
  let result: Awaited<ReturnType<typeof client.execute>> | null = null;
  try {
    result = await client.execute("DELETE FROM llm_usage_events");
  } catch (err) {
    if (!isMissingUsageTableError(err)) throw err;
  }
  return c.json({ deleted: result?.rowsAffected ?? 0 });
});
