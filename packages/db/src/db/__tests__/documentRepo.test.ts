import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import { getPmContentHash, legacySectionsToPm } from "@qingagent/pm-schema";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
  getTxnClient,
} from "../documentsClient.js";
import { ensureMigrated, __resetMigrationsForTest } from "../migrations.js";
import {
  documentRepo,
  isMissingMastraThreadsTableError,
  loadMainDocumentByThread,
  repairStoredDocumentRows,
  type DocumentSaveInput,
} from "../documentRepo.js";
import { insertVersion } from "../documentVersionRepo.js";

let tempDir: string;

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function input(id: string, overrides: Partial<DocumentSaveInput> = {}): DocumentSaveInput {
  const legacySections = overrides.legacySections ?? [section(`body-${id}`)];
  return {
    id,
    threadId: id,
    resourceId: "qingagent-user",
    title: `title-${id}`,
    docState: "draft",
    docVersion: 1,
    lastSyncedVersion: 1,
    legacySections,
    pmDoc: overrides.pmDoc ?? legacySectionsToPm(legacySections as never),
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-documents-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "documents.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
});

afterEach(() => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  delete process.env.DATABASE_URL;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("documentRepo", () => {
  it("ensures the documents table idempotently", async () => {
    await ensureMigrated();
    await ensureMigrated();

    const client = getDocumentsClient();
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("saves, loads, and upserts documents", async () => {
    await documentRepo.save(input("doc-1"));
    const first = await documentRepo.load("doc-1");

    expect(first?.title).toBe("title-doc-1");
    expect(first?.legacySections).toEqual([section("body-doc-1")]);
    expect(first?.version).toBe(1);

    await documentRepo.save(
      input("doc-1", {
        title: "updated",
        docVersion: 2,
        updatedAt: "2026-01-02T00:00:00.000Z",
        legacySections: [section("updated body")],
      }),
    );

    const updated = await documentRepo.load("doc-1");
    expect(updated?.title).toBe("updated");
    expect(updated?.docVersion).toBe(2);
    expect(updated?.legacySections).toEqual([section("updated body")]);
    expect(updated?.version).toBe(2);
    expect(updated?.createdAt).toBe(first?.createdAt);
    expect(updated?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not let stale saves regress documents.doc_version or PM content", async () => {
    await documentRepo.save(
      input("doc-monotonic", {
        docVersion: 4,
        title: "latest",
        legacySections: [section("latest body")],
      }),
    );

    await documentRepo.save(
      input("doc-monotonic", {
        docVersion: 2,
        title: "stale",
        legacySections: [section("stale body")],
      }),
    );

    const loaded = await documentRepo.load("doc-monotonic");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("latest");
    expect(loaded?.legacySections).toEqual([section("latest body")]);
  });

  it("does not bump row version for a same-version no-op shadow save", async () => {
    await documentRepo.save(
      input("doc-same-version", {
        docVersion: 4,
        title: "authoritative",
        legacySections: [section("authoritative body")],
      }),
    );

    await documentRepo.save(
      input("doc-same-version", {
        docVersion: 4,
        title: "authoritative",
        legacySections: [section("authoritative body")],
      }),
    );

    const loaded = await documentRepo.load("doc-same-version");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("authoritative");
    expect(loaded?.legacySections).toEqual([section("authoritative body")]);
    expect(loaded?.version).toBe(1);
  });

  it("updates the derived title for a same-version rename without regressing document content", async () => {
    await documentRepo.save(
      input("doc-rename", {
        title: "旧标题",
        docVersion: 4,
        legacySections: [section("保持不变的正文")],
      }),
    );

    await documentRepo.save(
      input("doc-rename", {
        title: "新标题",
        docVersion: 4,
        legacySections: [section("保持不变的正文")],
      }),
    );

    const loaded = await documentRepo.load("doc-rename");
    expect(loaded).toMatchObject({
      title: "新标题",
      docVersion: 4,
      legacySections: [section("保持不变的正文")],
      version: 1,
    });
  });

  it("已有同版本快照后仍保存同正文的标题、状态和同步指针", async () => {
    const pmDoc = legacySectionsToPm([section("已提交正文")] as never);
    await documentRepo.save(
      input("doc-metadata-after-snapshot", {
        title: "提交时标题",
        docState: "editing",
        docVersion: 4,
        lastSyncedVersion: 2,
        legacySections: [section("已提交正文")],
        pmDoc,
      }),
    );
    await insertVersion({
      versionId: "version-doc-metadata-after-snapshot-4",
      docId: "doc-metadata-after-snapshot",
      docVersion: 4,
      contentHash: getPmContentHash(pmDoc),
      schemaVersion: pmDoc.attrs.schemaVersion,
      actorType: "agent",
      summary: "提交",
      snapshotPm: pmDoc,
      parentVersion: 3,
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    await documentRepo.save(
      input("doc-metadata-after-snapshot", {
        title: "提交后标题",
        docState: "reviewing",
        docVersion: 4,
        lastSyncedVersion: 4,
        legacySections: [section("已提交正文")],
        pmDoc,
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
    );

    expect(await documentRepo.load("doc-metadata-after-snapshot")).toMatchObject({
      title: "提交后标题",
      docState: "reviewing",
      docVersion: 4,
      lastSyncedVersion: 4,
      legacySections: [section("已提交正文")],
      version: 1,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("allows same-version saves when PM content actually changes", async () => {
    await documentRepo.save(
      input("doc-same-version-content-change", {
        docVersion: 4,
        title: "before",
        legacySections: [section("before body")],
      }),
    );

    await documentRepo.save(
      input("doc-same-version-content-change", {
        docVersion: 4,
        title: "after",
        legacySections: [section("after body")],
      }),
    );

    const loaded = await documentRepo.load("doc-same-version-content-change");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("after");
    expect(loaded?.legacySections).toEqual([section("after body")]);
    expect(loaded?.version).toBe(2);
  });

  it("在后台巡检中从最新 document_versions 快照修复过期版本指针", async () => {
    const staleDoc = legacySectionsToPm([section("visible v2")] as never);
    const latestDoc = legacySectionsToPm([section("snapshot v4")] as never);
    await documentRepo.save(
      input("doc-load-desync", {
        docVersion: 2,
        legacySections: [section("visible v2")],
        pmDoc: staleDoc,
      }),
    );
    await insertVersion({
      versionId: "version-load-desync-4",
      docId: "doc-load-desync",
      docVersion: 4,
      contentHash: getPmContentHash(latestDoc),
      schemaVersion: latestDoc.attrs.schemaVersion,
      actorType: "agent",
      summary: "latest snapshot",
      snapshotPm: latestDoc,
      parentVersion: 3,
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const stats = await repairStoredDocumentRows();
    expect(stats.versionPointersRepaired).toBe(1);

    const loaded = await documentRepo.load("doc-load-desync");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.pmDoc).toEqual(latestDoc);
    expect(loaded?.legacySections).toEqual([section("snapshot v4")]);
    expect(loaded?.contentHash).toBe(getPmContentHash(latestDoc));

    const raw = await getDocumentsClient().execute({
      sql: "SELECT doc_version, content_hash, doc_pm FROM documents WHERE id = ?",
      args: ["doc-load-desync"],
    });
    expect(raw.rows[0]?.doc_version).toBe(4);
    expect(raw.rows[0]?.content_hash).toBe(getPmContentHash(latestDoc));
    expect(JSON.parse(String(raw.rows[0]?.doc_pm))).toEqual(latestDoc);
  });

  it("lists by resourceId with pagination and updated_at descending", async () => {
    await documentRepo.saveMany([
      input("doc-a", { resourceId: "r1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      input("doc-b", { resourceId: "r1", updatedAt: "2026-01-03T00:00:00.000Z" }),
      input("doc-aa", { resourceId: "r1", updatedAt: "2026-01-03T00:00:00.000Z" }),
      input("doc-c", { resourceId: "r2", updatedAt: "2026-01-04T00:00:00.000Z" }),
      input("doc-d", { resourceId: "r1", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    const page0 = await documentRepo.list({ resourceId: "r1", page: 0, perPage: 2 });
    const page1 = await documentRepo.list({ resourceId: "r1", page: 1, perPage: 2 });

    expect(page0.total).toBe(4);
    expect(page0.rows.map((row) => row.id)).toEqual(["doc-aa", "doc-b"]);
    expect(page1.rows.map((row) => row.id)).toEqual(["doc-d", "doc-a"]);
  });

  it("大资源域的两种列表查询都只拉取当前页正文", async () => {
    const documents = Array.from({ length: 120 }, (_, index) => input(
      `large-${String(index).padStart(3, "0")}`,
      {
        resourceId: "large-pages",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ));
    await documentRepo.saveMany(documents);
    const client = getDocumentsClient();
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.batch(documents.map((document) => ({
      sql: "INSERT INTO mastra_threads (id) VALUES (?)",
      args: [document.threadId],
    })), "write");
    const execute = vi.spyOn(client, "execute");

    const page = await documentRepo.list({
      resourceId: "large-pages",
      perPage: 7,
      offset: 40,
    });
    const pageWithThreads = await documentRepo.listWithExistingThreads({
      resourceId: "large-pages",
      perPage: 7,
      offset: 40,
    });

    expect(page.total).toBe(120);
    expect(page.rows.map((row) => row.id)).toEqual(
      Array.from(
        { length: 7 },
        (_, index) => `large-${String(index + 40).padStart(3, "0")}`,
      ),
    );
    expect(pageWithThreads).toEqual(page);
    const fullRowQueries = execute.mock.calls
      .map(([statement]) => (statement as unknown as { sql?: string }).sql ?? String(statement))
      .filter((sql) => /SELECT\s+d\.\*\s+FROM\s+documents d/i.test(sql));
    expect(fullRowQueries).toHaveLength(2);
    expect(fullRowQueries.every((sql) => (
      /\bLIMIT\s+\?\s+OFFSET\s+\?/i.test(sql)
    ))).toBe(true);
  });

  it("会话快照摘要只读取有界小字段并采用 thread 标题", async () => {
    await documentRepo.saveMany([
      input("summary-new", {
        resourceId: "summary-resource",
        threadId: "summary-thread-new",
        title: "文档旧标题",
        docState: "pendingReview",
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
      input("summary-old", {
        resourceId: "summary-resource",
        threadId: "summary-thread-old",
        title: "文档标题",
        docState: "editing",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    const client = getDocumentsClient();
    await client.execute(
      "CREATE TABLE mastra_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
    );
    await client.execute(
      `INSERT INTO mastra_threads (id, title) VALUES
        ('summary-thread-new', '线程新标题'),
        ('summary-thread-old', '线程旧标题')`,
    );
    const execute = vi.spyOn(client, "execute");

    const rows = await documentRepo.listSessionSummariesWithExistingThreads({
      resourceId: "summary-resource",
      limit: 1,
    });

    expect(rows).toEqual([{
      id: "summary-new",
      title: "线程新标题",
      docState: "pendingReview",
      updatedAt: "2026-07-02T00:00:00.000Z",
    }]);
    const sql = (execute.mock.calls.at(-1)?.[0] as { sql?: string } | undefined)?.sql ?? "";
    const projection = sql.split(/\bFROM\b/i)[0] ?? "";
    expect(projection).not.toContain("d.*");
    expect(projection).not.toContain("doc_pm");
    expect(sql).toMatch(/\bLIMIT\s+\?/i);
  });

  it("单行与列表读取逐行隔离坏 PM，其他文档继续可读", async () => {
    await documentRepo.saveMany([
      input("valid-row", { resourceId: "dirty-read" }),
      input("bad-load", { resourceId: "dirty-read" }),
      input("bad-thread", { resourceId: "dirty-read", threadId: "bad-thread-id" }),
      input("bad-list", { resourceId: "dirty-read" }),
    ]);
    const client = getDocumentsClient();
    await client.execute("UPDATE documents SET doc_pm = NULL WHERE id = 'bad-load'");
    await client.execute("UPDATE documents SET doc_pm = '   ' WHERE id = 'bad-thread'");
    await client.execute("UPDATE documents SET doc_pm = '{broken' WHERE id = 'bad-list'");

    await expect(documentRepo.load("bad-load")).resolves.toBeNull();
    await expect(loadMainDocumentByThread("bad-thread-id")).resolves.toBeNull();
    await expect(documentRepo.list({ resourceId: "dirty-read" })).resolves.toMatchObject({
      total: 1,
      rows: [{ id: "valid-row" }],
    });

    const quarantined = await client.execute(
      `SELECT id, reason FROM documents_quarantine_invalid_pm
        WHERE id IN ('bad-load', 'bad-thread', 'bad-list')
        ORDER BY id`,
    );
    expect(quarantined.rows).toMatchObject([
      { id: "bad-list", reason: "invalid_pm" },
      { id: "bad-load", reason: "missing_pm" },
      { id: "bad-thread", reason: "missing_pm" },
    ]);
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM documents WHERE resource_id = 'dirty-read'",
    )).rows[0]?.n)).toBe(1);
  });

  it("坏 PM 位于后续页时第一页 total 与有效行分页保持一致", async () => {
    await documentRepo.saveMany([
      input("page-valid-a", {
        resourceId: "dirty-pages",
        updatedAt: "2026-01-04T00:00:00.000Z",
      }),
      input("page-valid-b", {
        resourceId: "dirty-pages",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      input("page-invalid", {
        resourceId: "dirty-pages",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      input("page-valid-c", {
        resourceId: "dirty-pages",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const client = getDocumentsClient();
    await client.execute(
      "UPDATE documents SET doc_pm = '{broken' WHERE id = 'page-invalid'",
    );

    const first = await documentRepo.list({
      resourceId: "dirty-pages",
      page: 0,
      perPage: 2,
    });
    const second = await documentRepo.list({
      resourceId: "dirty-pages",
      page: 1,
      perPage: 2,
    });

    expect(first).toMatchObject({
      total: 3,
      rows: [{ id: "page-valid-a" }, { id: "page-valid-b" }],
    });
    expect(second).toMatchObject({
      total: 3,
      rows: [{ id: "page-valid-c" }],
    });
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM documents_quarantine_invalid_pm WHERE id = 'page-invalid'",
    )).rows[0]?.n)).toBe(1);
  });

  it("JSON 合法的深层坏 PM 随所访问页面隔离，total 单调收敛", async () => {
    await documentRepo.saveMany([
      input("deep-valid-a", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-06T00:00:00.000Z",
      }),
      input("deep-invalid-first", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-05T00:00:00.000Z",
      }),
      input("deep-valid-b", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-04T00:00:00.000Z",
      }),
      input("deep-invalid-second", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      input("deep-valid-c", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      input("deep-valid-d", {
        resourceId: "deep-dirty-pages",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const client = getDocumentsClient();
    const deepInvalidPm = JSON.stringify({
      type: "doc",
      attrs: { schemaVersion: 1 },
      content: [{ type: "unknownBlock" }],
    });
    await client.execute({
      sql: `UPDATE documents SET doc_pm = ?
        WHERE id IN ('deep-invalid-first', 'deep-invalid-second')`,
      args: [deepInvalidPm],
    });

    const first = await documentRepo.list({
      resourceId: "deep-dirty-pages",
      page: 0,
      perPage: 2,
    });
    const second = await documentRepo.list({
      resourceId: "deep-dirty-pages",
      page: 1,
      perPage: 2,
    });

    expect(first).toMatchObject({
      total: 5,
      rows: [{ id: "deep-valid-a" }, { id: "deep-valid-b" }],
    });
    expect(second).toMatchObject({
      total: 4,
      rows: [{ id: "deep-valid-c" }, { id: "deep-valid-d" }],
    });
    expect((await client.execute(
      `SELECT id FROM documents_quarantine_invalid_pm
        WHERE id IN ('deep-invalid-first', 'deep-invalid-second')
        ORDER BY id`,
    )).rows).toMatchObject([
      { id: "deep-invalid-first" },
      { id: "deep-invalid-second" },
    ]);
  });

  it("页内深层坏 PM 最多补取一轮，第二轮隔离后直接返回短页", async () => {
    await documentRepo.saveMany([
      ...Array.from({ length: 4 }, (_, index) => input(
        `bounded-invalid-${index}`,
        {
          resourceId: "bounded-dirty-page",
          updatedAt: `2026-01-0${5 - index}T00:00:00.000Z`,
        },
      )),
      input("bounded-valid", {
        resourceId: "bounded-dirty-page",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const client = getDocumentsClient();
    await client.execute({
      sql: `UPDATE documents SET doc_pm = ?
        WHERE resource_id = 'bounded-dirty-page' AND id <> 'bounded-valid'`,
      args: [JSON.stringify({
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{ type: "unknownBlock" }],
      })],
    });
    const execute = vi.spyOn(client, "execute");
    const transactionExecute = vi.spyOn(getTxnClient(), "execute");

    const result = await documentRepo.list({
      resourceId: "bounded-dirty-page",
      perPage: 2,
    });

    expect(result).toEqual({ rows: [], total: 1 });
    const sql = execute.mock.calls.map(
      ([statement]) => (statement as unknown as { sql?: string }).sql ?? String(statement),
    );
    expect(sql.filter((statement) => (
      /SELECT\s+d\.\*\s+FROM\s+documents d/i.test(statement)
    ))).toHaveLength(2);
    expect(sql.filter((statement) => (
      /SELECT\s+COUNT\(\*\)\s+AS\s+total\s+FROM\s+documents d/i.test(statement)
    ))).toHaveLength(2);
    const transactionSql = transactionExecute.mock.calls.map(
      ([statement]) => (statement as unknown as { sql?: string }).sql ?? String(statement),
    );
    expect(transactionSql.filter((statement) => statement === "BEGIN IMMEDIATE")).toHaveLength(2);
    expect(transactionSql.filter((statement) => /^\s*COMMIT\s*$/i.test(statement))).toHaveLength(2);
    expect(Number((await client.execute(
      `SELECT COUNT(*) AS n FROM documents_quarantine_invalid_pm
        WHERE id LIKE 'bounded-invalid-%'`,
    )).rows[0]?.n)).toBe(4);
  });

  it("同一资源域的多条坏 PM 合并到一次隔离事务", async () => {
    await documentRepo.saveMany([
      input("batch-valid", { resourceId: "dirty-batch" }),
      ...Array.from({ length: 30 }, (_, index) => input(
        `batch-invalid-${index}`,
        { resourceId: "dirty-batch" },
      )),
    ]);
    const client = getDocumentsClient();
    await client.execute(
      "UPDATE documents SET doc_pm = '{broken' WHERE resource_id = 'dirty-batch' AND id <> 'batch-valid'",
    );
    const transactionExecute = vi.spyOn(getTxnClient(), "execute");

    await expect(documentRepo.list({
      resourceId: "dirty-batch",
      perPage: 10,
    })).resolves.toMatchObject({
      total: 1,
      rows: [{ id: "batch-valid" }],
    });

    const transactionSql = transactionExecute.mock.calls.map(
      ([statement]) => (statement as unknown as { sql?: string }).sql ?? String(statement),
    );
    expect(transactionSql.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1);
    expect(transactionSql.filter((sql) => /^\s*COMMIT\s*$/i.test(sql))).toHaveLength(1);
    expect(transactionSql.filter((sql) => (
      /INSERT INTO documents_quarantine_invalid_pm/i.test(sql)
    ))).toHaveLength(1);
    expect(transactionSql.filter((sql) => /^\s*WITH candidates[\s\S]*DELETE FROM documents/i.test(
      sql,
    ))).toHaveLength(1);
  });

  it("按不超过 50 个 id 轻量查询存在集合", async () => {
    await documentRepo.saveMany([
      input("exists-a"),
      input("exists-b"),
      input("other-resource", { resourceId: "other-user" }),
      input("derivative"),
      input("invalid-pm"),
    ]);
    const client = getDocumentsClient();
    await client.execute({
      sql: "UPDATE documents SET role = 'derivative' WHERE id = ?",
      args: ["derivative"],
    });
    await client.execute("UPDATE documents SET doc_pm = '{broken' WHERE id = 'invalid-pm'");
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute(
      "INSERT INTO mastra_threads (id) VALUES ('exists-a'), ('exists-b'), ('other-resource'), ('derivative'), ('invalid-pm')",
    );
    const execute = vi.spyOn(client, "execute");

    const existing = await documentRepo.existsByIds("qingagent-user", [
      "exists-a",
      "missing",
      "exists-b",
      "exists-a",
      "other-resource",
      "derivative",
      "invalid-pm",
    ]);

    expect(existing).toEqual(new Set(["exists-a", "exists-b"]));
    const sql = (execute.mock.calls.at(-1)?.[0] as { sql?: string } | undefined)?.sql ?? "";
    expect(sql).toMatch(/INNER JOIN mastra_threads/i);
    expect(sql).toMatch(/resource_id = \? AND d\.role = 'main' AND d\.id IN/i);
    expect(sql).toMatch(/json_valid\(d\.doc_pm\)/i);
    expect(sql).not.toContain("*");
    await expect(documentRepo.existsByIds(
      "qingagent-user",
      Array.from({ length: 51 }, (_, index) => `id-${index}`),
    )).rejects.toThrow("最多查询 50 个 id");
  });

  it("Mastra threads 表尚未创建时按无持久 thread 处理", async () => {
    await documentRepo.save(input("pre-init-document"));

    await expect(documentRepo.existsByIds(
      "qingagent-user",
      ["pre-init-document"],
    )).resolves.toEqual(new Set());
    await expect(documentRepo.listWithExistingThreads({
      resourceId: "qingagent-user",
    })).resolves.toEqual({ rows: [], total: 0 });
    expect(isMissingMastraThreadsTableError(
      new Error("外层", {
        cause: new Error("SQLITE_ERROR: no such table: mastra_threads"),
      }),
    )).toBe(true);
    expect(isMissingMastraThreadsTableError(
      new Error("SQLITE_ERROR: no such table: documents"),
    )).toBe(false);
  });

  it("只按存在 thread 的 documents 计算 total 与分页位移", async () => {
    await documentRepo.saveMany([
      input("orphan-newest", {
        resourceId: "session-resource",
        threadId: "missing-thread",
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      input("session-b", {
        resourceId: "session-resource",
        threadId: "thread-b",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      input("session-a", {
        resourceId: "session-resource",
        threadId: "thread-a",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const client = getDocumentsClient();
    await client.execute("CREATE TABLE IF NOT EXISTS mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute(
      "INSERT INTO mastra_threads (id) VALUES ('thread-a'), ('thread-b')",
    );

    const first = await documentRepo.listWithExistingThreads({
      resourceId: "session-resource",
      perPage: 1,
      offset: 0,
    });
    const second = await documentRepo.listWithExistingThreads({
      resourceId: "session-resource",
      perPage: 1,
      offset: 1,
    });

    expect(first.total).toBe(2);
    expect(first.rows.map((row) => row.id)).toEqual(["session-b"]);
    expect(second.total).toBe(2);
    expect(second.rows.map((row) => row.id)).toEqual(["session-a"]);
  });

  it("后台巡检修复过期 PM 镜像", async () => {
    const pmDoc = legacySectionsToPm([section("镜像正文")] as never);
    await documentRepo.save(input("pm-mirror", { pmDoc }));
    await getDocumentsClient().execute({
      sql: "UPDATE documents SET content_hash = ?, doc_schema_version = ?, doc_format = ? WHERE id = ?",
      args: ["stale-hash", 0, "legacy", "pm-mirror"],
    });

    const stats = await repairStoredDocumentRows();
    expect(stats.pmMirrorsRepaired).toBe(1);
    const raw = await getDocumentsClient().execute({
      sql: "SELECT content_hash, doc_schema_version, doc_format FROM documents WHERE id = ?",
      args: ["pm-mirror"],
    });
    expect(raw.rows[0]?.content_hash).toBe(getPmContentHash(pmDoc));
    expect(raw.rows[0]?.doc_schema_version).toBe(pmDoc.attrs.schemaVersion);
    expect(raw.rows[0]?.doc_format).toBe("pm");
  });

  it("后台巡检隔离坏 PM 后继续修复其余文档", async () => {
    const validPm = legacySectionsToPm([section("继续修复")] as never);
    await documentRepo.saveMany([
      input("repair-valid", { pmDoc: validPm }),
      input("repair-invalid"),
    ]);
    const client = getDocumentsClient();
    await client.execute({
      sql: `UPDATE documents
        SET content_hash = 'stale-hash', doc_schema_version = 0, doc_format = 'legacy'
        WHERE id = 'repair-valid'`,
    });
    await client.execute(
      "UPDATE documents SET doc_pm = 'not-json' WHERE id = 'repair-invalid'",
    );

    await expect(repairStoredDocumentRows()).resolves.toMatchObject({
      scanned: 2,
      invalidRowsQuarantined: 1,
      pmMirrorsRepaired: 1,
    });
    await expect(documentRepo.load("repair-valid")).resolves.toMatchObject({
      contentHash: getPmContentHash(validPm),
    });
    expect(Number((await client.execute(
      "SELECT COUNT(*) AS n FROM documents_quarantine_invalid_pm WHERE id = 'repair-invalid'",
    )).rows[0]?.n)).toBe(1);
  });

  it("后台巡检回写前发生保存时不覆盖新正文与 hash", async () => {
    const stalePm = legacySectionsToPm([section("巡检读取的旧正文")] as never);
    const latestPm = legacySectionsToPm([section("并发保存的新正文")] as never);
    await documentRepo.save(input("pm-mirror-cas", { pmDoc: stalePm }));
    const client = getDocumentsClient();
    await client.execute({
      sql: "UPDATE documents SET content_hash = ?, doc_schema_version = ?, doc_format = ? WHERE id = ?",
      args: ["stale-hash", 0, "legacy", "pm-mirror-cas"],
    });

    const originalExecute = client.execute.bind(client);
    let savedConcurrently = false;
    vi.spyOn(client, "execute").mockImplementation(async (statement) => {
      const sql = typeof statement === "string"
        ? statement
        : (statement as unknown as { sql: string }).sql;
      if (!savedConcurrently && /UPDATE documents SET\s+doc_pm = \?/i.test(sql)) {
        savedConcurrently = true;
        await documentRepo.save(input("pm-mirror-cas", {
          docVersion: 2,
          pmDoc: latestPm,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }));
      }
      return originalExecute(statement);
    });

    const stats = await repairStoredDocumentRows();
    expect(savedConcurrently).toBe(true);
    expect(stats.pmMirrorsRepaired).toBe(0);

    const raw = await originalExecute({
      sql: "SELECT doc_version, version, content_hash, doc_pm FROM documents WHERE id = ?",
      args: ["pm-mirror-cas"],
    });
    expect(raw.rows[0]?.doc_version).toBe(2);
    expect(raw.rows[0]?.version).toBe(2);
    expect(raw.rows[0]?.content_hash).toBe(getPmContentHash(latestPm));
    expect(JSON.parse(String(raw.rows[0]?.doc_pm))).toEqual(latestPm);
  });

  it("load/list 保持纯读，且 list 不为每行追加查询", async () => {
    await documentRepo.saveMany([
      input("read-a", { resourceId: "read-resource" }),
      input("read-b", { resourceId: "read-resource" }),
    ]);
    const client = getDocumentsClient();
    const execute = vi.spyOn(client, "execute");

    await documentRepo.load("read-a");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.every(([statement]) => {
      const sql = (statement as unknown as { sql?: string }).sql ?? String(statement);
      return /^\s*SELECT\b/i.test(sql);
    })).toBe(true);

    execute.mockClear();
    await documentRepo.list({ resourceId: "read-resource" });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.every(([statement]) => {
      const sql = (statement as unknown as { sql?: string }).sql ?? String(statement);
      return /^\s*SELECT\b/i.test(sql);
    })).toBe(true);
  });
});
