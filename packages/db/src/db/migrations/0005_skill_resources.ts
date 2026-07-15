import type { Client } from "@libsql/client";
import type { Migration } from "./types.js";

async function up(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS skill_resources (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS lexicon_entries (
    id TEXT PRIMARY KEY,
    resource_id TEXT NOT NULL REFERENCES skill_resources(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    replacement TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_lexicon_entries_resource ON lexicon_entries(resource_id)",
  );

  // 历史示例 seed 已停止投放；已升级数据库中的旧记录由用户自行保留或删除。
}

export const migration0005SkillResources: Migration = {
  id: 5,
  name: "skill_resources",
  up,
};
