import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash, safeParsePmDoc } from "@qingagent/pm-schema";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";
import { prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";

let db: TempDocumentsDb;
beforeEach(() => { db = prepareTempDocumentsDb("qa-migration-0038-"); });
afterEach(() => db.cleanup());

function corruptedDiagramPm(x: number): string {
  return [
    '{"attrs":{"schemaVersion":1},"content":[{"attrs":{',
    '"blockId":"diagram-1","lang":"mermaid","overlay":{',
    '"edgeHandles":undefined,"edgeStyles":undefined,',
    `"positions":{"App":{"x":${x},"y":20}},`,
    '"styles":undefined},"source":"flowchart TD\\n  App[应用]",',
    '"svg":null},"type":"diagram"}],"type":"doc"}',
  ].join("");
}

async function insertDocument(id: string, threadId: string, docPm: string): Promise<void> {
  await getDocumentsClient().execute({
    sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', 3, 3, ?, 1, ?, 'pm', 2, 'old', 'new', 'main')`,
    args: [id, threadId, `标题-${id}`, docPm, `broken-hash-${id}`],
  });
}

async function insertQuarantine(id: string, threadId: string, docPm: string): Promise<void> {
  await getDocumentsClient().execute({
    sql: `INSERT INTO documents_quarantine_invalid_pm (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at, role, reason
      ) VALUES (?, ?, 'qingagent-user', ?, 'editing', 3, 3, ?, 1, ?, 'pm', 2, 'old', 'new', 'main', 'invalid_pm')`,
    args: [id, threadId, `标题-${id}`, docPm, `broken-hash-${id}`],
  });
}

describe("0038 stableStringify undefined 数据恢复", () => {
  it("修复 documents 坏行并从隔离表恢复最新可修复副本，无法验证的脏数据继续隔离", async () => {
    await runMigrations(MIGRATIONS.slice(0, 36));
    const client = getDocumentsClient();
    await client.execute("CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)");
    await client.execute(`INSERT INTO mastra_threads(id) VALUES
      ('thread-quarantined-corrupt'),
      ('thread-quarantined-truncated'),
      ('thread-deleted')`);
    await insertDocument("live-corrupt", "thread-live-corrupt", corruptedDiagramPm(10));
    await insertQuarantine("quarantined-corrupt", "thread-quarantined-corrupt", corruptedDiagramPm(10));
    await insertQuarantine("quarantined-corrupt", "thread-quarantined-corrupt", corruptedDiagramPm(30));
    await insertQuarantine(
      "quarantined-corrupt",
      "thread-quarantined-corrupt",
      corruptedDiagramPm(50).slice(0, -1),
    );
    await insertQuarantine(
      "quarantined-truncated",
      "thread-quarantined-truncated",
      corruptedDiagramPm(50).slice(0, -1),
    );
    await insertQuarantine("deleted-corrupt", "thread-deleted", corruptedDiagramPm(70));
    await client.execute(`INSERT INTO deleted_sessions(
      session_id,phase,created_at,updated_at
    ) VALUES ('thread-deleted','draining','old','new')`);

    const result = await runMigrations();

    expect(result.appliedIds).toEqual(MIGRATIONS.slice(36).map((migration) => migration.id));
    const rows = await getDocumentsClient().execute(
      `SELECT id, doc_pm, content_hash FROM documents
        WHERE id IN ('live-corrupt', 'quarantined-corrupt', 'quarantined-truncated')
        ORDER BY id`,
    );
    expect(rows.rows.map((row) => row.id)).toEqual([
      "live-corrupt",
      "quarantined-corrupt",
    ]);
    for (const row of rows.rows) {
      const raw = String(row.doc_pm);
      expect(raw).not.toContain("undefined");
      expect(() => JSON.parse(raw)).not.toThrow();
      const parsed = safeParsePmDoc(JSON.parse(raw));
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      expect(row.content_hash).toBe(getPmContentHash(parsed.data));
    }
    const restored = JSON.parse(String(rows.rows[1]?.doc_pm));
    expect(restored.content[0].attrs.overlay).toStrictEqual({
      positions: { App: { x: 30, y: 20 } },
    });
    const evidence = await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents_quarantine_invalid_pm WHERE id = 'quarantined-corrupt'",
    );
    expect(Number(evidence.rows[0]?.n)).toBe(3);
    const deleted = await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents WHERE id='deleted-corrupt'",
    );
    expect(Number(deleted.rows[0]?.n)).toBe(0);
  });
});
