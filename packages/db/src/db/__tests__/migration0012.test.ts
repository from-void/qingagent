import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTYPE_WRITING_TEMPLATE_SEEDS } from "../../seeds/dtypeTemplatePrompts.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0012DerivativeWritingTemplates } from "../migrations/0012_derivative_writing_templates.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0012-"); });
afterEach(() => db.cleanup());

describe("0012 derivative writing templates", () => {
  it("下线旧内置模板、迁移引用，并原样保留用户模板", async () => {
    await runMigrations(MIGRATIONS.slice(0, 11));
    const client = getDocumentsClient();
    const now = "2026-07-14T00:00:00.000Z";
    await client.execute("UPDATE style_templates SET prompt='用户自定义提示',builtin=0 WHERE resource_id='gzh-deep'");
    await client.execute({
      sql: "INSERT INTO document_derivatives(doc_id,source_doc_id,dtype,template_id,private_prompt,created_at,updated_at) VALUES('d','m','xhs','xhs-seed','',?,?)",
      args: [now, now],
    });

    await migration0012DerivativeWritingTemplates.up(client);
    await migration0012DerivativeWritingTemplates.up(client);

    const newTemplates = await client.execute("SELECT resource_id,prompt,builtin FROM style_templates WHERE resource_id IN ('gzh-opinion','gzh-tutorial','gzh-story','xhs-recommend','xhs-checklist','xhs-experience') ORDER BY resource_id");
    expect(newTemplates.rows).toHaveLength(DTYPE_WRITING_TEMPLATE_SEEDS.filter((item) => item.dtype !== "translate").length);
    expect(newTemplates.rows.every((row) => Number(row.builtin) === 1)).toBe(true);
    expect((await client.execute("SELECT prompt,builtin FROM style_templates WHERE resource_id='gzh-deep'")).rows[0]).toMatchObject({ prompt: "用户自定义提示", builtin: 0 });
    expect((await client.execute("SELECT COUNT(*) AS n FROM style_templates WHERE resource_id IN ('gzh-news','xhs-seed','xhs-list')")).rows[0]?.n).toBe(0);
    expect((await client.execute("SELECT template_id FROM document_derivatives WHERE doc_id='d'")).rows[0]?.template_id).toBe("xhs-recommend");
  });
});
