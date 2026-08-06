import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0040ReviewSupplementTemplateScope } from "../migrations/0040_review_supplement_template_scope.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0040-"); });
afterEach(() => db.cleanup());

describe("0040 review supplement template scope", () => {
  it("把旧 (doc_id,type) 记录原样迁到空模板作用域", async () => {
    await runMigrations(MIGRATIONS.slice(0, 36));
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO documents(
      id,thread_id,resource_id,title,doc_state,created_at,updated_at,role
    ) VALUES('doc-scope-migration','thread-scope-migration','qingagent-user','迁移','editing','old','old','main')`);
    await client.execute({
      sql: `INSERT INTO review_doc_supplements(doc_id,type,supplement,created_at,updated_at)
        VALUES(?,?,?,?,?)`,
      args: ["doc-scope-migration", "custom", "老 custom 决定与用户补充", "created", "updated"],
    });

    await migration0040ReviewSupplementTemplateScope.up(client);

    const rows = await client.execute(
      "SELECT doc_id,type,template_scope,supplement,created_at,updated_at FROM review_doc_supplements",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        doc_id: "doc-scope-migration",
        type: "custom",
        template_scope: "",
        supplement: "老 custom 决定与用户补充",
        created_at: "created",
        updated_at: "updated",
      }),
    ]);
  });
});
