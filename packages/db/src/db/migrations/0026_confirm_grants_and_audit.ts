import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE confirm_grants (
      kind        TEXT PRIMARY KEY CHECK(kind IN ('install','command')),
      grant_id    TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      source      TEXT NOT NULL CHECK(source IN ('card','settings'))
    )`,
    `CREATE TABLE confirm_audit_events (
      event_id         TEXT PRIMARY KEY,
      ts               TEXT NOT NULL,
      event_type       TEXT NOT NULL CHECK(event_type IN (
        'decision_started','decision_finished','decision_failed',
        'decision_expired','remember_rejected'
      )),
      subject_id       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      tool_call_id     TEXT NOT NULL,
      confirm_id       TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK(kind IN ('install','connect','send','command')),
      command_digest   TEXT NOT NULL,
      command_preview  TEXT NOT NULL,
      decision         TEXT NOT NULL CHECK(decision IN ('accepted','rejected','expired','failed')),
      source           TEXT NOT NULL CHECK(source IN ('ui','stored-grant','expired')),
      grant_id         TEXT,
      result           TEXT NOT NULL,
      policy_version   TEXT NOT NULL,
      isolation_epoch  TEXT,
      config_hash      TEXT
    )`,
    `CREATE INDEX idx_confirm_audit_session_ts
      ON confirm_audit_events(session_id, ts, event_id)`,
    `CREATE INDEX idx_confirm_audit_grant
      ON confirm_audit_events(grant_id, ts)`,
    `CREATE TABLE confirm_grant_events (
      event_id    TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      grant_id    TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK(kind IN ('install','command')),
      action      TEXT NOT NULL CHECK(action IN ('created','revoked')),
      source      TEXT NOT NULL CHECK(source IN ('card','settings')),
      subject_id  TEXT NOT NULL
    )`,
    `CREATE INDEX idx_confirm_grant_events_grant
      ON confirm_grant_events(grant_id, ts, event_id)`,
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0026ConfirmGrantsAndAudit: Migration = {
  id: 26,
  name: "confirm_grants_and_audit",
  up,
};
