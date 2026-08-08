import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { isCanonicalUsageTimestamp } from "../usageTimestamp.js";

let tempDb: TempDocumentsDb | null = null;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-migration-0043-");
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
  vi.restoreAllMocks();
});

describe("migration 0043", () => {
  it("审计规范化可解析时间、保留不可解析时间，再删除三列且不丢行", async () => {
    await runMigrations(MIGRATIONS.slice(0, 42));
    const client = getDocumentsClient();
    const rows = [
      ["canonical", "2026-08-08T00:00:00.000Z"],
      ["short-iso", "2026-08-08T00:00:00Z"],
      ["feb-30", "2026-02-30T00:00:00.000Z"],
      ["t24", "2026-08-08T24:00:00.000Z"],
      ["invalid", "9999-99-99T99:99:99.999Z"],
    ] as const;
    for (const [id, createdAt] of rows) {
      await client.execute({
        sql: `INSERT INTO llm_usage_events
          (id, session_id, call_site, model_id, key_origin, input_tokens, output_tokens,
           cache_hit_tokens, cache_miss_tokens, cache_accounting_state, usage_state,
           cost_cny, pricing_tier, pricing_multiplier, created_at)
          VALUES (?, ?, 'agent', 'model-a', 'visitor', 10, 1, 0, 10, 'known', 'recorded',
            999, 'peak', 9, ?)`,
        args: [id, id, createdAt],
      });
    }
    expect(isCanonicalUsageTimestamp("2026-08-08T24:00:00.000Z")).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runMigrations(MIGRATIONS.slice(0, 43));
    expect(result.appliedIds).toEqual([43]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("无法解析"),
      expect.objectContaining({ count: 1 }),
    );
    const migrated = await client.execute(
      "SELECT id, created_at FROM llm_usage_events ORDER BY id",
    );
    expect(migrated.rows).toEqual([
      expect.objectContaining({ id: "canonical", created_at: "2026-08-08T00:00:00.000Z" }),
      expect.objectContaining({ id: "feb-30", created_at: "2026-03-02T00:00:00.000Z" }),
      expect.objectContaining({ id: "invalid", created_at: "9999-99-99T99:99:99.999Z" }),
      expect.objectContaining({ id: "short-iso", created_at: "2026-08-08T00:00:00.000Z" }),
      expect.objectContaining({ id: "t24", created_at: "2026-08-09T00:00:00.000Z" }),
    ]);
    const columns = (await client.execute("PRAGMA table_info(llm_usage_events)"))
      .rows.map((row) => String(row.name));
    expect(columns).not.toEqual(expect.arrayContaining([
      "cost_cny",
      "pricing_tier",
      "pricing_multiplier",
    ]));
    expect(migrated.rows).toHaveLength(rows.length);
  });
});
