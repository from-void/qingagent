import type { Client } from "@libsql/client";
import type { Migration } from "../migrations.js";

// ⚠️ baseline 专用幂等 helper：只允许本 0001 迁移使用。
// 存量用户库形态各异（缺列 / 含已退役 doc_sections / 部分列已加），且都没有
// schema_migrations 账本，runner 无法区分"全新库"和"任意历史形态存量库"。
// 因此 baseline = 历史四处 ensure* 函数体的逐行搬移，保持全部幂等写法
// （CREATE IF NOT EXISTS + addColumnIfMissing 的 catch-正则），跑一遍把任意历史
// 切面收敛到同一 schema。0002 起的新迁移一律写确定性 DDL，禁止再用这套 catch-正则技。

function isDuplicateColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : "";
  return /duplicate column name|already exists/i.test(`${code} ${message}`);
}

function isMissingColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err && "code" in err ? String(err.code) : "";
  return /no such column/i.test(`${code} ${message}`);
}

async function addColumnIfMissing(client: Client, sql: string): Promise<void> {
  try {
    await client.execute(sql);
  } catch (err) {
    if (isDuplicateColumnError(err)) return;
    throw err;
  }
}

async function dropColumnIfExists(client: Client, sql: string): Promise<void> {
  try {
    await client.execute(sql);
  } catch (err) {
    if (isMissingColumnError(err)) return;
    throw err;
  }
}

// 顺序执行多条 DDL(在 runner 已开的事务内),替代历史 client.batch(...,"write")——
// 后者会另起事务,在 runner 的 BEGIN IMMEDIATE 内会触发 "transaction within a transaction"。
async function execAll(client: Client, statements: string[]): Promise<void> {
  for (const sql of statements) {
    await client.execute(sql);
  }
}

async function up(client: Client): Promise<void> {
  // ── documents 主表族（原 documentsSchema.ensureDocumentsTable 逐行搬移）──
  await client.execute(
    `CREATE TABLE IF NOT EXISTS documents (
      id                   TEXT    PRIMARY KEY,
      thread_id            TEXT    NOT NULL UNIQUE,
      resource_id          TEXT    NOT NULL,
      title                TEXT    NOT NULL DEFAULT '',
      doc_state            TEXT    NOT NULL,
      doc_version          INTEGER NOT NULL DEFAULT 0,
      last_synced_version  INTEGER NOT NULL DEFAULT 0,
      doc_pm               TEXT,
      doc_schema_version   INTEGER NOT NULL DEFAULT 0,
      content_hash         TEXT,
      doc_format           TEXT    NOT NULL DEFAULT 'legacy_sections',
      version              INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    )`,
  );
  await addColumnIfMissing(client, "ALTER TABLE documents ADD COLUMN doc_pm TEXT");
  await addColumnIfMissing(
    client,
    "ALTER TABLE documents ADD COLUMN doc_schema_version INTEGER NOT NULL DEFAULT 0",
  );
  await addColumnIfMissing(client, "ALTER TABLE documents ADD COLUMN content_hash TEXT");
  await addColumnIfMissing(
    client,
    "ALTER TABLE documents ADD COLUMN doc_format TEXT NOT NULL DEFAULT 'legacy_sections'",
  );
  // 治理批次8-C:退役 doc_sections 死列。新库不再创建;老库按幂等模式 DROP。
  await dropColumnIfExists(client, "ALTER TABLE documents DROP COLUMN doc_sections");
  // 注:baseline 在 runner 的 BEGIN IMMEDIATE 事务内执行,故用顺序 execute,
  // 不能用 client.batch(..., "write")(它会另起事务 → "transaction within a transaction")。
  await execAll(client, [
      `CREATE INDEX IF NOT EXISTS idx_documents_resource_updated
        ON documents (resource_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS document_versions (
        version_id      TEXT    PRIMARY KEY,
        doc_id          TEXT    NOT NULL,
        doc_version     INTEGER NOT NULL,
        content_hash    TEXT    NOT NULL,
        schema_version  INTEGER NOT NULL,
        actor_type      TEXT    NOT NULL,
        summary         TEXT,
        snapshot_pm     TEXT    NOT NULL,
        parent_version  INTEGER,
        created_at      TEXT    NOT NULL,
        UNIQUE(doc_id, doc_version)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_document_versions_doc
        ON document_versions (doc_id, doc_version DESC)`,
      `CREATE TABLE IF NOT EXISTS document_ops (
        op_id               TEXT    PRIMARY KEY,
        doc_id              TEXT    NOT NULL,
        op_kind             TEXT    NOT NULL,
        client_mutation_id  TEXT    UNIQUE,
        steps               TEXT,
        from_version        INTEGER NOT NULL,
        to_version          INTEGER NOT NULL,
        actor_type          TEXT    NOT NULL,
        created_at          TEXT    NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_document_ops_doc
        ON document_ops (doc_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS document_suggestions (
        id                   TEXT    PRIMARY KEY,
        doc_id               TEXT    NOT NULL,
        base_version         INTEGER NOT NULL,
        status               TEXT    NOT NULL,
        anchor_json          TEXT    NOT NULL,
        steps_json           TEXT    NOT NULL,
        preview_json         TEXT    NOT NULL,
        summary              TEXT    NOT NULL DEFAULT '',
        conflict_json        TEXT,
        created_at           TEXT    NOT NULL,
        updated_at           TEXT    NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_document_suggestions_doc
        ON document_suggestions (doc_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS document_drafts (
        doc_id           TEXT PRIMARY KEY,
        thread_id        TEXT NOT NULL,
        base_version     INTEGER NOT NULL,
        base_hash        TEXT NOT NULL,
        draft_pm         TEXT NOT NULL,
        status           TEXT NOT NULL,
        conflict_json    TEXT,
        review_batch_id  TEXT,
        group_mode       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_document_drafts_thread
        ON document_drafts (thread_id, updated_at DESC)`,
  ]);
  await addColumnIfMissing(client, "ALTER TABLE document_drafts ADD COLUMN review_batch_id TEXT");
  await addColumnIfMissing(client, "ALTER TABLE document_drafts ADD COLUMN group_mode TEXT");
  await addColumnIfMissing(client, "ALTER TABLE document_drafts ADD COLUMN source_stream_id TEXT");
  await addColumnIfMissing(
    client,
    "ALTER TABLE document_drafts ADD COLUMN source_tool_call_id TEXT",
  );

  // ── llm_usage_events（原 usageSchema.ensureUsageTable 逐行搬移）──
  await client.execute(
    `CREATE TABLE IF NOT EXISTS llm_usage_events (
      id                 TEXT    PRIMARY KEY,
      session_id         TEXT    NOT NULL,
      run_id             TEXT,
      call_site          TEXT    NOT NULL,
      model_id           TEXT    NOT NULL,
      key_origin         TEXT    NOT NULL DEFAULT 'env',
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens  INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL
    )`,
  );
  await execAll(client, [
    `CREATE INDEX IF NOT EXISTS idx_usage_session ON llm_usage_events (session_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_day ON llm_usage_events (created_at, model_id)`,
  ]);

  // ── sandbox_credentials（原 credentialsRepo.ensureSchema 逐行搬移，含一次性 DELETE feishu）──
  await client.execute(
    `CREATE TABLE IF NOT EXISTS sandbox_credentials (
      scope       TEXT NOT NULL DEFAULT 'default',
      platform    TEXT NOT NULL,
      cred_key    TEXT NOT NULL,
      value_enc   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (scope, platform, cred_key)
    )`,
  );
  // 一次性幂等数据迁移:飞书改由 lark-cli 自管,legacy 后端凭据不能继续暴露或注入。
  await client.execute("DELETE FROM sandbox_credentials WHERE platform = 'feishu'");

  // ── app_settings（原 appSettingsRepo.ensureSettingsTable 逐行搬移）──
  await client.execute(
    `CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
}

export const migration0001Baseline: Migration = {
  id: 1,
  name: "baseline",
  up,
};
