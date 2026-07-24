import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeParsePmDoc } from "@qingagent/pm-schema";
import { documentDraftRepo } from "../documentDraftRepo.js";
import {
  documentRepo,
  repairStoredDocumentRows,
} from "../documentRepo.js";
import {
  getMaxDocumentSnapshotVersion,
  getVersionSnapshot,
  listVersions,
} from "../documentVersionRepo.js";
import {
  DocumentRecoveryRequiredError,
} from "../documentWriteGuard.js";
import { getDocumentsClient } from "../documentsClient.js";
import {
  identifyQuarantine0002OverwriteCandidates,
} from "../quarantine0002Audit.js";
import { __resetMigrationsForTest, runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import {
  restoreQuarantinedDocumentFamilies0002,
} from "../migrations/0023_restore_quarantine_0002.js";
import {
  migration0025QuarantineLineageAndPmCompat,
} from "../migrations/0025_quarantine_lineage_and_pm_compat.js";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

describe("0025 quarantine lineage and PM compatibility", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-migration-0025-");
  });

  afterEach(() => {
    __resetMigrationsForTest();
    db.cleanup();
  });

  it("已跑 0023 的错误嫁接态升级后隔离四类异源行、排除高水位并阻断已覆盖正文写入", async () => {
    await runMigrations(MIGRATIONS.slice(0, 23));
    await prepareMappedFamilyFixture();
    const client = getDocumentsClient();
    const report = await restoreQuarantinedDocumentFamilies0002(client);
    expect(report).toMatchObject({
      restoredDrafts: 1,
      restoredSuggestions: 1,
      restoredOps: 1,
      restoredVersions: 1,
    });
    await overwriteCurrentWithForeignSnapshot();
    __resetMigrationsForTest();

    const migration = await runMigrations();
    expect(migration.appliedIds).toEqual([24, 25]);
    await expectActiveFamilyClean();
    await expect(getMaxDocumentSnapshotVersion("current-doc")).resolves.toBe(1);
    await expect(listVersions("current-doc")).resolves.toMatchObject([
      { versionId: "current-own-version", docVersion: 1 },
    ]);

    const block = await client.execute(`
      SELECT reason, source_doc_id, version_id
      FROM document_write_blocks
      WHERE doc_id = 'current-doc'
    `);
    expect(block.rows).toMatchObject([{
      reason: "quarantine_0002_foreign_snapshot",
      source_doc_id: "source-doc",
      version_id: "source-version",
    }]);
    await expect(identifyQuarantine0002OverwriteCandidates()).resolves.toEqual([
      expect.objectContaining({
        currentDocId: "current-doc",
        sourceDocId: "source-doc",
        versionId: "source-version",
        confidence: "exact_snapshot",
      }),
    ]);
    await expect(documentRepo.save(documentInput("current-doc", {
      threadId: "shared-thread",
      docVersion: 10,
    }))).rejects.toThrow(DocumentRecoveryRequiredError);
    await expect(documentRepo.save(documentInput("current-doc", {
      threadId: "shared-thread",
      docVersion: 10,
    }))).rejects.toThrow("从运行 0023 前的数据库备份恢复并核验");

    const postBlockPm = pmJson("异源隔离正文", "post-block-p");
    await client.execute({
      sql: `UPDATE documents
        SET doc_pm = ?, content_hash = 'post-block-stale-hash'
        WHERE id = 'current-doc'`,
      args: [postBlockPm],
    });
    await expect(repairStoredDocumentRows()).resolves.toMatchObject({
      versionPointersRepaired: 0,
      pmMirrorsRepaired: 0,
    });
    const postRepair = await client.execute(`
      SELECT doc_pm, content_hash FROM documents WHERE id = 'current-doc'
    `);
    expect(postRepair.rows[0]).toMatchObject({
      doc_pm: postBlockPm,
      content_hash: "post-block-stale-hash",
    });
    await expect(identifyQuarantine0002OverwriteCandidates()).resolves.toEqual([
      expect.objectContaining({
        currentDocId: "current-doc",
        versionId: "source-version",
        confidence: "persisted_block",
      }),
    ]);

    const beforeRepeat = await quarantineCounts();
    await client.execute({
      sql: `INSERT INTO document_drafts (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at, batch_id
      ) VALUES (
        'current-doc', 'shared-thread', 10, 'new-base', ?,
        'draft_candidate', NULL, NULL, NULL, 'new-stream', NULL, ?, ?, 'legacy'
      )`,
      args: [pmJson("后续合法草稿", "new-draft"), NOW, NOW],
    });
    await migration0025QuarantineLineageAndPmCompat.up(client);
    expect(await quarantineCounts()).toEqual(beforeRepeat);
    expect(Number((await client.execute(`
      SELECT COUNT(*) AS n FROM document_drafts
      WHERE doc_id = 'current-doc' AND base_version = 10
    `)).rows[0]?.n)).toBe(1);
  });

  it("尚未跑 0023 的库连续升级到 0025 后同样只保留当前 docId 家族", async () => {
    await runMigrations(MIGRATIONS.slice(0, 22));
    await prepareMappedFamilyFixture();
    __resetMigrationsForTest();

    const migration = await runMigrations();
    expect(migration.appliedIds).toEqual([23, 24, 25]);
    await expectActiveFamilyClean();
    await expect(getMaxDocumentSnapshotVersion("current-doc")).resolves.toBe(1);
    const blocks = await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM document_write_blocks WHERE doc_id = 'current-doc'",
    );
    expect(Number(blocks.rows[0]?.n)).toBe(0);
  });

  it("同 docId、异 threadId 仍属同一家族，合法高版本可被巡检回写", async () => {
    await runMigrations(MIGRATIONS.slice(0, 23));
    const client = getDocumentsClient();
    await client.execute(
      "CREATE TABLE documents_quarantine_0002 AS SELECT * FROM documents WHERE 0",
    );
    await client.execute(
      "CREATE TABLE document_versions_quarantine_0002 AS SELECT * FROM document_versions WHERE 0",
    );
    await insertDocument("same-doc", "thread-new", 1, pmJson("当前 v1", "same-current"));
    await client.execute({
      sql: `INSERT INTO documents_quarantine_0002 (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (
        'same-doc', 'thread-old', 'qingagent-user', '旧 thread', 'editing', 4,
        4, ?, 1, 'same-v4-hash', 'pm', 4, ?, ?, 'main'
      )`,
      args: [pmJson("合法 v4", "same-v4"), NOW, NOW],
    });
    await client.execute({
      sql: `INSERT INTO document_versions_quarantine_0002 (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES ('same-v4', 'same-doc', 4, 'same-v4-hash', 1, 'agent',
        '同 docId 旧 thread', ?, 3, ?)`,
      args: [pmJson("合法 v4", "same-v4"), NOW],
    });
    await client.execute({
      sql: `INSERT INTO document_versions (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES ('same-v4', 'same-doc', 4, 'same-v4-hash', 1, 'agent',
        '同 docId 新 thread', ?, 3, ?)`,
      args: [pmJson("合法 v4", "same-v4"), NOW],
    });
    __resetMigrationsForTest();
    await runMigrations();

    expect(await getMaxDocumentSnapshotVersion("same-doc")).toBe(4);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_versions_quarantine_0025 WHERE version_id = 'same-v4'",
    )).rows[0]?.n)).toBe(0);
    const stats = await repairStoredDocumentRows();
    expect(stats.versionPointersRepaired).toBe(1);
    await expect(documentRepo.load("same-doc")).resolves.toMatchObject({
      threadId: "thread-new",
      docVersion: 4,
    });
  });

  it("迁移先规整 doc/version/draft 的非法 listItem 首子，严格合法且所有文本与 marks 零丢失", async () => {
    await runMigrations(MIGRATIONS.slice(0, 24));
    const client = getDocumentsClient();
    const docPm = legacyListPm("doc", "heading");
    const versionPm = legacyListPm("version", "list");
    const draftPm = legacyListPm("draft", "heading");
    await insertDocument("legacy-list-doc", "legacy-list-thread", 1, docPm);
    await client.execute({
      sql: `INSERT INTO document_versions (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES ('legacy-list-version', 'legacy-list-doc', 2, 'version-hash',
        1, 'agent', 'legacy list', ?, 1, ?)`,
      args: [versionPm, NOW],
    });
    await client.execute({
      sql: `INSERT INTO document_drafts (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at, batch_id
      ) VALUES (
        'legacy-list-doc', 'legacy-list-thread', 1, 'base-hash', ?,
        'pending_review', NULL, NULL, NULL, NULL, NULL, ?, ?, 'legacy'
      )`,
      args: [draftPm, NOW, NOW],
    });
    const beforeTexts = [
      collectText(JSON.parse(docPm)),
      collectText(JSON.parse(versionPm)),
      collectText(JSON.parse(draftPm)),
    ];
    __resetMigrationsForTest();
    expect((await runMigrations()).appliedIds).toEqual([25]);

    const rows = await client.execute(`
      SELECT doc_pm AS pm FROM documents WHERE id = 'legacy-list-doc'
      UNION ALL
      SELECT snapshot_pm AS pm FROM document_versions
        WHERE version_id = 'legacy-list-version'
      UNION ALL
      SELECT draft_pm AS pm FROM document_drafts WHERE doc_id = 'legacy-list-doc'
    `);
    const migrated = rows.rows.map((row) => JSON.parse(String(row.pm)));
    expect(migrated.map((pm) => safeParsePmDoc(pm).success)).toEqual([
      true,
      true,
      true,
    ]);
    expect(migrated.map(collectText)).toEqual(beforeTexts);
    expect(JSON.stringify(migrated[0])).toContain('"marks":[{"type":"bold"}]');
    expect(JSON.stringify(migrated[1])).toContain('"type":"bulletList"');
    await expect(documentRepo.load("legacy-list-doc")).resolves.not.toBeNull();
    await expect(getVersionSnapshot("legacy-list-version")).resolves.not.toBeNull();
    await expect(documentDraftRepo.load("legacy-list-doc")).resolves.not.toBeNull();

    // 迁移遗漏/外部直写的边角仍由历史读取路径兜底，不能让整篇文档打不开。
    await client.execute({
      sql: "UPDATE documents SET doc_pm = ? WHERE id = 'legacy-list-doc'",
      args: [docPm],
    });
    await client.execute({
      sql: "UPDATE document_versions SET snapshot_pm = ? WHERE version_id = 'legacy-list-version'",
      args: [versionPm],
    });
    await client.execute({
      sql: "UPDATE document_drafts SET draft_pm = ? WHERE doc_id = 'legacy-list-doc'",
      args: [draftPm],
    });
    await expect(documentRepo.load("legacy-list-doc")).resolves.not.toBeNull();
    await expect(getVersionSnapshot("legacy-list-version")).resolves.not.toBeNull();
    await expect(documentDraftRepo.load("legacy-list-doc")).resolves.not.toBeNull();
  });

  async function prepareMappedFamilyFixture(): Promise<void> {
    const client = getDocumentsClient();
    await client.execute("CREATE TABLE IF NOT EXISTS mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute("INSERT OR IGNORE INTO mastra_threads(id) VALUES ('shared-thread')");
    await create0002QuarantineTables();
    await insertDocument("current-doc", "shared-thread", 1, pmJson("当前正文", "current-p"));
    await client.execute({
      sql: `INSERT INTO document_versions (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (
        'current-own-version', 'current-doc', 1, 'current-hash', 1,
        'user', '当前家族版本', ?, 0, ?
      )`,
      args: [pmJson("当前正文", "current-p"), NOW],
    });
    const foreignPm = pmJson("异源隔离正文", "source-p");
    await client.execute({
      sql: `INSERT INTO documents_quarantine_0002 (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at
      ) VALUES (
        'source-doc', 'shared-thread', 'qingagent-user', '异源', 'editing', 9,
        9, ?, 1, 'source-hash', 'pm', 9, ?, ?
      )`,
      args: [foreignPm, NOW, NOW],
    });
    await client.execute({
      sql: `INSERT INTO document_versions_quarantine_0002 (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (
        'source-version', 'source-doc', 9, 'source-hash', 1, 'agent',
        '异源版本', ?, 8, ?
      )`,
      args: [foreignPm, NOW],
    });
    await client.execute(`
      INSERT INTO document_ops_quarantine_0002 (
        op_id, doc_id, op_kind, client_mutation_id, steps, from_version,
        to_version, actor_type, created_at
      ) VALUES (
        'source-op', 'source-doc', 'replace_doc', 'source-mutation', NULL,
        8, 9, 'agent', '${NOW}'
      )
    `);
    await client.execute({
      sql: `INSERT INTO document_drafts_quarantine_0002 (
        doc_id, thread_id, base_version, base_hash, draft_pm, status,
        conflict_json, review_batch_id, group_mode, source_stream_id,
        source_tool_call_id, created_at, updated_at
      ) VALUES (
        'source-doc', 'shared-thread', 9, 'source-hash', ?, 'pending_review',
        NULL, NULL, NULL, 'source-stream', 'source-tool', ?, ?
      )`,
      args: [foreignPm, NOW, NOW],
    });
    await client.execute(`
      INSERT INTO document_suggestions_quarantine_0002 (
        id, doc_id, base_version, status, anchor_json, steps_json,
        preview_json, summary, conflict_json, created_at, updated_at
      ) VALUES (
        'source-suggestion', 'source-doc', 9, 'reviewing', '{}', '[]',
        '{}', '异源建议', NULL, '${NOW}', '${NOW}'
      )
    `);
  }

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
    for (const column of [
      "batch_id",
      "kind",
      "note",
      "origin",
      "group_id",
      "group_meta_json",
      "severity",
    ]) {
      await client.execute(
        `ALTER TABLE document_suggestions_quarantine_0002 DROP COLUMN ${column}`,
      );
    }
  }

  async function overwriteCurrentWithForeignSnapshot(): Promise<void> {
    await getDocumentsClient().execute({
      sql: `UPDATE documents
        SET doc_version = 9, last_synced_version = 9, doc_pm = ?,
          content_hash = 'source-hash'
        WHERE id = 'current-doc'`,
      args: [pmJson("异源隔离正文", "source-p")],
    });
  }

  async function expectActiveFamilyClean(): Promise<void> {
    const client = getDocumentsClient();
    for (const table of [
      "document_drafts",
      "document_suggestions",
      "document_ops",
    ]) {
      const result = await client.execute(
        `SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = 'current-doc'`,
      );
      expect(Number(result.rows[0]?.n), table).toBe(0);
    }
    const foreignVersions = await client.execute(`
      SELECT COUNT(*) AS n FROM document_versions
      WHERE doc_id = 'current-doc' AND version_id = 'source-version'
    `);
    expect(Number(foreignVersions.rows[0]?.n)).toBe(0);
    expect(await quarantineCounts()).toEqual({
      drafts: 1,
      suggestions: 1,
      ops: 1,
      versions: 1,
    });
  }

  async function quarantineCounts(): Promise<Record<string, number>> {
    const client = getDocumentsClient();
    const entries = await Promise.all([
      ["drafts", "document_drafts_quarantine_0025"],
      ["suggestions", "document_suggestions_quarantine_0025"],
      ["ops", "document_ops_quarantine_0025"],
      ["versions", "document_versions_quarantine_0025"],
    ].map(async ([key, table]) => {
      const result = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
      return [key, Number(result.rows[0]?.n)] as const;
    }));
    return Object.fromEntries(entries);
  }

  async function insertDocument(
    docId: string,
    threadId: string,
    docVersion: number,
    docPm: string,
  ): Promise<void> {
    await getDocumentsClient().execute({
      sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', ?, ?, ?, 1, ?, 'pm', 1,
        ?, ?, 'main')`,
      args: [
        docId,
        threadId,
        docId,
        docVersion,
        docVersion,
        docPm,
        `${docId}-hash`,
        NOW,
        NOW,
      ],
    });
  }
});

const NOW = "2026-07-24T00:00:00.000Z";

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

function legacyListPm(prefix: string, first: "heading" | "list"): string {
  const firstNode = first === "heading"
    ? {
        type: "heading",
        attrs: { blockId: `${prefix}-heading`, level: 3 },
        content: [{
          type: "text",
          text: `${prefix}-heading-text`,
          marks: [{ type: "bold" }],
        }],
      }
    : {
        type: "bulletList",
        attrs: { blockId: `${prefix}-nested-list` },
        content: [{
          type: "listItem",
          attrs: { blockId: `${prefix}-nested-item` },
          content: [{
            type: "paragraph",
            attrs: { blockId: `${prefix}-nested-p` },
            content: [{ type: "text", text: `${prefix}-nested-text` }],
          }],
        }],
      };
  return JSON.stringify({
    type: "doc",
    attrs: { schemaVersion: 1 },
    content: [{
      type: "bulletList",
      attrs: { blockId: `${prefix}-list` },
      content: [{
        type: "listItem",
        attrs: { blockId: `${prefix}-item` },
        content: [
          firstNode,
          {
            type: "paragraph",
            attrs: { blockId: `${prefix}-tail` },
            content: [{ type: "text", text: `${prefix}-tail-text` }],
          },
        ],
      }],
    }],
  });
}

function collectText(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      out.push(record.text);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return out;
}
