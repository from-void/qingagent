import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0011ReviewTemplates } from "../migrations/0011_review_templates.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0011-"); });
afterEach(() => db.cleanup());

describe("0011 review templates", () => {
  it("种子覆盖三种审查，并把 B18 固定指令迁为当前用户模板", async () => {
    await runMigrations(MIGRATIONS.slice(0, 10));
    const client = getDocumentsClient();
    const now = "2026-07-14T00:00:00.000Z";
    const legacyRows: ReadonlyArray<readonly [string, string, string]> = [
      ["review-sensitive-instruction", "敏感词审查指令", "保留引用中的命中，只标记"],
      ["review-source-instruction", "来源审查指令", "金额必须逐字核对"],
    ];
    for (const [id, name, prompt] of legacyRows) {
      await client.execute({
        sql: "INSERT INTO skill_resources(id,kind,name,meta_json,created_at,updated_at) VALUES(?,'style-template',?,'{}',?,?)",
        args: [id, name, now, now],
      });
      await client.execute({
        sql: `INSERT INTO style_templates(resource_id,dtype,slot,name,detail,prompt,builtin)
          VALUES(?,'review','instruction',?,'',?,0)`,
        args: [id, name, prompt],
      });
    }

    await migration0011ReviewTemplates.up(client);

    const counts = await client.execute("SELECT type,COUNT(*) n FROM review_templates GROUP BY type ORDER BY type");
    expect(counts.rows.map((row) => [row.type, Number(row.n)])).toEqual([
      ["deai", 3],
      ["sensitive", 2],
      ["source", 2],
    ]);
    const selected = await client.execute(`SELECT s.type,t.prompt,t.builtin FROM review_template_selections s
      JOIN review_templates t ON t.id=s.template_id ORDER BY s.type`);
    expect(selected.rows.find((row) => row.type === "sensitive")).toMatchObject({ prompt: "保留引用中的命中，只标记", builtin: 0 });
    expect(selected.rows.find((row) => row.type === "source")).toMatchObject({ prompt: "金额必须逐字核对", builtin: 0 });
    expect(selected.rows.find((row) => row.type === "deai")?.prompt).toContain("轻度去味");
  });
});
