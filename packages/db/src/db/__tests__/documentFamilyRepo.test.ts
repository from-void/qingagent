import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { getStablePmJson } from "@qingagent/pm-schema";
import { getDocumentsClient } from "../documentsClient.js";
import { deleteDocumentFamily } from "../documentFamilyRepo.js";
import { ensureMigrated, runMigrations } from "../migrations.js";
import { migration0001Baseline } from "../migrations/0001_baseline.js";
import { MIGRATIONS } from "../migrations/index.js";
import { prepareTempDocumentsDb, pmDocFromText, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-document-family-");
});

afterEach(() => {
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
  it("清理 thread 已不存在的 documents 全家桶,保留非孤儿", async () => {
    const client = getDocumentsClient();
    await runMigrations([migration0001Baseline]);
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute("INSERT INTO mastra_threads (id) VALUES ('alive-thread')");
    await seedFamily(client, "alive-doc", "alive-thread");
    await seedFamily(client, "orphan-doc", "missing-thread");

    const result = await runMigrations();

    expect(result.appliedIds).toEqual(MIGRATIONS.filter((migration) => migration.id > 1).map((migration) => migration.id));
    expect(await familyCount(client, "orphan-doc", "missing-thread")).toBe(0);
    expect(await familyCount(client, "alive-doc", "alive-thread")).toBe(5);
  });
});
