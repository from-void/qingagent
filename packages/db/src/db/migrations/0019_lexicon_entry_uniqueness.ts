import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const statements = [
    `CREATE TABLE lexicon_entries_new (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES skill_resources(id) ON DELETE CASCADE,
      word TEXT NOT NULL,
      replacement TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(resource_id, word)
    )`,
    `INSERT INTO lexicon_entries_new (
      id, resource_id, word, replacement, enabled, note, created_at, updated_at
    ) SELECT id, resource_id, word, replacement, enabled, note, created_at, updated_at
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY resource_id, word
          ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS duplicate_rank
        FROM lexicon_entries
      )
      WHERE duplicate_rank = 1`,
    "DROP TABLE lexicon_entries",
    "ALTER TABLE lexicon_entries_new RENAME TO lexicon_entries",
    "CREATE INDEX idx_lexicon_entries_resource ON lexicon_entries(resource_id)",
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0019LexiconEntryUniqueness: Migration = {
  id: 19,
  name: "lexicon_entry_uniqueness",
  up,
};
