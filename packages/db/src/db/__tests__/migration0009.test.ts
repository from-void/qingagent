import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { DEAI_STYLE_TEMPLATE_SEEDS, migration0009DeaiStyleTemplates } from "../migrations/0009_deai_style_templates.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0009-"); });
afterEach(() => db.cleanup());

describe("0009 deai style templates", () => {
  it("seed 三枚 instruction 模板且重复执行不翻倍", async () => {
    await runMigrations(MIGRATIONS.slice(0, 8));
    const client = getDocumentsClient();
    await migration0009DeaiStyleTemplates.up(client);
    await migration0009DeaiStyleTemplates.up(client);
    const result = await client.execute("SELECT resource_id,dtype,slot,name,detail,prompt,builtin FROM style_templates WHERE dtype='deai' ORDER BY resource_id");
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.slot === "instruction" && Number(row.builtin) === 1)).toBe(true);
    for (const seed of DEAI_STYLE_TEMPLATE_SEEDS) {
      const row = result.rows.find((item) => item.resource_id === seed.id);
      expect(row).toMatchObject({ dtype: "deai", slot: "instruction", name: seed.name });
      expect(String(row?.detail)).toContain("Humanizer-zh");
      expect(String(row?.detail)).toContain("Wikipedia");
      expect(String(row?.prompt)).toContain("先 readDraft 定位");
      expect(String(row?.prompt)).toContain("禁止整篇 writeDraft");
    }
  });

  it("升级与重跑保留用户修改", async () => {
    await runMigrations(MIGRATIONS.slice(0, 8));
    const client = getDocumentsClient();
    await migration0009DeaiStyleTemplates.up(client);
    await client.execute("UPDATE style_templates SET prompt='用户修改',builtin=0 WHERE resource_id='deai-light'");
    await migration0009DeaiStyleTemplates.up(client);
    expect((await client.execute("SELECT prompt,builtin FROM style_templates WHERE resource_id='deai-light'")).rows[0]).toMatchObject({ prompt: "用户修改", builtin: 0 });
  });
});
