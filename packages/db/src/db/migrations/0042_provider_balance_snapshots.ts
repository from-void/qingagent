import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  await client.execute(
    `CREATE TABLE provider_balance_snapshots (
      ts                     TEXT NOT NULL,
      provider               TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL,
      balance_cny            REAL NOT NULL
    )`,
  );
  await client.execute(
    `CREATE INDEX idx_provider_balance_snapshots_account_ts
      ON provider_balance_snapshots(provider, credential_fingerprint, ts DESC)`,
  );
}

export const migration0042ProviderBalanceSnapshots: Migration = {
  id: 42,
  name: "provider_balance_snapshots",
  up,
};
