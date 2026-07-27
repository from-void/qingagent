import type { Migration } from "./types.js";

// 「向外发送内容」「连接账号」两类原本被 CHECK 约束锁死为每次询问,
// 用户拍板:这两类与安装/同类操作同等,也允许记住"始终允许"。
// SQLite 改不了 CHECK,只能重建表再迁数据;同时给两类补上初始状态行。
async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE confirm_grants_new (
      kind        TEXT PRIMARY KEY CHECK(kind IN ('install','command','send','connect')),
      grant_id    TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      source      TEXT NOT NULL CHECK(source IN ('card','settings'))
    )`,
    `INSERT INTO confirm_grants_new (kind, grant_id, created_at, source)
      SELECT kind, grant_id, created_at, source FROM confirm_grants`,
    `DROP TABLE confirm_grants`,
    `ALTER TABLE confirm_grants_new RENAME TO confirm_grants`,

    `CREATE TABLE confirm_grant_states_new (
      kind                TEXT PRIMARY KEY CHECK(kind IN ('install','command','send','connect')),
      version             INTEGER NOT NULL CHECK(version >= 0),
      revocation_epoch    INTEGER NOT NULL CHECK(revocation_epoch >= 0)
    )`,
    `INSERT INTO confirm_grant_states_new (kind, version, revocation_epoch)
      SELECT kind, version, revocation_epoch FROM confirm_grant_states`,
    `DROP TABLE confirm_grant_states`,
    `ALTER TABLE confirm_grant_states_new RENAME TO confirm_grant_states`,
    `INSERT INTO confirm_grant_states (kind, version, revocation_epoch)
      VALUES ('send', 0, 0), ('connect', 0, 0)`,

    // 0027 给这张表补过 subject_id,重建时必须带上,否则会把后续列丢掉
    `CREATE TABLE confirm_grant_events_new (
      event_id    TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      grant_id    TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK(kind IN ('install','command','send','connect')),
      action      TEXT NOT NULL CHECK(action IN ('created','revoked')),
      source      TEXT NOT NULL CHECK(source IN ('card','settings')),
      subject_id  TEXT NOT NULL DEFAULT 'local-user'
    )`,
    `INSERT INTO confirm_grant_events_new (event_id, ts, grant_id, kind, action, source, subject_id)
      SELECT event_id, ts, grant_id, kind, action, source, subject_id FROM confirm_grant_events`,
    `DROP TABLE confirm_grant_events`,
    `ALTER TABLE confirm_grant_events_new RENAME TO confirm_grant_events`,
    `CREATE INDEX idx_confirm_grant_events_grant
      ON confirm_grant_events(grant_id, ts, event_id)`,
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0033ConfirmGrantsSendConnect: Migration = {
  id: 33,
  name: "confirm_grants_send_connect",
  up,
};
