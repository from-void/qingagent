import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `CREATE TABLE confirm_audit_events_v0029 (
      event_id         TEXT PRIMARY KEY,
      ts               TEXT NOT NULL,
      event_type       TEXT NOT NULL CHECK(event_type IN (
        'decision_started','decision_finished','decision_failed',
        'decision_expired','remember_rejected','grant_created','grant_revoked'
      )),
      session_id       TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      tool_call_id     TEXT NOT NULL,
      confirm_id       TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK(kind IN ('install','connect','send','command')),
      command_digest   TEXT NOT NULL,
      command_preview  TEXT NOT NULL,
      decision         TEXT NOT NULL CHECK(decision IN ('accepted','rejected','expired','failed')),
      source           TEXT NOT NULL CHECK(source IN ('ui','stored-grant','expired','settings')),
      grant_id         TEXT,
      result           TEXT NOT NULL,
      policy_version   TEXT NOT NULL,
      isolation_epoch  TEXT,
      config_hash      TEXT,
      subject_id       TEXT NOT NULL DEFAULT 'local-user'
    )`,
  );
  await client.execute(
    `INSERT INTO confirm_audit_events_v0029 (
      event_id, ts, event_type, session_id, run_id, tool_call_id, confirm_id,
      kind, command_digest, command_preview, decision, source, grant_id,
      result, policy_version, isolation_epoch, config_hash, subject_id
    )
    SELECT
      event_id, ts, event_type, session_id, run_id, tool_call_id, confirm_id,
      kind, command_digest, command_preview, decision, source, grant_id,
      result, policy_version, isolation_epoch, config_hash, subject_id
    FROM confirm_audit_events`,
  );
  await client.execute(`DROP TABLE confirm_audit_events`);
  await client.execute(`ALTER TABLE confirm_audit_events_v0029 RENAME TO confirm_audit_events`);
  await client.execute(
    `CREATE INDEX idx_confirm_audit_session_ts
      ON confirm_audit_events(session_id, ts, event_id)`,
  );
  await client.execute(
    `CREATE INDEX idx_confirm_audit_grant
      ON confirm_audit_events(grant_id, ts)`,
  );
}

export const migration0029ConfirmSettingsAudit: Migration = {
  id: 29,
  name: "confirm_settings_audit",
  up,
};
