import type { Client } from "@libsql/client";
import type { Migration } from "../migrations.js";

async function up(client: Client): Promise<void> {
  // 旧账本的 0 miss 无法区分“真实 0”与“provider 未返回”，保守标 unknown，避免假 100%。
  await client.execute(
    "ALTER TABLE llm_usage_events ADD COLUMN cache_accounting_state TEXT NOT NULL DEFAULT 'unknown'",
  );
}

export const migration0004UsageCacheAccountingState: Migration = {
  id: 4,
  name: "usage_cache_accounting_state",
  up,
};
