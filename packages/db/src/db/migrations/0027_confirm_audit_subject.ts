import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `ALTER TABLE confirm_audit_events
      ADD COLUMN subject_id TEXT NOT NULL DEFAULT 'local-user'`,
  );
  await client.execute(
    `ALTER TABLE confirm_grant_events
      ADD COLUMN subject_id TEXT NOT NULL DEFAULT 'local-user'`,
  );
}

export const migration0027ConfirmAuditSubject: Migration = {
  id: 27,
  name: "confirm_audit_subject",
  up,
};
