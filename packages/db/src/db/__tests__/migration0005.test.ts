import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0005SkillResources } from "../migrations/0005_skill_resources.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0005-"); });
afterEach(() => db.cleanup());

describe("0005 skill resources", () => {
  it("从 0004 升级创建两表且不再投放历史示例 seed", async () => {
    await runMigrations(MIGRATIONS.slice(0, 4));
    const client = getDocumentsClient();
    await migration0005SkillResources.up(client);
    await migration0005SkillResources.up(client);
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_resources','lexicon_entries')");
    expect(tables.rows).toHaveLength(2);
    const resources = await client.execute("SELECT COUNT(*) AS n FROM skill_resources");
    const entries = await client.execute("SELECT COUNT(*) AS n FROM lexicon_entries");
    expect(Number(resources.rows[0]?.n)).toBe(0);
    expect(Number(entries.rows[0]?.n)).toBe(0);
  });
});
