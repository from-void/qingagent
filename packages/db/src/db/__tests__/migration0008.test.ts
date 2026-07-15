import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0008ReviewInstructionAndLexicons, REVIEW_LEXICON_SEEDS } from "../migrations/0008_review_instruction_and_lexicons.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0008-"); });
afterEach(() => db.cleanup());

describe("0008 review instruction and lexicons", () => {
  it("重建 CHECK 后允许 instruction，四库 seed 完整且重复执行不翻倍", async () => {
    await runMigrations(MIGRATIONS.slice(0, 7));
    const client = getDocumentsClient();
    await migration0008ReviewInstructionAndLexicons.up(client);
    await migration0008ReviewInstructionAndLexicons.up(client);
    await client.execute(`INSERT INTO skill_resources(id,kind,name,meta_json,created_at,updated_at)
      VALUES('review-sensitive-instruction','style-template','敏感词审查指令','{}','now','now')`);
    await client.execute(`INSERT INTO style_templates(resource_id,dtype,slot,name,detail,prompt,builtin)
      VALUES('review-sensitive-instruction','review','instruction','敏感词审查指令','','',0)`);
    const resources = await client.execute("SELECT id,meta_json FROM skill_resources WHERE kind='lexicon' ORDER BY id");
    expect(resources.rows).toHaveLength(4);
    expect(resources.rows.every((row) => typeof JSON.parse(String(row.meta_json)).description === "string")).toBe(true);
    const entries = await client.execute("SELECT resource_id,COUNT(*) n FROM lexicon_entries GROUP BY resource_id");
    const counts = new Map(entries.rows.map((row) => [String(row.resource_id), Number(row.n)]));
    for (const seed of REVIEW_LEXICON_SEEDS) expect(counts.get(seed.id)).toBe(seed.entries.length);
    expect(REVIEW_LEXICON_SEEDS.every((seed) => seed.entries.length >= 30 && seed.entries.length <= 80)).toBe(true);
  });

  it("升级时保留旧示例库与已有模板内容", async () => {
    await runMigrations(MIGRATIONS.slice(0, 7));
    const client = getDocumentsClient();
    await client.execute("INSERT INTO skill_resources VALUES('lexicon-gongwen-sample','lexicon','旧示例','{}','now','now')");
    await client.execute("UPDATE style_templates SET prompt='用户修改' WHERE resource_id='gzh-deep'");
    await migration0008ReviewInstructionAndLexicons.up(client);
    expect((await client.execute("SELECT name FROM skill_resources WHERE id='lexicon-gongwen-sample'")).rows[0]?.name).toBe("旧示例");
    expect((await client.execute("SELECT prompt FROM style_templates WHERE resource_id='gzh-deep'")).rows[0]?.prompt).toBe("用户修改");
  });
});
