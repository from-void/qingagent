import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStablePmJson } from "@qingagent/pm-schema";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
} from "../documentsClient.js";
import { __resetMigrationsForTest, ensureMigrated } from "../migrations.js";
import {
  beginSessionDeletion,
  completeSessionDeletion,
  deleteSessionDatabaseRowsAndAdvance,
  deleteSessionDocumentsAndAdvance,
  findSessionDataReferences,
  getSessionDeletion,
  listSessionDeletions,
  markSessionAssetsDeleted,
  markSessionThreadsDeleted,
} from "../sessionDeletionRepo.js";
import { prepareTempDocumentsDb, pmDocFromText, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-session-deletion-");
});

afterEach(() => {
  __resetMigrationsForTest();
  db.cleanup();
});

async function seedDocument(sessionId: string): Promise<void> {
  const now = "2026-07-20T00:00:00.000Z";
  const pmJson = getStablePmJson(pmDocFromText("待删除正文"));
  await getDocumentsClient().execute({
    sql: `INSERT INTO documents (
      id, thread_id, resource_id, title, doc_state, doc_version,
      last_synced_version, doc_pm, doc_schema_version, content_hash,
      doc_format, version, created_at, updated_at
    ) VALUES (?, ?, 'qingagent-user', '待删除', 'editing', 1, 1, ?, 1, 'hash', 'pm', 1, ?, ?)`,
    args: [sessionId, sessionId, pmJson, now, now],
  });
}

describe("deleted_sessions 持久化删除阶段", () => {
  it("墓碑跨 documents client 重建仍可恢复，完成后长期保留写栅栏", async () => {
    await ensureMigrated();
    await beginSessionDeletion("persisted-delete");

    __resetDocumentsClientForTest();
    __resetMigrationsForTest();

    expect(await listSessionDeletions()).toEqual([
      expect.objectContaining({
        sessionId: "persisted-delete",
        phase: "draining",
      }),
    ]);
    await deleteSessionDocumentsAndAdvance("persisted-delete");
    await markSessionThreadsDeleted("persisted-delete");
    await deleteSessionDatabaseRowsAndAdvance("persisted-delete");
    await markSessionAssetsDeleted("persisted-delete");
    await completeSessionDeletion("persisted-delete");
    expect(await getSessionDeletion("persisted-delete")).toMatchObject({
      phase: "completed",
    });
    expect(await listSessionDeletions()).toEqual([]);
  });

  it("documents 删除与阶段推进任一步失败时整笔回滚，不留下半删中间态", async () => {
    await ensureMigrated();
    await seedDocument("atomic-delete");
    await beginSessionDeletion("atomic-delete");
    await getDocumentsClient().execute(`CREATE TRIGGER fail_deleted_session_phase
      BEFORE UPDATE OF phase ON deleted_sessions
      WHEN NEW.phase = 'documents_deleted'
      BEGIN
        SELECT RAISE(ABORT, 'phase update failed');
      END`);

    await expect(deleteSessionDocumentsAndAdvance("atomic-delete"))
      .rejects.toThrow("phase update failed");

    const documentCount = await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents WHERE thread_id = 'atomic-delete'",
    );
    expect(Number(documentCount.rows[0]?.n ?? 0)).toBe(1);
    expect(await getSessionDeletion("atomic-delete")).toMatchObject({
      phase: "draining",
    });
  });

  it("按表结构穷举清零任意 session/thread/resource 载体，且保留删除墓碑", async () => {
    const sessionId = "exhaustive-delete";
    await ensureMigrated();
    await seedDocument(sessionId);
    await getDocumentsClient().execute(`CREATE TABLE future_session_carrier (
      id TEXT PRIMARY KEY,
      related_session_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
    await getDocumentsClient().execute({
      sql: "INSERT INTO future_session_carrier (id, related_session_id, payload) VALUES (?, ?, ?)",
      args: ["future-row", sessionId, "未来新载体"],
    });
    await getDocumentsClient().execute({
      sql: `INSERT INTO llm_usage_events (
        id, session_id, call_site, model_id, key_origin,
        input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens,
        created_at
      ) VALUES ('usage-delete', ?, 'agent', 'test-model', 'none', 1, 1, 0, 0, ?)`,
      args: [sessionId, "2026-08-06T00:00:00.000Z"],
    });

    await beginSessionDeletion(sessionId);
    await deleteSessionDocumentsAndAdvance(sessionId);
    await markSessionThreadsDeleted(sessionId);
    await deleteSessionDatabaseRowsAndAdvance(sessionId, [`om-sidecar:${sessionId}`]);
    await markSessionAssetsDeleted(sessionId);
    await completeSessionDeletion(sessionId);

    await expect(findSessionDataReferences(sessionId, [`om-sidecar:${sessionId}`]))
      .resolves.toEqual([]);
    await expect(getSessionDeletion(sessionId)).resolves.toMatchObject({ phase: "completed" });
    const futureRows = await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM future_session_carrier",
    );
    expect(Number(futureRows.rows[0]?.n ?? 0)).toBe(0);
  });
});
