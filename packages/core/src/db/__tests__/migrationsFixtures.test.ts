import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { getDocumentsClient } from "../documentsClient.js";
import { __resetMigrationsForTest, runMigrations } from "../migrations.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { MIGRATIONS } from "../migrations/index.js";

// fixture 矩阵(设计 §2.4 核心验收):五形态库 × 跑迁移后 schema 与黄金 schema 全等 +
// 预置探针数据无损 + 账本记账 + feishu 行被清。
// 黄金 schema = fresh 库跑 runMigrations(baseline) 的结果;等价性另由 baseline 是历史
// ensure* 逐行搬移(diff 可对照)+ 下方显式列/索引快照双重保证。
// 说明:v-oldest 经 ALTER ADD COLUMN 追加列会改变物理列序,故 schema 比对按列名归一
// (集合语义,忽略 cid 顺序)——所有访问按列名,列序语义无关。

let db: TempDocumentsDb;
// 黄金 schema 只算一次(beforeAll,独立临时库;其 cleanup 会清 DATABASE_URL,
// 随后每个 beforeEach 重新建立外层测试库,互不污染)。
let golden = "";

beforeAll(async () => {
  const g = prepareTempDocumentsDb("qa-migrations-golden-");
  try {
    __resetMigrationsForTest();
    await runMigrations();
    golden = await captureSchema(getDocumentsClient());
  } finally {
    __resetMigrationsForTest();
    g.cleanup();
  }
});

beforeEach(() => {
  __resetMigrationsForTest();
  db = prepareTempDocumentsDb("qa-migrations-fixtures-");
});

afterEach(() => {
  __resetMigrationsForTest();
  db.cleanup();
});

const APP_TABLES = [
  "documents",
  "document_versions",
  "document_ops",
  "document_suggestions",
  "document_drafts",
  "llm_usage_events",
  "sandbox_credentials",
  "app_settings",
];

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt: string | null;
  pk: number;
}

/** 归一化 schema:每表列集合(按列名排序)+ 全库索引名集合。顺序无关,便于全等比对。 */
async function captureSchema(client: Client): Promise<string> {
  const perTable: Record<string, ColumnInfo[]> = {};
  for (const table of APP_TABLES) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    perTable[table] = info.rows
      .map((r) => ({
        name: String(r.name),
        type: String(r.type),
        notnull: Number(r.notnull),
        dflt: r.dflt_value == null ? null : String(r.dflt_value),
        pk: Number(r.pk),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const idx = await client.execute(
    `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
  );
  const indexes = idx.rows.map((r) => `${String(r.tbl_name)}.${String(r.name)}`).sort();
  return JSON.stringify({ perTable, indexes });
}

async function ledgerIds(client: Client): Promise<number[]> {
  const res = await client.execute("SELECT id FROM schema_migrations ORDER BY id");
  return res.rows.map((r) => Number(r.id));
}

async function count(client: Client, sql: string): Promise<number> {
  const res = await client.execute(sql);
  return Number(res.rows[0]?.n ?? 0);
}

// ── 各形态库构造脚本(SQL 构造,便于 review)──

/** v-oldest:documents 缺 4 新列、含 doc_sections;drafts 缺 4 列;含 feishu 凭据。 */
async function buildOldest(client: Client): Promise<void> {
  await client.execute(
    `CREATE TABLE documents (
      id                   TEXT    PRIMARY KEY,
      thread_id            TEXT    NOT NULL UNIQUE,
      resource_id          TEXT    NOT NULL,
      title                TEXT    NOT NULL DEFAULT '',
      doc_state            TEXT    NOT NULL,
      doc_version          INTEGER NOT NULL DEFAULT 0,
      last_synced_version  INTEGER NOT NULL DEFAULT 0,
      doc_sections         TEXT    NOT NULL DEFAULT '[]',
      version              INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    )`,
  );
  await client.execute(
    `CREATE TABLE document_drafts (
      doc_id           TEXT PRIMARY KEY,
      thread_id        TEXT NOT NULL,
      base_version     INTEGER NOT NULL,
      base_hash        TEXT NOT NULL,
      draft_pm         TEXT NOT NULL,
      status           TEXT NOT NULL,
      conflict_json    TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    )`,
  );
  await client.execute(
    `CREATE TABLE sandbox_credentials (
      scope       TEXT NOT NULL DEFAULT 'default',
      platform    TEXT NOT NULL,
      cred_key    TEXT NOT NULL,
      value_enc   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (scope, platform, cred_key)
    )`,
  );
  // 探针数据
  await client.execute(
    `INSERT INTO documents (id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version, doc_sections, version, created_at, updated_at)
     VALUES ('doc-old', 'thr-old', 'user-1', '旧库文档', 'editing', 3, 3, '[{"kind":"p"}]', 3, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  );
  await client.execute(
    `INSERT INTO document_drafts (doc_id, thread_id, base_version, base_hash, draft_pm, status, created_at, updated_at)
     VALUES ('doc-old', 'thr-old', 3, 'h', '{}', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
  );
  await client.execute(
    `INSERT INTO sandbox_credentials (scope, platform, cred_key, value_enc, created_at, updated_at)
     VALUES ('default', 'feishu', 'FEISHU_APP_ID', 'enc', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
            ('default', 'github', 'GITHUB_TOKEN', 'enc', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
}

/** v-mid:documents 有 doc_pm/doc_schema_version/content_hash 但缺 doc_format;drafts 有 review_batch_id/group_mode 但缺 source_* 两列。 */
async function buildMid(client: Client): Promise<void> {
  await client.execute(
    `CREATE TABLE documents (
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
      version              INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    )`,
  );
  await client.execute(
    `CREATE TABLE document_drafts (
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
  );
  await client.execute(
    `INSERT INTO documents (id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version, doc_pm, doc_schema_version, content_hash, version, created_at, updated_at)
     VALUES ('doc-mid', 'thr-mid', 'user-1', '中间库文档', 'editing', 1, 1, '{"type":"doc"}', 2, 'hash-mid', 1, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
  );
  await client.execute(
    `INSERT INTO document_drafts (doc_id, thread_id, base_version, base_hash, draft_pm, status, review_batch_id, group_mode, created_at, updated_at)
     VALUES ('doc-mid', 'thr-mid', 1, 'h', '{}', 'pending', 'rb-1', 'single', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
  );
}

describe("fixture 矩阵:五形态库跑迁移后收敛到黄金 schema", () => {
  it("fresh:空库建全表,账本记 baseline,无备份", async () => {
    const client = getDocumentsClient();

    const r = await runMigrations();
    expect(r.appliedIds).toEqual([1, 2, 3]);
    expect(r.backupPath).toBeNull(); // 全新库不备份
    expect(await captureSchema(client)).toEqual(golden);
    expect(await ledgerIds(client)).toEqual([1, 2, 3]);
  });

  it("v-oldest:缺列/含 doc_sections/含 feishu → 收敛到黄金 schema,探针无损,feishu 清除,已备份", async () => {
    const client = getDocumentsClient();

    await buildOldest(client);
    const r = await runMigrations();
    expect(r.appliedIds).toEqual([1, 2, 3]);
    expect(r.backupPath).toBeTruthy(); // 既有库升级前备份

    expect(await captureSchema(client)).toEqual(golden);
    expect(await ledgerIds(client)).toEqual([1, 2, 3]);

    // 探针数据无损 + 新列默认值
    const doc = await client.execute("SELECT * FROM documents WHERE id = 'doc-old'");
    expect(doc.rows.length).toBe(1);
    expect(String(doc.rows[0]?.title)).toBe("旧库文档");
    expect(String(doc.rows[0]?.doc_format)).toBe("legacy_sections");
    expect(doc.rows[0]?.doc_pm).toBeNull();
    expect(Number(doc.rows[0]?.doc_schema_version)).toBe(0);
    // doc_sections 列已被 DROP
    expect("doc_sections" in (doc.rows[0] as Record<string, unknown>)).toBe(false);
    expect(await count(client, "SELECT COUNT(*) AS n FROM document_drafts WHERE doc_id = 'doc-old'")).toBe(1);
    // feishu 清除,github 保留
    expect(await count(client, "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'feishu'")).toBe(0);
    expect(await count(client, "SELECT COUNT(*) AS n FROM sandbox_credentials WHERE platform = 'github'")).toBe(1);
  });

  it("v-mid:部分 addColumn 已应用 → 收敛到黄金 schema,探针无损", async () => {
    const client = getDocumentsClient();

    await buildMid(client);
    const r = await runMigrations();
    expect(r.appliedIds).toEqual([1, 2, 3]);
    expect(await captureSchema(client)).toEqual(golden);

    const doc = await client.execute("SELECT * FROM documents WHERE id = 'doc-mid'");
    expect(String(doc.rows[0]?.doc_pm)).toBe('{"type":"doc"}');
    expect(String(doc.rows[0]?.content_hash)).toBe("hash-mid");
    expect(String(doc.rows[0]?.doc_format)).toBe("legacy_sections"); // 新加列默认
    const draft = await client.execute("SELECT * FROM document_drafts WHERE doc_id = 'doc-mid'");
    expect(String(draft.rows[0]?.review_batch_id)).toBe("rb-1");
    expect(draft.rows[0]?.source_stream_id).toBeNull(); // 新加列默认 NULL
  });

  it("v-current:现网完整形态但无账本 → baseline 幂等跑过并记账,探针无损", async () => {
    const client = getDocumentsClient();

    // 用 baseline 自身建出完整现网形态,再抹掉账本模拟"无 schema_migrations 的存量库"。
    await runMigrations(MIGRATIONS.slice(0, 2));
    await client.execute(
      `INSERT INTO documents (id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version, doc_format, version, created_at, updated_at)
       VALUES ('doc-cur', 'thr-cur', 'user-1', '现网文档', 'editing', 5, 5, 'pm', 5, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')`,
    );
    await client.execute("DROP TABLE schema_migrations");
    __resetMigrationsForTest();

    const r = await runMigrations();
    expect(r.appliedIds).toEqual([1, 2, 3]);
    expect(await captureSchema(client)).toEqual(golden);
    expect(await ledgerIds(client)).toEqual([1, 2, 3]);
    expect(await count(client, "SELECT COUNT(*) AS n FROM documents WHERE id = 'doc-cur'")).toBe(1);
  });

  it("v-migrated:已有账本且 baseline 已记账 → 重跑无操作,schema/探针稳定", async () => {
    const client = getDocumentsClient();

    await runMigrations();
    await client.execute(
      `INSERT INTO documents (id, thread_id, resource_id, title, doc_state, doc_version, last_synced_version, doc_format, version, created_at, updated_at)
       VALUES ('doc-mig', 'thr-mig', 'user-1', '已迁移文档', 'editing', 1, 1, 'pm', 1, '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z')`,
    );
    __resetMigrationsForTest();

    const r = await runMigrations();
    expect(r.appliedIds).toEqual([]); // 无未应用迁移
    expect(r.backupPath).toBeNull(); // 无 pending → 不备份
    expect(await captureSchema(client)).toEqual(golden);
    expect(await ledgerIds(client)).toEqual([1, 2, 3]);
    expect(await count(client, "SELECT COUNT(*) AS n FROM documents WHERE id = 'doc-mig'")).toBe(1);
  });
});
