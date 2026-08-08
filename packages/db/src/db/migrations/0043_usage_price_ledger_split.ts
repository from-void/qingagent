import type { Client } from "@libsql/client";
import { canonicalizeUsageTimestamp, isCanonicalUsageTimestamp } from "../usageTimestamp.js";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  const rows = await client.execute("SELECT id, created_at FROM llm_usage_events");
  const invalidIds: string[] = [];
  let normalized = 0;

  for (const raw of rows.rows) {
    const id = String(raw.id ?? "");
    const createdAt = String(raw.created_at ?? "");
    if (isCanonicalUsageTimestamp(createdAt)) continue;
    const canonical = canonicalizeUsageTimestamp(createdAt);
    if (canonical === null) {
      invalidIds.push(id);
      continue;
    }
    await client.execute({
      sql: "UPDATE llm_usage_events SET created_at = ? WHERE id = ?",
      args: [canonical, id],
    });
    normalized += 1;
  }

  if (normalized > 0) {
    console.warn(`[usage] 0043 已规范化 ${normalized} 条非 canonical created_at`);
  }
  if (invalidIds.length > 0) {
    console.warn("[usage] 0043 发现无法解析的 created_at，保留原值并在读端按未计价处理", {
      count: invalidIds.length,
      sampleIds: invalidIds.slice(0, 10),
    });
  }

  await client.execute("ALTER TABLE llm_usage_events DROP COLUMN cost_cny");
  await client.execute("ALTER TABLE llm_usage_events DROP COLUMN pricing_tier");
  await client.execute("ALTER TABLE llm_usage_events DROP COLUMN pricing_multiplier");
}

export const migration0043UsagePriceLedgerSplit: Migration = {
  id: 43,
  name: "usage_price_ledger_split",
  up,
};
