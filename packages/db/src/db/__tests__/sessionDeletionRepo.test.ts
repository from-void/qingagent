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
  deleteSessionDocumentsAndAdvance,
  getSessionDeletion,
  listSessionDeletions,
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
});
