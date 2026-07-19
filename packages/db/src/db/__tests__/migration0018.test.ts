import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0018DocumentOpsMutationScope } from "../migrations/0018_document_ops_mutation_scope.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0018-"); });
afterEach(() => db.cleanup());

function insertSql(opId: string, docId: string): string {
  return `INSERT INTO document_ops (
    op_id, doc_id, op_kind, client_mutation_id, steps,
    from_version, to_version, actor_type, created_at
  ) VALUES ('${opId}', '${docId}', 'replace_doc', 'shared-mutation', NULL, 1, 2, 'user', '2026-07-19T00:00:00.000Z')`;
}

describe("0018 document ops mutation scope", () => {
  it("保留旧操作并把 mutation 唯一约束收窄到文档", async () => {
    await runMigrations(MIGRATIONS.slice(0, 17));
    const client = getDocumentsClient();
    await client.execute(insertSql("old-op", "old-doc"));

    await migration0018DocumentOpsMutationScope.up(client);

    const old = await client.execute("SELECT * FROM document_ops WHERE op_id = 'old-op'");
    expect(old.rows[0]).toMatchObject({
      doc_id: "old-doc",
      client_mutation_id: "shared-mutation",
      from_version: 1,
      to_version: 2,
    });
    await expect(client.execute(insertSql("same-doc-op", "old-doc"))).rejects.toThrow();
    await expect(client.execute(insertSql("other-doc-op", "other-doc"))).resolves.toMatchObject({ rowsAffected: 1 });
  });
});
