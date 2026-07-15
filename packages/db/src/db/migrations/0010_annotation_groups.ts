import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  // 组字段冗余在每个锚点行：批注组通常很小，复用 suggestion 的级联生命周期，
  // 避免为一次确认交互引入跨表事务；group_id 负责稳定聚合。
  const statements = [
    `CREATE TABLE document_suggestions_new (
      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, base_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reviewing','accepted','rejected','committed','conflict','ignored')),
      anchor_json TEXT NOT NULL, steps_json TEXT, preview_json TEXT,
      summary TEXT NOT NULL DEFAULT '', conflict_json TEXT,
      kind TEXT NOT NULL DEFAULT 'revision' CHECK(kind IN ('revision','annotation')),
      note TEXT, origin TEXT, group_id TEXT, group_meta_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `INSERT INTO document_suggestions_new(
      id,doc_id,base_version,status,anchor_json,steps_json,preview_json,summary,conflict_json,created_at,updated_at
    ) SELECT id,doc_id,base_version,status,anchor_json,steps_json,preview_json,summary,conflict_json,created_at,updated_at FROM document_suggestions`,
    "DROP TABLE document_suggestions",
    "ALTER TABLE document_suggestions_new RENAME TO document_suggestions",
    "CREATE INDEX idx_document_suggestions_doc ON document_suggestions(doc_id, updated_at DESC)",
    "CREATE INDEX idx_document_suggestions_annotation_group ON document_suggestions(doc_id, kind, group_id, status)",
  ];
  for (const sql of statements) await client.execute(sql);
}

export const migration0010AnnotationGroups: Migration = { id: 10, name: "annotation_groups", up };
