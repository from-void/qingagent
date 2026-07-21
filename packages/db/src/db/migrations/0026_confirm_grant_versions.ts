import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `CREATE TABLE confirm_grant_states (
      kind                TEXT PRIMARY KEY CHECK(kind IN ('install','command')),
      version             INTEGER NOT NULL CHECK(version >= 0),
      revocation_epoch    INTEGER NOT NULL CHECK(revocation_epoch >= 0)
    )`,
  );
  await client.execute(
    `INSERT INTO confirm_grant_states (kind, version, revocation_epoch)
      VALUES ('install', 0, 0), ('command', 0, 0)`,
  );
  await client.execute(
    `UPDATE confirm_grant_states
      SET version = 1
      WHERE EXISTS (
        SELECT 1 FROM confirm_grants WHERE confirm_grants.kind = confirm_grant_states.kind
      )`,
  );
}

export const migration0026ConfirmGrantVersions: Migration = {
  id: 26,
  name: "confirm_grant_versions",
  up,
};
