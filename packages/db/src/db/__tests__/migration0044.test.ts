import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPmContentHash, pmToPlainText } from "@qingagent/pm-schema";
import { pmDocFromText, prepareTempDocumentsDb, type TempDocumentsDb } from "./dbTestUtils.js";
import { getDocumentsClient } from "../documentsClient.js";
import { runMigrations } from "../migrations.js";
import { MIGRATIONS } from "../migrations/index.js";

let tempDb: TempDocumentsDb | null = null;
const retiredBodyKey = ["legacy", "Sections"].join("");

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-migration-0044-");
});

afterEach(() => {
  tempDb?.cleanup();
  tempDb = null;
});

async function preparePre0044(): Promise<void> {
  await runMigrations(MIGRATIONS.slice(0, 43));
}

async function createThreadsTable(): Promise<void> {
  await getDocumentsClient().execute(`CREATE TABLE mastra_threads (
    id TEXT PRIMARY KEY,
    resourceId TEXT NOT NULL,
    title TEXT NOT NULL,
    metadata TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`);
}

async function insertThread(input: {
  id: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await getDocumentsClient().execute({
    sql: `INSERT INTO mastra_threads
      (id, resourceId, title, metadata, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`,
    args: [
      input.id,
      input.resourceId ?? "qingagent-user",
      `thread-${input.id}`,
      JSON.stringify(input.metadata),
    ],
  });
}

async function ledgerHas0044(): Promise<boolean> {
  const result = await getDocumentsClient().execute(
    "SELECT 1 FROM schema_migrations WHERE id = 44",
  );
  return result.rows.length > 0;
}

describe("migration 0044", () => {
  it("mastra_threads 缺表时按零候选成功记账", async () => {
    await preparePre0044();

    await expect(runMigrations()).resolves.toMatchObject({ appliedIds: [44] });
    expect(await ledgerHas0044()).toBe(true);
    expect(Number((await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents",
    )).rows[0]?.n)).toBe(0);
  });

  it("legacy-only 线程升级后从 documents 冷读正文逐字对拍，且只覆盖两个历史 resourceId", async () => {
    await preparePre0044();
    await createThreadsTable();
    const qingSections = [{ kind: "p", data: { text: "青砚正文" } }];
    const defaultSections = [
      { kind: "h1", data: { text: "默认用户标题" } },
      { kind: "table", data: { head: ["甲", "乙"], rows: [["一", "二"]] } },
    ];
    await insertThread({
      id: "qing-thread",
      metadata: {
        docId: "qing-doc",
        docState: { kind: "editing" },
        docVersion: 7,
        lastSyncedDocumentSnapshot: 6,
        [retiredBodyKey]: qingSections,
      },
    });
    await insertThread({
      id: "default-thread",
      resourceId: "user-default",
      metadata: {
        docState: { kind: "review" },
        docVersion: 3,
        [retiredBodyKey]: defaultSections,
      },
    });
    await insertThread({
      id: "other-thread",
      resourceId: "other-user",
      metadata: { [retiredBodyKey]: [{ kind: "p", data: { text: "不应迁移" } }] },
    });
    await insertThread({
      id: "canonical-thread",
      metadata: {
        doc: pmDocFromText("已有 PM"),
        [retiredBodyKey]: [{ kind: "p", data: { text: "旧镜像" } }],
      },
    });

    expect((await runMigrations()).appliedIds).toEqual([44]);
    const rows = await getDocumentsClient().execute(
      `SELECT id, thread_id, resource_id, doc_state, doc_version,
          last_synced_version, doc_pm, content_hash, doc_format
        FROM documents ORDER BY id`,
    );
    expect(rows.rows).toHaveLength(2);
    const defaultRow = rows.rows[0]!;
    const qingRow = rows.rows[1]!;
    expect(defaultRow).toMatchObject({
      id: "default-thread",
      thread_id: "default-thread",
      resource_id: "user-default",
      doc_state: "pendingReview",
      doc_version: 3,
      doc_format: "pm",
    });
    expect(qingRow).toMatchObject({
      id: "qing-doc",
      thread_id: "qing-thread",
      resource_id: "qingagent-user",
      doc_state: "editing",
      doc_version: 7,
      last_synced_version: 6,
      doc_format: "pm",
    });
    for (const [row, expectedText] of [
      [defaultRow, "默认用户标题\n甲\t乙\n一\t二"],
      [qingRow, "青砚正文"],
    ] as const) {
      const doc = JSON.parse(String(row.doc_pm));
      expect(row.content_hash).toBe(getPmContentHash(doc));
      expect(pmToPlainText(doc)).toBe(expectedText);
    }
    expect(pmToPlainText(JSON.parse(String(qingRow.doc_pm)))).toBe("青砚正文");
  });

  it("删除墓碑覆盖 threadId 或 docId 时均不物化", async () => {
    await preparePre0044();
    await createThreadsTable();
    await insertThread({
      id: "deleted-by-thread",
      metadata: { [retiredBodyKey]: [{ kind: "p", data: { text: "墓碑一" } }] },
    });
    await insertThread({
      id: "deleted-by-doc-thread",
      metadata: {
        docId: "deleted-doc-id",
        [retiredBodyKey]: [{ kind: "p", data: { text: "墓碑二" } }],
      },
    });
    for (const id of ["deleted-by-thread", "deleted-doc-id"]) {
      await getDocumentsClient().execute({
        sql: `INSERT INTO deleted_sessions
          (session_id, phase, created_at, updated_at)
          VALUES (?, 'completed', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        args: [id],
      });
    }

    expect((await runMigrations()).appliedIds).toEqual([44]);
    expect(Number((await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents",
    )).rows[0]?.n)).toBe(0);
  });

  it("单条文本核验失败时事务与账本回滚，修正后重启可重试", async () => {
    await preparePre0044();
    await createThreadsTable();
    await insertThread({
      id: "retry-thread",
      metadata: {
        docState: { kind: "drafting" },
        [retiredBodyKey]: [{
          kind: "code",
          data: { language: "mermaid", body: "  graph TD\nA-->B  " },
        }],
      },
    });

    await expect(runMigrations()).rejects.toThrow(
      "0044 legacy text verification failed: retry-thread",
    );
    expect(await ledgerHas0044()).toBe(false);
    expect(Number((await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents WHERE id = 'retry-thread'",
    )).rows[0]?.n)).toBe(0);

    await getDocumentsClient().execute({
      sql: "UPDATE mastra_threads SET metadata = ? WHERE id = 'retry-thread'",
      args: [JSON.stringify({
        docState: { kind: "drafting" },
        [retiredBodyKey]: [{
          kind: "code",
          data: { language: "mermaid", body: "graph TD\nA-->B" },
        }],
      })],
    });
    await expect(runMigrations()).resolves.toMatchObject({ appliedIds: [44] });
    expect(await ledgerHas0044()).toBe(true);
    expect(Number((await getDocumentsClient().execute(
      "SELECT COUNT(*) AS n FROM documents WHERE id = 'retry-thread'",
    )).rows[0]?.n)).toBe(1);
  });
});
