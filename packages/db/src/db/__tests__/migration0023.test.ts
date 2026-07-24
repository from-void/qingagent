import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { __resetMigrationsForTest, runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import {
  repairStoredDocumentRows,
} from "../documentRepo.js";
import {
  restoreQuarantinedDocumentFamilies0002,
} from "../migrations/0023_restore_quarantine_0002.js";
import { runQuarantine0002Recovery } from "../quarantine0002Recovery.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

describe("0023 restore quarantine 0002", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-migration-0023-");
  });

  afterEach(() => {
    __resetMigrationsForTest();
    db.cleanup();
  });

  it("RF4: 全新库无隔离表时安全记账且恢复命令幂等空操作", async () => {
    const client = getDocumentsClient();
    const result = await runMigrations();

    expect(result.appliedIds.at(-1)).toBe(25);
    await expect(restoreQuarantinedDocumentFamilies0002(client)).resolves.toMatchObject({
      eligibleDocuments: 0,
      restoredDocuments: 0,
    });
  });

  it("RF4: 已跑旧 0002 但无隔离表的库升级不改业务数据", async () => {
    const client = getDocumentsClient();
    await runMigrations(MIGRATIONS.slice(0, 22));
    await client.execute(
      `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (
        'old-doc', 'old-thread', 'qingagent-user', '旧库正文', 'editing', 1,
        1, '{"type":"doc","content":[]}', 1, 'hash', 'pm', 1,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'main'
      )`,
    );
    __resetMigrationsForTest();

    const result = await runMigrations();

    expect(result.appliedIds).toEqual([23, 24, 25]);
    const row = await client.execute("SELECT title FROM documents WHERE id = 'old-doc'");
    expect(row.rows[0]?.title).toBe("旧库正文");
  });

  it("RF4/F13: 无保险丝 0002 隔离家族按现存 thread 恢复，异 docId 主行冲突时只保留隔离子表", async () => {
    const client = getDocumentsClient();
    await runMigrations(MIGRATIONS.slice(0, 22));
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute("INSERT INTO mastra_threads(id) VALUES ('thread-conflict'), ('thread-direct')");
    await create0002QuarantineTables();
    await insertQuarantinedFamily("quarantine-conflict", "thread-conflict", "冲突隔离正文");
    await insertQuarantinedFamily("quarantine-direct", "thread-direct", "直接恢复正文");
    await insertQuarantinedFamily("quarantine-orphan", "thread-missing", "不应恢复正文");
    await client.execute(
      `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (
        'metadata-doc', 'thread-conflict', 'qingagent-user', 'metadata 回填正文',
        'editing', 9, 9, '{"type":"doc","content":[]}', 1, 'metadata-hash',
        'pm', 9, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'main'
      )`,
    );
    __resetMigrationsForTest();

    const result = await runMigrations();

    expect(result.appliedIds).toEqual([23, 24, 25]);
    const documents = await client.execute(
      "SELECT id, thread_id, title, role FROM documents ORDER BY thread_id",
    );
    expect(documents.rows).toMatchObject([
      { id: "metadata-doc", thread_id: "thread-conflict", title: "metadata 回填正文", role: "main" },
      { id: "quarantine-direct", thread_id: "thread-direct", title: "直接恢复正文", role: "main" },
    ]);
    const drafts = await client.execute(
      "SELECT doc_id, thread_id, batch_id FROM document_drafts ORDER BY doc_id",
    );
    expect(drafts.rows).toMatchObject([
      { doc_id: "quarantine-direct", thread_id: "thread-direct", batch_id: "legacy" },
    ]);
    const suggestions = await client.execute(
      `SELECT doc_id, batch_id, kind, severity
        FROM document_suggestions ORDER BY doc_id`,
    );
    expect(suggestions.rows).toMatchObject([
      { doc_id: "quarantine-direct", batch_id: "legacy", kind: "revision", severity: null },
    ]);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_versions WHERE doc_id = 'metadata-doc'",
    )).rows[0]?.n)).toBe(0);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_ops WHERE doc_id = 'metadata-doc'",
    )).rows[0]?.n)).toBe(0);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_versions_quarantine_0002 WHERE doc_id = 'quarantine-conflict'",
    )).rows[0]?.n)).toBe(1);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM documents WHERE thread_id = 'thread-missing'",
    )).rows[0]?.n)).toBe(0);

    const second = await runQuarantine0002Recovery();
    expect(second).toMatchObject({
      eligibleDocuments: 2,
      restoredDocuments: 0,
      preservedCurrentDocuments: 2,
      restoredDrafts: 1,
      restoredSuggestions: 1,
      restoredOps: 1,
      restoredVersions: 1,
    });
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_versions WHERE doc_id = 'metadata-doc'",
    )).rows[0]?.n)).toBe(0);
  });

  it.each([
    { label: "隔离版本高于当前版本", currentVersion: 1, quarantinedVersion: 5 },
    { label: "隔离版本低于当前版本", currentVersion: 5, quarantinedVersion: 1 },
  ])("$label 时 0025 隔离异 docId 子表，巡检后当前正文不变", async ({
    currentVersion,
    quarantinedVersion,
  }) => {
    const client = getDocumentsClient();
    await runMigrations(MIGRATIONS.slice(0, 22));
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute("INSERT INTO mastra_threads(id) VALUES ('thread-family-conflict')");
    await create0002QuarantineTables();
    await insertQuarantinedFamily(
      "quarantined-family",
      "thread-family-conflict",
      "隔离正文",
    );
    const currentPm = pmJson("CURRENT", "current-p");
    const quarantinedPm = pmJson("QUARANTINED", "quarantined-p");
    await client.execute({
      sql: `UPDATE documents_quarantine_0002
        SET doc_version = ?, version = ?, doc_pm = ?, content_hash = 'quarantined-hash'
        WHERE id = 'quarantined-family'`,
      args: [quarantinedVersion, quarantinedVersion, quarantinedPm],
    });
    await client.execute({
      sql: `UPDATE document_versions_quarantine_0002
        SET doc_version = ?, snapshot_pm = ?, content_hash = 'quarantined-hash'
        WHERE doc_id = 'quarantined-family'`,
      args: [quarantinedVersion, quarantinedPm],
    });
    await client.execute({
      sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (
        'current-family', 'thread-family-conflict', 'qingagent-user', '当前正文',
        'editing', ?, ?, ?, 1, 'current-hash', 'pm', ?,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'main'
      )`,
      args: [currentVersion, currentVersion, currentPm, currentVersion],
    });
    __resetMigrationsForTest();

    await runMigrations();
    const stats = await repairStoredDocumentRows();

    expect(stats.versionPointersRepaired).toBe(0);
    const current = await client.execute(
      "SELECT doc_version, doc_pm FROM documents WHERE id = 'current-family'",
    );
    expect(Number(current.rows[0]?.doc_version)).toBe(currentVersion);
    expect(JSON.parse(String(current.rows[0]?.doc_pm))).toEqual(JSON.parse(currentPm));
    for (const table of [
      "document_drafts",
      "document_suggestions",
      "document_ops",
      "document_versions",
    ]) {
      expect(Number((await client.execute(
        `SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = 'current-family'`,
      )).rows[0]?.n)).toBe(0);
      expect(Number((await client.execute(
        `SELECT COUNT(*) AS n FROM ${table}_quarantine_0002 WHERE doc_id = 'quarantined-family'`,
      )).rows[0]?.n)).toBe(1);
    }
  });

  async function create0002QuarantineTables(): Promise<void> {
    const client = getDocumentsClient();
    for (const table of [
      "documents",
      "document_drafts",
      "document_suggestions",
      "document_ops",
      "document_versions",
    ]) {
      await client.execute(
        `CREATE TABLE ${table}_quarantine_0002 AS SELECT * FROM ${table} WHERE 0`,
      );
    }
    await client.execute("ALTER TABLE documents_quarantine_0002 DROP COLUMN role");
    await client.execute("ALTER TABLE document_drafts_quarantine_0002 DROP COLUMN batch_id");
    for (const column of ["batch_id", "kind", "note", "origin", "group_id", "group_meta_json", "severity"]) {
      await client.execute(`ALTER TABLE document_suggestions_quarantine_0002 DROP COLUMN ${column}`);
    }
  }

  async function insertQuarantinedFamily(
    docId: string,
    threadId: string,
    title: string,
  ): Promise<void> {
    const client = getDocumentsClient();
    const now = "2026-07-02T00:00:00.000Z";
    await client.execute({
      sql: `INSERT INTO documents_quarantine_0002 (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', 2, 2,
        '{"type":"doc","content":[]}', 1, 'old-hash', 'pm', 2, ?, ?)`,
      args: [docId, threadId, title, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_drafts_quarantine_0002 (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at
      ) VALUES (?, ?, 2, 'base-hash', '{"type":"doc","content":[]}',
        'pending_review', NULL, NULL, NULL, 'stream', 'tool', ?, ?)`,
      args: [docId, threadId, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_suggestions_quarantine_0002 (
        id, doc_id, base_version, status, anchor_json, steps_json,
        preview_json, summary, conflict_json, created_at, updated_at
      ) VALUES (?, ?, 2, 'reviewing', '{}', '[]', '{}', '旧建议', NULL, ?, ?)`,
      args: [`suggestion-${docId}`, docId, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_ops_quarantine_0002 (
        op_id, doc_id, op_kind, client_mutation_id, steps, from_version,
        to_version, actor_type, created_at
      ) VALUES (?, ?, 'edit', ?, '[]', 1, 2, 'agent', ?)`,
      args: [`op-${docId}`, docId, `mutation-${docId}`, now],
    });
    await client.execute({
      sql: `INSERT INTO document_versions_quarantine_0002 (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (?, ?, 2, 'old-hash', 1, 'agent', '旧版本',
        '{"type":"doc","content":[]}', 1, ?)`,
      args: [`version-${docId}`, docId, now],
    });
  }

  function pmJson(text: string, blockId: string): string {
    return JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{
        type: "paragraph",
        attrs: { blockId },
        content: [{ type: "text", text }],
      }],
    });
  }
});
