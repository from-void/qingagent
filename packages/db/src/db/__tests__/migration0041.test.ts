import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import {
  assertMigrationsContinuous,
  runMigrations,
} from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-migration-0041-");
});

afterEach(() => {
  db.cleanup();
});

describe("0041 clientMessageId 会话复合键", () => {
  it("注册表在 0041 后严格连续接入 0042/0043", () => {
    expect(MIGRATIONS.at(-1)?.id).toBe(43);
    expect(() => assertMigrationsContinuous(MIGRATIONS)).not.toThrow();
  });

  it("把 0040 有归属老行迁入复合主键并丢弃空归属行", async () => {
    await runMigrations(MIGRATIONS.slice(0, 40));
    const client = getDocumentsClient();
    await client.execute({
      sql: `INSERT INTO client_message_idempotency(
          id,session_id,message_id,created_at,last_touched,completed_at
        ) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)`,
      args: [
        "legacy-client-message",
        "legacy-session",
        "legacy-message",
        1_000,
        1_100,
        1_200,
        "orphan-client-message",
        "",
        "orphan-message",
        2_000,
        2_100,
        2_200,
      ],
    });

    await expect(runMigrations()).resolves.toMatchObject({ appliedIds: [41, 42, 43] });

    const rows = await client.execute(
      `SELECT id,session_id,message_id,created_at,last_touched,completed_at
       FROM client_message_idempotency`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: "legacy-client-message",
        session_id: "legacy-session",
        message_id: "legacy-message",
        created_at: 1_000,
        last_touched: 1_100,
        completed_at: 1_200,
      }),
    ]);

    const columns = await client.execute(
      "PRAGMA table_info(client_message_idempotency)",
    );
    const primaryKey = columns.rows
      .filter((row) => Number(row.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((row) => String(row.name));
    expect(primaryKey).toEqual(["session_id", "id"]);
  });
});
