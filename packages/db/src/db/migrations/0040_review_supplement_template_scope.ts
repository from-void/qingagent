import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(`CREATE TABLE review_doc_supplements_scoped (
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    template_scope TEXT NOT NULL DEFAULT '',
    supplement TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(doc_id, type, template_scope)
  )`);
  await client.execute(`INSERT INTO review_doc_supplements_scoped(
      doc_id,type,template_scope,supplement,created_at,updated_at
    )
    SELECT doc_id,type,'',supplement,created_at,updated_at
    FROM review_doc_supplements`);
  await client.execute("DROP TABLE review_doc_supplements");
  await client.execute(
    "ALTER TABLE review_doc_supplements_scoped RENAME TO review_doc_supplements",
  );
}

export const migration0040ReviewSupplementTemplateScope: Migration = {
  id: 40,
  name: "review_supplement_template_scope",
  up,
};
