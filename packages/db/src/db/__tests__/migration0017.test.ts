import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0017DerivativeCoverTemplate } from "../migrations/0017_derivative_cover_template.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0017-"); });
afterEach(() => db.cleanup());

describe("0017 derivative cover template", () => {
  it("新增封面模板列、默认大字报且迁移幂等", async () => {
    await runMigrations(MIGRATIONS.slice(0, 16));
    const client = getDocumentsClient();
    await migration0017DerivativeCoverTemplate.up(client);
    await migration0017DerivativeCoverTemplate.up(client);
    const columns = await client.execute("PRAGMA table_info(document_derivatives)");
    const cover = columns.rows.find((row) => row.name === "cover_template");
    expect(cover?.dflt_value).toBe("'poster'");
    expect(Number(cover?.notnull)).toBe(1);
  });
});
