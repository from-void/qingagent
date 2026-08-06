import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  // 旧行保持 NULL：它们只能按旧基础价兼容展示，绝不能因新峰谷配置被追溯加价。
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN cost_cny REAL");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN pricing_tier TEXT");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN pricing_multiplier REAL");
}

export const migration0039UsagePricingSnapshot: Migration = {
  id: 39,
  name: "usage_pricing_snapshot",
  up,
};
