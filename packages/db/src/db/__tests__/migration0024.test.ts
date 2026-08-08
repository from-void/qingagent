import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import {
  getMaxDocumentSnapshotVersion,
  listVersions,
} from "../documentVersionRepo.js";
import { __resetMigrationsForTest, runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import {
  migration0024DocumentRestoreLineageAndOpsIndex,
} from "../migrations/0024_document_restore_lineage_and_ops_index.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

describe("0024 document restore lineage and ops index", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-migration-0024-");
  });

  afterEach(() => {
    __resetMigrationsForTest();
    db.cleanup();
  });

  it("回填旧 0023 嫁接血缘并阻止高低两方向异家族快照覆盖当前正文", async () => {
    await runMigrations(MIGRATIONS.slice(0, 23));
    const client = getDocumentsClient();
    await client.execute("CREATE TABLE documents_quarantine_0002 AS SELECT * FROM documents WHERE 0");
    await client.execute("CREATE TABLE document_versions_quarantine_0002 AS SELECT * FROM document_versions WHERE 0");

    await insertCurrentDocument("current-low", "thread-low", 1, "CURRENT-LOW");
    await insertCurrentDocument("current-high", "thread-high", 5, "CURRENT-HIGH");
    await insertForeignVersion("current-low", "source-low", "thread-low", 5, "QUARANTINED-HIGH");
    await insertForeignVersion("current-high", "source-high", "thread-high", 2, "QUARANTINED-LOW");

    __resetMigrationsForTest();
    const result = await runMigrations(MIGRATIONS.slice(0, 24));
    expect(result.appliedIds).toEqual([24]);

    const origins = await client.execute(`
      SELECT version_id, restored_doc_id, source_doc_id, source_thread_id
      FROM document_version_restore_origins
      ORDER BY restored_doc_id
    `);
    expect(origins.rows).toMatchObject([
      {
        version_id: "version-current-high-foreign-2",
        restored_doc_id: "current-high",
        source_doc_id: "source-high",
        source_thread_id: "thread-high",
      },
      {
        version_id: "version-current-low-foreign-5",
        restored_doc_id: "current-low",
        source_doc_id: "source-low",
        source_thread_id: "thread-low",
      },
    ]);
    await expect(getMaxDocumentSnapshotVersion("current-low")).resolves.toBeNull();
    await expect(listVersions("current-low")).resolves.toEqual([]);

    await expect(readCurrent("current-low")).resolves.toEqual({
      docVersion: 1,
      text: "CURRENT-LOW",
    });
    await expect(readCurrent("current-high")).resolves.toEqual({
      docVersion: 5,
      text: "CURRENT-HIGH",
    });

    // migration up 自身也可重复执行，不重复血缘记录或索引。
    await migration0024DocumentRestoreLineageAndOpsIndex.up(client);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM document_version_restore_origins",
    )).rows[0]?.n)).toBe(2);
  });

  it("创建 (doc_id,to_version) 复合索引并被版本查询计划命中", async () => {
    await runMigrations(MIGRATIONS.slice(0, 24));
    const client = getDocumentsClient();
    const indexes = await client.execute("PRAGMA index_list(document_ops)");
    expect(indexes.rows.map((row) => String(row.name))).toContain(
      "idx_document_ops_doc_to_version",
    );

    const plan = await client.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM document_ops WHERE doc_id = 'doc' AND to_version = 9",
    );
    expect(plan.rows.map((row) => String(row.detail)).join("\n")).toContain(
      "idx_document_ops_doc_to_version",
    );
  });

  async function insertCurrentDocument(
    docId: string,
    threadId: string,
    docVersion: number,
    text: string,
  ): Promise<void> {
    const client = getDocumentsClient();
    await client.execute({
      sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', ?, ?, ?, 1, ?, 'pm', ?,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'main')`,
      args: [
        docId,
        threadId,
        text,
        docVersion,
        docVersion,
        pmJson(text, `${docId}-p`),
        `hash-${docId}-${docVersion}`,
        docVersion,
      ],
    });
  }

  async function insertForeignVersion(
    restoredDocId: string,
    sourceDocId: string,
    sourceThreadId: string,
    docVersion: number,
    text: string,
  ): Promise<void> {
    const client = getDocumentsClient();
    const versionId = `version-${restoredDocId}-foreign-${docVersion}`;
    const snapshotPm = pmJson(text, `${sourceDocId}-p`);
    const contentHash = `hash-${sourceDocId}-${docVersion}`;
    await client.execute({
      sql: `INSERT INTO documents_quarantine_0002 (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', ?, ?, ?, 1, ?, 'pm', ?,
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'main')`,
      args: [
        sourceDocId,
        sourceThreadId,
        text,
        docVersion,
        docVersion,
        snapshotPm,
        contentHash,
        docVersion,
      ],
    });
    const values = [
      versionId,
      sourceDocId,
      docVersion,
      contentHash,
      snapshotPm,
    ] as const;
    await client.execute({
      sql: `INSERT INTO document_versions_quarantine_0002 (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (?, ?, ?, ?, 1, 'agent', '隔离版本', ?, NULL,
        '2026-07-01T00:00:00.000Z')`,
      args: [...values],
    });
    await client.execute({
      sql: `INSERT INTO document_versions (
        version_id, doc_id, doc_version, content_hash, schema_version,
        actor_type, summary, snapshot_pm, parent_version, created_at
      ) VALUES (?, ?, ?, ?, 1, 'agent', '0023 旧实现错误嫁接', ?, NULL,
        '2026-07-01T00:00:00.000Z')`,
      args: [versionId, restoredDocId, docVersion, contentHash, snapshotPm],
    });
  }

  async function readCurrent(docId: string): Promise<{
    docVersion: number;
    text: string;
  }> {
    const row = (await getDocumentsClient().execute({
      sql: "SELECT doc_version, doc_pm FROM documents WHERE id = ?",
      args: [docId],
    })).rows[0]!;
    const doc = JSON.parse(String(row.doc_pm)) as {
      content: Array<{ content: Array<{ text: string }> }>;
    };
    return {
      docVersion: Number(row.doc_version),
      text: doc.content[0]!.content[0]!.text,
    };
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
