import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0019LexiconEntryUniqueness } from "../migrations/0019_lexicon_entry_uniqueness.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0019-"); });
afterEach(() => db.cleanup());

describe("0019 lexicon entry uniqueness", () => {
  it("升级旧数据时每词保留最新一条并建立联合唯一约束", async () => {
    await runMigrations(MIGRATIONS.slice(0, 18));
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO skill_resources
      (id, kind, name, meta_json, created_at, updated_at)
      VALUES ('legacy-lexicon', 'lexicon', '旧词库', '{}', '2026-01-01', '2026-01-03')`);
    await client.execute(`INSERT INTO lexicon_entries
      (id, resource_id, word, replacement, enabled, note, created_at, updated_at)
      VALUES
        ('entry-old', 'legacy-lexicon', '重复词', '旧替换', 1, '旧注释', '2026-01-01', '2026-01-01'),
        ('entry-latest', 'legacy-lexicon', '重复词', '新替换', 1, '新注释', '2026-01-02', '2026-01-03')`);

    await migration0019LexiconEntryUniqueness.up(client);

    const rows = await client.execute(
      "SELECT id, replacement, note FROM lexicon_entries WHERE resource_id = 'legacy-lexicon' AND word = '重复词'",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: "entry-latest", replacement: "新替换", note: "新注释" }),
    ]);
    await expect(client.execute(`INSERT INTO lexicon_entries
      (id, resource_id, word, replacement, enabled, note, created_at, updated_at)
      VALUES ('entry-duplicate', 'legacy-lexicon', '重复词', NULL, 1, NULL, '2026-01-04', '2026-01-04')`)).rejects.toThrow();
  });
});
