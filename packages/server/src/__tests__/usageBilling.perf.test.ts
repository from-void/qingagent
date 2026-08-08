import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  getDocumentsClient,
  runMigrations,
  type Client,
} from "@qingagent/db";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "@qingagent/db/testing";
import { dataAdminRoutes } from "../routes/dataAdmin";
import { usageRoutes } from "../routes/usage";

const FIXTURE_ROWS = 100_000;
const WARMUP_RUNS = 3;
const MEASURED_RUNS = 10;

let tempDb: TempDocumentsDb | null = null;
let originalDebug: string | undefined;
let originalDeepseekKey: string | undefined;

function statementSql(statement: unknown): string {
  if (typeof statement === "string") return statement;
  return String((statement as { sql?: unknown } | null)?.sql ?? "");
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

async function insertFixture(client: Client): Promise<void> {
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  await client.execute({
    sql: `WITH digits(v) AS (
        VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
      ), fixture(x) AS (
        SELECT a.v + 10*b.v + 100*c.v + 1000*d.v + 10000*e.v
        FROM digits a CROSS JOIN digits b CROSS JOIN digits c
        CROSS JOIN digits d CROSS JOIN digits e
      )
      INSERT INTO llm_usage_events (
        id, session_id, run_id, call_site, model_id, key_origin,
        input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
        created_at, usage_state, reason, lane, attempt,
        cache_creation_tokens, cache_accounting_state
      )
      SELECT
        printf('perf-%06d', x),
        printf('session-%03d', x % 200),
        printf('run-%06d', x),
        CASE WHEN x % 2 = 0 THEN 'agent' ELSE 'writeDraft' END,
        CASE x % 4
          WHEN 0 THEN 'deepseek-v4-flash'
          WHEN 1 THEN 'deepseek-v4-pro'
          WHEN 2 THEN 'kimi-for-coding'
          ELSE 'k3'
        END,
        'env',
        CASE WHEN x % 20 < 18 THEN 100 ELSE 0 END,
        CASE WHEN x % 20 < 18 THEN 20 ELSE 0 END,
        CASE WHEN x % 20 < 18 THEN 40 ELSE 0 END,
        CASE WHEN x % 20 < 18 THEN 60 ELSE 0 END,
        strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          ?,
          printf('-%d days', x % 90),
          CASE WHEN x % 2 = 0 THEN '+15 hours' ELSE '+4 hours' END
        ),
        CASE
          WHEN x % 20 < 17 THEN 'recorded'
          WHEN x % 20 = 17 THEN 'estimated'
          WHEN x % 20 = 18 THEN 'missing'
          ELSE 'billing_unknown'
        END,
        CASE
          WHEN x % 20 = 17 THEN 'aborted'
          WHEN x % 20 = 18 THEN 'no_usage'
          WHEN x % 20 = 19 THEN 'no_response'
          ELSE NULL
        END,
        x % 2,
        1,
        0,
        CASE WHEN x % 3 = 0 THEN 'unknown' ELSE 'known' END
      FROM fixture`,
    args: [today],
  });
}

describe("usage 计费架构定向性能门槛", () => {
  beforeAll(async () => {
    originalDebug = process.env.QINGAGENT_ENABLE_DEBUG;
    originalDeepseekKey = process.env.DEEPSEEK_API_KEY;
    process.env.QINGAGENT_ENABLE_DEBUG = "1";
    delete process.env.DEEPSEEK_API_KEY;
    tempDb = prepareTempDocumentsDb("qingagent-billing-perf-");
    await runMigrations();
    const client = getDocumentsClient();
    await insertFixture(client);
    const count = await client.execute("SELECT COUNT(*) AS n FROM llm_usage_events");
    expect(Number(count.rows[0]?.n)).toBe(FIXTURE_ROWS);
  });

  afterAll(() => {
    tempDb?.cleanup();
    tempDb = null;
    if (originalDebug === undefined) delete process.env.QINGAGENT_ENABLE_DEBUG;
    else process.env.QINGAGENT_ENABLE_DEBUG = originalDebug;
    if (originalDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepseekKey;
  });

  it("10 万行下各视图与 CSV 满足 SQL 次数和整 HTTP p95", async () => {
    const client = getDocumentsClient();
    const executeSpy = vi.spyOn(client, "execute");
    const app = new Hono();
    app.route("/api/v1", usageRoutes);
    app.route("/api/v1", dataAdminRoutes);

    const measure = async (path: string): Promise<number> => {
      const callStart = executeSpy.mock.calls.length;
      const startedAt = performance.now();
      const response = await app.request(path);
      const elapsed = performance.now() - startedAt;
      expect(response.status).toBe(200);
      const usageQueryCount = executeSpy.mock.calls
        .slice(callStart)
        .filter(([statement]) => statementSql(statement).includes("llm_usage_events"))
        .length;
      expect(usageQueryCount).toBe(1);
      return elapsed;
    };

    const benchmark = async (path: string): Promise<number> => {
      for (let index = 0; index < WARMUP_RUNS; index += 1) await measure(path);
      const samples: number[] = [];
      for (let index = 0; index < MEASURED_RUNS; index += 1) {
        samples.push(await measure(path));
      }
      return p95(samples);
    };

    const sessionP95 = await benchmark("/api/v1/usage/summary?view=session");
    const totalP95 = await benchmark("/api/v1/usage/summary?view=total");
    const dayP95 = await benchmark("/api/v1/usage/summary?view=day&timeZone=Asia%2FShanghai");
    const csvP95 = await benchmark("/api/v1/data/usage/export");

    console.info(
      `[billing-perf] session=${sessionP95.toFixed(1)}ms total=${totalP95.toFixed(1)}ms ` +
        `day30=${dayP95.toFixed(1)}ms csv=${csvP95.toFixed(1)}ms`,
    );
    expect(sessionP95).toBeLessThanOrEqual(300);
    expect(totalP95).toBeLessThanOrEqual(300);
    expect(dayP95).toBeLessThanOrEqual(500);
    expect(csvP95).toBeLessThanOrEqual(3_000);
  });
});
