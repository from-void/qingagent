import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getDocumentsClient, runMigrations } from "@qingagent/db";
import { MIGRATIONS } from "@qingagent/db/migrations/registry";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import { dataAdminRoutes } from "../routes/dataAdmin";
import { usageRoutes } from "../routes/usage";

let tempDb: TempDocumentsDb | null = null;
let originalDebug: string | undefined;

beforeEach(() => {
  originalDebug = process.env.QINGAGENT_ENABLE_DEBUG;
  process.env.QINGAGENT_ENABLE_DEBUG = "1";
  tempDb = prepareTempDocumentsDb("qingagent-usage-0043-server-");
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
  if (originalDebug === undefined) delete process.env.QINGAGENT_ENABLE_DEBUG;
  else process.env.QINGAGENT_ENABLE_DEBUG = originalDebug;
});

describe("0039 满库升级 0043", () => {
  it("删快照列后 summary/CSV 都按内置 schedule 重算且 revision 一致", async () => {
    await runMigrations(MIGRATIONS.slice(0, 42));
    const client = getDocumentsClient();
    await client.execute({
      sql: `INSERT INTO llm_usage_events (
          id, session_id, run_id, call_site, model_id, key_origin,
          input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
          cache_creation_tokens, cache_accounting_state, usage_state,
          cost_cny, pricing_tier, pricing_multiplier, created_at
        ) VALUES (
          'upgrade-row', 'upgrade-session', 'upgrade-run', 'agent',
          'deepseek-v4-flash', 'env', 100, 20, 20, 80,
          999999, 'known', 'recorded', 999, 'peak', 9,
          '2026-08-08T00:00:00.000Z'
        )`,
    });

    await runMigrations();
    const columns = (await client.execute("PRAGMA table_info(llm_usage_events)"))
      .rows.map((row) => String(row.name));
    expect(columns).not.toEqual(expect.arrayContaining([
      "cost_cny",
      "pricing_tier",
      "pricing_multiplier",
    ]));
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM llm_usage_events",
    )).rows[0]?.n)).toBe(1);

    const app = new Hono();
    app.route("/api/v1", usageRoutes);
    app.route("/api/v1", dataAdminRoutes);
    const summaryResponse = await app.request("/api/v1/usage/summary?view=total");
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json() as {
      scheduleRevision: string;
      rows: Array<{ costCny?: number; pricedCalls: number }>;
    };
    expect(summary.rows).toEqual([expect.objectContaining({
      costCny: 0.0001204,
      pricedCalls: 1,
    })]);

    const csvResponse = await app.request("/api/v1/data/usage/export");
    expect(csvResponse.status).toBe(200);
    const csv = await csvResponse.text();
    expect(csv.split("\n")[0]).toBe(`# schedule_revision=${summary.scheduleRevision}`);
    expect(summary.scheduleRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(csv).toMatch(/,"0\.0001204","standard","1"$/m);
    expect(csv).not.toContain(",\"999\",\"peak\",\"9\"");
  });
});
