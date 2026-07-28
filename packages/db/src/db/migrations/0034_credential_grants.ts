import type { Migration } from "./types.js";

// 命令行工具凭证共享授权。confirm_grants 每类只有一行(kind 是主键),装不下
// "按路径逐条授权/逐条回收"的语义,所以单开一张表;确认卡、审计与安全页仍复用
// connect 那一套(审计写进 confirm_audit_events,subject_id = 规范化路径)。
async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE credential_grants (
      path        TEXT PRIMARY KEY,
      grant_id    TEXT NOT NULL UNIQUE,
      skill_name  TEXT NOT NULL,
      declared    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      source      TEXT NOT NULL CHECK(source IN ('card','settings','preset'))
    )`,
    `CREATE INDEX idx_credential_grants_skill
      ON credential_grants(skill_name, path)`,
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0034CredentialGrants: Migration = {
  id: 34,
  name: "credential_grants",
  up,
};
