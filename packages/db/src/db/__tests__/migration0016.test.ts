import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0016TranslateDerivatives } from "../migrations/0016_translate_derivatives.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0016-"); });
afterEach(() => db.cleanup());

describe("0016 translate derivatives", () => {
  it("新增目标语言列与三条翻译种子，且不增加 source/dtype 唯一索引", async () => {
    await runMigrations(MIGRATIONS.slice(0, 15));
    const client = getDocumentsClient();
    await migration0016TranslateDerivatives.up(client);
    await migration0016TranslateDerivatives.up(client);
    const columns = await client.execute("PRAGMA table_info(document_derivatives)");
    expect(columns.rows.some((row) => row.name === "target_lang")).toBe(true);
    const seeds = await client.execute("SELECT resource_id,name,detail,prompt,builtin FROM style_templates WHERE dtype='translate' ORDER BY resource_id");
    expect(seeds.rows).toHaveLength(3);
    expect(seeds.rows.every((row) => Number(row.builtin) === 1)).toBe(true);
    const indexes = await client.execute("PRAGMA index_list(document_derivatives)");
    const uniqueIndexes = indexes.rows.filter((row) => Number(row.unique) === 1);
    expect(uniqueIndexes).toHaveLength(1);
    expect(uniqueIndexes[0]?.origin).toBe("pk");
  });
});
