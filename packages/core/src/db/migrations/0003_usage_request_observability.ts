import type { Client } from "@libsql/client";
import type { Migration } from "../migrations.js";

async function up(client: Client): Promise<void> {
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN usage_state TEXT NOT NULL DEFAULT 'recorded'");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN reason TEXT");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN lane INTEGER");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN attempt INTEGER");
  await client.execute("ALTER TABLE llm_usage_events ADD COLUMN cache_creation_tokens INTEGER");
}

export const migration0003UsageRequestObservability: Migration = {
  id: 3,
  name: "usage_request_observability",
  up,
};
