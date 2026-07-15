import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

describe("0010 annotation groups migration", () => {
  let db: TempDocumentsDb;
  beforeEach(() => { db = prepareTempDocumentsDb("qa-annotation-migration-"); });
  afterEach(() => db.cleanup());

  it("新库允许 annotation 的 steps/preview 为空并保留 revision 默认值", async () => {
    await runMigrations();
    const client = getDocumentsClient();
    await client.execute({ sql: `INSERT INTO document_suggestions(
      id,doc_id,base_version,status,anchor_json,steps_json,preview_json,summary,kind,note,origin,group_id,group_meta_json,created_at,updated_at
    ) VALUES('a','d',1,'reviewing','{}',NULL,NULL,'问题','annotation','说明','source-check','g','{}','n','n')`, args: [] });
    await client.execute({ sql: `INSERT INTO document_suggestions(
      id,doc_id,base_version,status,anchor_json,steps_json,preview_json,summary,created_at,updated_at
    ) VALUES('r','d',1,'reviewing','{}','[]','{}','修订','n','n')`, args: [] });
    await client.execute("UPDATE document_suggestions SET status='ignored' WHERE id='a'");
    const result = await client.execute("SELECT id,kind,status,steps_json FROM document_suggestions ORDER BY id");
    expect(result.rows).toMatchObject([
      { id: "a", kind: "annotation", status: "ignored", steps_json: null },
      { id: "r", kind: "revision", status: "reviewing", steps_json: "[]" },
    ]);
  });
});
