import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migration0037SessionResourceOwnership } from "../migrations/0037_session_resource_ownership.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0037-"); });
afterEach(() => db.cleanup());

describe("0037 session resource ownership", () => {
  it("旧 completed 墓碑重新排队补删影子线程和资源，未完成阶段原样保留", async () => {
    await runMigrations(MIGRATIONS.slice(0, 36));
    const client = getDocumentsClient();
    await client.execute(`INSERT INTO deleted_sessions(
      session_id, phase, created_at, updated_at, completed_at
    ) VALUES
      ('legacy-completed', 'completed', 'created', 'updated', 'completed'),
      ('legacy-draining', 'draining', 'created', 'updated', NULL)`);

    await migration0037SessionResourceOwnership.up(client);

    const rows = await client.execute(
      "SELECT session_id, phase, completed_at FROM deleted_sessions ORDER BY session_id",
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        session_id: "legacy-completed",
        phase: "documents_deleted",
        completed_at: null,
      }),
      expect.objectContaining({
        session_id: "legacy-draining",
        phase: "draining",
        completed_at: null,
      }),
    ]);
    const resources = await client.execute("PRAGMA table_info(session_resources)");
    expect(resources.rows.map((row) => String(row.name))).toEqual(expect.arrayContaining([
      "session_id",
      "resource_id",
      "kind",
      "ref_count",
    ]));
  });
});
