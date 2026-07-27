import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { __resetMigrationsForTest, runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import {
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

describe("0032 client message 幂等在途状态", () => {
  let db: TempDocumentsDb;

  beforeEach(() => {
    db = prepareTempDocumentsDb("qa-migration-0032-");
  });

  afterEach(() => {
    __resetMigrationsForTest();
    db.cleanup();
  });

  it("为旧记录补齐 last_touched 并按已完成状态迁移", async () => {
    await runMigrations(MIGRATIONS.slice(0, 31));
    const client = getDocumentsClient();
    await client.execute({
      sql: `INSERT INTO client_message_idempotency (
          id, session_id, message_id, created_at
        ) VALUES (?, ?, ?, ?)`,
      args: ["legacy", "session-legacy", "message-legacy", 1_000],
    });

    await expect(runMigrations()).resolves.toMatchObject({
      appliedIds: [32],
    });
    const result = await client.execute(
      `SELECT last_touched, completed_at
        FROM client_message_idempotency
        WHERE id = 'legacy'`,
    );
    expect(result.rows[0]).toMatchObject({
      last_touched: 1_000,
      completed_at: 1_000,
    });
  });
});
