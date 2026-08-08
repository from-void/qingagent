import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPmContentHash,
} from "@qingagent/pm-schema";
import {
  getDocumentsClient,
} from "../documentsClient.js";
import { ensureMigrated, __resetMigrationsForTest } from "../migrations.js";
import {
  documentRepo,
  parsePmDoc,
} from "../documentRepo.js";
import {
  documentInput,
  pmDocFromText,
  prepareTempDocumentsDb,
  section,
  type TempDocumentsDb,
} from "./dbTestUtils.js";

let tempDb: TempDocumentsDb;

beforeEach(() => {
  tempDb = prepareTempDocumentsDb("qingagent-documents-pm-");
});

afterEach(() => {
  tempDb.cleanup();
});

// 模拟线上老库的旧建表语句:含已退役的 doc_sections 死列(治理批次8-C 之前的形态),
// 用于验证 baseline 启动迁移会把它 DROP 掉。
async function createOldDocumentsTable(): Promise<void> {
  const client = getDocumentsClient();
  await client.execute(
    `CREATE TABLE documents (
      id                   TEXT    PRIMARY KEY,
      thread_id            TEXT    NOT NULL UNIQUE,
      resource_id          TEXT    NOT NULL,
      title                TEXT    NOT NULL DEFAULT '',
      doc_state            TEXT    NOT NULL,
      doc_version          INTEGER NOT NULL DEFAULT 0,
      last_synced_version  INTEGER NOT NULL DEFAULT 0,
      doc_sections         TEXT    NOT NULL DEFAULT '[]',
      version              INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL
    )`,
  );
}

async function insertOldDocument(id: string, legacySectionsJson: string): Promise<void> {
  const client = getDocumentsClient();
  await client.execute({
    sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_sections, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      `thread-${id}`,
      "qingagent-user",
      `title-${id}`,
      "editing",
      3,
      2,
      legacySectionsJson,
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ],
  });
}

describe("documentRepo PM canonical shadow", () => {
  it("upgrades an old documents schema idempotently and quarantines rows without PM", async () => {
    await createOldDocumentsTable();
    await insertOldDocument("legacy-doc", JSON.stringify([section("旧正文")]));

    const client = getDocumentsClient();
    await ensureMigrated();
    __resetMigrationsForTest();
    await ensureMigrated();

    const columns = await client.execute("PRAGMA table_info(documents)");
    const columnNames = columns.rows.map((row) => String(row.name));
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "doc_pm",
        "doc_schema_version",
        "content_hash",
        "doc_format",
      ]),
    );
    // 老库的 doc_sections 死列应被启动迁移 DROP 掉
    expect(columnNames).not.toContain("doc_sections");

    await expect(documentRepo.load("legacy-doc")).resolves.toBeNull();
    const quarantined = await client.execute(
      "SELECT id, reason FROM documents_quarantine_invalid_pm WHERE id = 'legacy-doc'",
    );
    expect(quarantined.rows).toMatchObject([{ id: "legacy-doc", reason: "missing_pm" }]);
  });

  it("writes PM as source (doc_sections column retired)", async () => {
    const pmDoc = pmDocFromText("PM 正文");
    await documentRepo.save(
      documentInput("pm-doc", {
        legacySections: [section("旧镜像不应成为源")],
        pmDoc,
      }),
    );

    const client = getDocumentsClient();
    const raw = await client.execute({
      sql: "SELECT doc_pm, content_hash, doc_schema_version, doc_format FROM documents WHERE id = ?",
      args: ["pm-doc"],
    });
    const row = raw.rows[0];
    expect(row?.doc_pm).toEqual(expect.any(String));
    const storedPm = parsePmDoc(row?.doc_pm);
    expect(storedPm).toEqual(pmDoc);
    expect(row?.content_hash).toBe(getPmContentHash(pmDoc));
    expect(row?.doc_schema_version).toBe(1);
    expect(row?.doc_format).toBe("pm");

    const loaded = await documentRepo.load("pm-doc");
    expect(loaded?.legacySections).toEqual([section("PM 正文")]);
    expect(loaded?.contentHash).toBe(getPmContentHash(pmDoc));
  });

  it("quarantines missing PM even when legacy doc_sections existed", async () => {
    await createOldDocumentsTable();
    await insertOldDocument("bad-sections", "{}");
    await ensureMigrated();

    await expect(documentRepo.load("bad-sections")).resolves.toBeNull();
  });

  it("quarantines invalid stored PM instead of falling back to doc_sections", async () => {
    await documentRepo.save(documentInput("bad-pm"));
    const client = getDocumentsClient();
    await client.execute({
      sql: "UPDATE documents SET doc_pm = ? WHERE id = ?",
      args: [
        JSON.stringify({
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [
            {
              type: "image",
              attrs: { blockId: "img-1", src: "blob:local" },
            },
          ],
        }),
        "bad-pm",
      ],
    });

    await expect(documentRepo.load("bad-pm")).resolves.toBeNull();
  });

});
