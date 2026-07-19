import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { getStablePmJson } from "@qingagent/pm-schema";
import { getDocumentsClient } from "../documentsClient.js";
import { deleteDocumentFamily } from "../documentFamilyRepo.js";
import { ensureMigrated, runMigrations } from "../migrations.js";
import { migration0001Baseline } from "../migrations/0001_baseline.js";
import { migration0002OrphanCleanup } from "../migrations/0002_orphan_cleanup.js";
import { prepareTempDocumentsDb, pmDocFromText, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-document-family-");
});

afterEach(() => {
  vi.restoreAllMocks();
  db.cleanup();
});

async function seedFamily(
  client: Client,
  docId: string,
  threadId: string,
): Promise<void> {
  const now = "2026-07-10T00:00:00.000Z";
  const pmJson = getStablePmJson(pmDocFromText(`正文 ${docId}`));
  await client.execute({
    sql: `INSERT INTO documents (
      id, thread_id, resource_id, title, doc_state, doc_version,
      last_synced_version, doc_pm, doc_schema_version, content_hash,
      doc_format, version, created_at, updated_at
    ) VALUES (?, ?, 'qingagent-user', ?, 'editing', 1, 1, ?, 1, ?, 'pm', 1, ?, ?)`,
    args: [docId, threadId, `title-${docId}`, pmJson, `hash-${docId}`, now, now],
  });
  await client.execute({
    sql: `INSERT INTO document_drafts (
      doc_id, thread_id, base_version, base_hash, draft_pm, status,
      created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'pending_review', ?, ?)`,
    args: [docId, threadId, `hash-${docId}`, pmJson, now, now],
  });
  await client.execute({
    sql: `INSERT INTO document_suggestions (
      id, doc_id, base_version, status, anchor_json, steps_json,
      preview_json, summary, created_at, updated_at
    ) VALUES (?, ?, 1, 'reviewing', '{}', '[]', '{}', ?, ?, ?)`,
    args: [`sug-${docId}`, docId, `summary-${docId}`, now, now],
  });
  await client.execute({
    sql: `INSERT INTO document_ops (
      op_id, doc_id, op_kind, steps, from_version, to_version, actor_type, created_at
    ) VALUES (?, ?, 'replace_doc', '[]', 0, 1, 'user', ?)`,
    args: [`op-${docId}`, docId, now],
  });
  await client.execute({
    sql: `INSERT INTO document_versions (
      version_id, doc_id, doc_version, content_hash, schema_version,
      actor_type, summary, snapshot_pm, parent_version, created_at
    ) VALUES (?, ?, 1, ?, 1, 'user', ?, ?, NULL, ?)`,
    args: [`ver-${docId}`, docId, `hash-${docId}`, `version-${docId}`, pmJson, now],
  });
}

async function count(client: Client, sql: string, args: Array<string | number | null> = []): Promise<number> {
  const res = await client.execute({ sql, args });
  return Number(res.rows[0]?.n ?? 0);
}

async function familyCount(client: Client, docId: string, threadId: string): Promise<number> {
  const parts = await Promise.all([
    count(client, "SELECT COUNT(*) AS n FROM documents WHERE id = ? OR thread_id = ?", [docId, threadId]),
    count(client, "SELECT COUNT(*) AS n FROM document_drafts WHERE doc_id = ? OR thread_id = ?", [docId, threadId]),
    count(client, "SELECT COUNT(*) AS n FROM document_suggestions WHERE doc_id = ?", [docId]),
    count(client, "SELECT COUNT(*) AS n FROM document_ops WHERE doc_id = ?", [docId]),
    count(client, "SELECT COUNT(*) AS n FROM document_versions WHERE doc_id = ?", [docId]),
  ]);
  return parts.reduce((sum, n) => sum + n, 0);
}

async function quarantinedFamilyCount(client: Client, docId: string, threadId: string): Promise<number> {
  const parts = await Promise.all([
    count(client, "SELECT COUNT(*) AS n FROM documents_quarantine_0002 WHERE id = ? OR thread_id = ?", [docId, threadId]),
    count(client, "SELECT COUNT(*) AS n FROM document_drafts_quarantine_0002 WHERE doc_id = ? OR thread_id = ?", [docId, threadId]),
    count(client, "SELECT COUNT(*) AS n FROM document_suggestions_quarantine_0002 WHERE doc_id = ?", [docId]),
    count(client, "SELECT COUNT(*) AS n FROM document_ops_quarantine_0002 WHERE doc_id = ?", [docId]),
    count(client, "SELECT COUNT(*) AS n FROM document_versions_quarantine_0002 WHERE doc_id = ?", [docId]),
  ]);
  return parts.reduce((sum, n) => sum + n, 0);
}

describe("deleteDocumentFamily", () => {
  it("删除指定会话的五表全家桶,不影响另一个会话", async () => {
    await ensureMigrated();
    const client = getDocumentsClient();
    await seedFamily(client, "doc-a", "session-a");
    await seedFamily(client, "doc-b", "session-b");

    await deleteDocumentFamily("session-a");

    expect(await familyCount(client, "doc-a", "session-a")).toBe(0);
    expect(await familyCount(client, "doc-b", "session-b")).toBe(5);
  });

  it("documents 主行缺失时仍按 sessionId 兜底清掉残留子表", async () => {
    await ensureMigrated();
    const client = getDocumentsClient();
    const now = "2026-07-10T00:00:00.000Z";
    await client.execute({
      sql: `INSERT INTO document_suggestions (
        id, doc_id, base_version, status, anchor_json, steps_json,
        preview_json, summary, created_at, updated_at
      ) VALUES ('dirty-sug', 'dirty-session', 1, 'reviewing', '{}', '[]', '{}', 'dirty', ?, ?)`,
      args: [now, now],
    });

    await deleteDocumentFamily("dirty-session");

    expect(await count(client, "SELECT COUNT(*) AS n FROM document_suggestions WHERE doc_id = 'dirty-session'")).toBe(0);
  });
});

describe("migration 0002 orphan cleanup", () => {
  it("mastra_threads 为空时跳过清理并保留 documents 全家桶", async () => {
    const client = getDocumentsClient();
    await runMigrations([migration0001Baseline]);
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await seedFamily(client, "preserved-doc", "missing-thread");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runMigrations([
      migration0001Baseline,
      migration0002OrphanCleanup,
    ]);

    expect(result.appliedIds).toEqual([2]);
    expect(await familyCount(client, "preserved-doc", "missing-thread")).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("跳过 documents 孤儿清理"));
  });

  it("threads 丢失 10% 且孤儿占比 15% 时将可疑全家桶保留于隔离表", async () => {
    const client = getDocumentsClient();
    await runMigrations([migration0001Baseline]);
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    for (let index = 1; index <= 17; index += 1) {
      await seedFamily(client, `doc-${index}`, `thread-${index}`);
      await client.execute({ sql: "INSERT INTO mastra_threads (id) VALUES (?)", args: [`thread-${index}`] });
    }
    // 两个正常文档的 thread 恢复不完整（占全部预期 thread 的 10%），另有一个真实孤儿，
    // 因而 documents 侧观察到的孤儿比例为 3 / 20 = 15%。迁移无法可靠区分三者，必须全部可恢复。
    await seedFamily(client, "legit-doc-18", "lost-thread-18");
    await seedFamily(client, "legit-doc-19", "lost-thread-19");
    await seedFamily(client, "orphan-doc-20", "missing-thread-20");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runMigrations([
      migration0001Baseline,
      migration0002OrphanCleanup,
    ]);

    expect(result.appliedIds).toEqual([2]);
    expect(await familyCount(client, "legit-doc-18", "lost-thread-18")).toBe(0);
    expect(await familyCount(client, "legit-doc-19", "lost-thread-19")).toBe(0);
    expect(await familyCount(client, "orphan-doc-20", "missing-thread-20")).toBe(0);
    expect(await quarantinedFamilyCount(client, "legit-doc-18", "lost-thread-18")).toBe(5);
    expect(await quarantinedFamilyCount(client, "legit-doc-19", "lost-thread-19")).toBe(5);
    expect(await quarantinedFamilyCount(client, "orphan-doc-20", "missing-thread-20")).toBe(5);
    expect(await familyCount(client, "doc-1", "thread-1")).toBe(5);
    expect(await count(client, "SELECT COUNT(*) AS n FROM documents")).toBe(17);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("已隔离 3 个 documents 孤儿全家桶"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orphanRatio=0.150"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("*_quarantine_0002"));
  });

  it("mastra_threads 非空但孤儿占比高时提升日志级别并可恢复隔离", async () => {
    const client = getDocumentsClient();
    await runMigrations([migration0001Baseline]);
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute("INSERT INTO mastra_threads (id) VALUES ('alive-thread')");
    await seedFamily(client, "alive-doc", "alive-thread");
    await seedFamily(client, "preserved-orphan-1", "missing-thread-1");
    await seedFamily(client, "preserved-orphan-2", "missing-thread-2");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runMigrations([
      migration0001Baseline,
      migration0002OrphanCleanup,
    ]);

    expect(result.appliedIds).toEqual([2]);
    expect(await familyCount(client, "alive-doc", "alive-thread")).toBe(5);
    expect(await familyCount(client, "preserved-orphan-1", "missing-thread-1")).toBe(0);
    expect(await familyCount(client, "preserved-orphan-2", "missing-thread-2")).toBe(0);
    expect(await quarantinedFamilyCount(client, "preserved-orphan-1", "missing-thread-1")).toBe(5);
    expect(await quarantinedFamilyCount(client, "preserved-orphan-2", "missing-thread-2")).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("高比例，线程表可能不完整"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("已隔离 2 个"));
  });
});
