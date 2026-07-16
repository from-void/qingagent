import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection } from "@qingagent/contract-ts";
import { getPmContentHash, legacySectionsToPm } from "@qingagent/pm-schema";
import {
  __resetDocumentsClientForTest,
  getDocumentsClient,
} from "../documentsClient.js";
import { ensureMigrated, __resetMigrationsForTest } from "../migrations.js";
import { documentRepo, repairStoredDocumentRows, type DocumentSaveInput } from "../documentRepo.js";
import { insertVersion } from "../documentVersionRepo.js";

let tempDir: string;

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function input(id: string, overrides: Partial<DocumentSaveInput> = {}): DocumentSaveInput {
  const legacySections = overrides.legacySections ?? [section(`body-${id}`)];
  return {
    id,
    threadId: id,
    resourceId: "qingagent-user",
    title: `title-${id}`,
    docState: "draft",
    docVersion: 1,
    lastSyncedVersion: 1,
    legacySections,
    pmDoc: overrides.pmDoc ?? legacySectionsToPm(legacySections as never),
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-documents-"));
  process.env.DATABASE_URL = `file:${join(tempDir, "documents.db")}`;
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
});

afterEach(() => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  delete process.env.DATABASE_URL;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("documentRepo", () => {
  it("ensures the documents table idempotently", async () => {
    await ensureMigrated();
    await ensureMigrated();

    const client = getDocumentsClient();
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    );
    expect(result.rows).toHaveLength(1);
  });

  it("saves, loads, and upserts documents", async () => {
    await documentRepo.save(input("doc-1"));
    const first = await documentRepo.load("doc-1");

    expect(first?.title).toBe("title-doc-1");
    expect(first?.legacySections).toEqual([section("body-doc-1")]);
    expect(first?.version).toBe(1);

    await documentRepo.save(
      input("doc-1", {
        title: "updated",
        docVersion: 2,
        updatedAt: "2026-01-02T00:00:00.000Z",
        legacySections: [section("updated body")],
      }),
    );

    const updated = await documentRepo.load("doc-1");
    expect(updated?.title).toBe("updated");
    expect(updated?.docVersion).toBe(2);
    expect(updated?.legacySections).toEqual([section("updated body")]);
    expect(updated?.version).toBe(2);
    expect(updated?.createdAt).toBe(first?.createdAt);
    expect(updated?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not let stale saves regress documents.doc_version or PM content", async () => {
    await documentRepo.save(
      input("doc-monotonic", {
        docVersion: 4,
        title: "latest",
        legacySections: [section("latest body")],
      }),
    );

    await documentRepo.save(
      input("doc-monotonic", {
        docVersion: 2,
        title: "stale",
        legacySections: [section("stale body")],
      }),
    );

    const loaded = await documentRepo.load("doc-monotonic");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("latest");
    expect(loaded?.legacySections).toEqual([section("latest body")]);
  });

  it("does not bump row version for a same-version no-op shadow save", async () => {
    await documentRepo.save(
      input("doc-same-version", {
        docVersion: 4,
        title: "authoritative",
        legacySections: [section("authoritative body")],
      }),
    );

    await documentRepo.save(
      input("doc-same-version", {
        docVersion: 4,
        title: "authoritative",
        legacySections: [section("authoritative body")],
      }),
    );

    const loaded = await documentRepo.load("doc-same-version");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("authoritative");
    expect(loaded?.legacySections).toEqual([section("authoritative body")]);
    expect(loaded?.version).toBe(1);
  });

  it("updates the derived title for a same-version rename without regressing document content", async () => {
    await documentRepo.save(
      input("doc-rename", {
        title: "旧标题",
        docVersion: 4,
        legacySections: [section("保持不变的正文")],
      }),
    );

    await documentRepo.save(
      input("doc-rename", {
        title: "新标题",
        docVersion: 4,
        legacySections: [section("保持不变的正文")],
      }),
    );

    const loaded = await documentRepo.load("doc-rename");
    expect(loaded).toMatchObject({
      title: "新标题",
      docVersion: 4,
      legacySections: [section("保持不变的正文")],
      version: 2,
    });
  });

  it("allows same-version saves when PM content actually changes", async () => {
    await documentRepo.save(
      input("doc-same-version-content-change", {
        docVersion: 4,
        title: "before",
        legacySections: [section("before body")],
      }),
    );

    await documentRepo.save(
      input("doc-same-version-content-change", {
        docVersion: 4,
        title: "after",
        legacySections: [section("after body")],
      }),
    );

    const loaded = await documentRepo.load("doc-same-version-content-change");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.title).toBe("after");
    expect(loaded?.legacySections).toEqual([section("after body")]);
    expect(loaded?.version).toBe(2);
  });

  it("在后台巡检中从最新 document_versions 快照修复过期版本指针", async () => {
    const staleDoc = legacySectionsToPm([section("visible v2")] as never);
    const latestDoc = legacySectionsToPm([section("snapshot v4")] as never);
    await documentRepo.save(
      input("doc-load-desync", {
        docVersion: 2,
        legacySections: [section("visible v2")],
        pmDoc: staleDoc,
      }),
    );
    await insertVersion({
      versionId: "version-load-desync-4",
      docId: "doc-load-desync",
      docVersion: 4,
      contentHash: getPmContentHash(latestDoc),
      schemaVersion: latestDoc.attrs.schemaVersion,
      actorType: "agent",
      summary: "latest snapshot",
      snapshotPm: latestDoc,
      parentVersion: 3,
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const stats = await repairStoredDocumentRows();
    expect(stats.versionPointersRepaired).toBe(1);

    const loaded = await documentRepo.load("doc-load-desync");
    expect(loaded?.docVersion).toBe(4);
    expect(loaded?.pmDoc).toEqual(latestDoc);
    expect(loaded?.legacySections).toEqual([section("snapshot v4")]);
    expect(loaded?.contentHash).toBe(getPmContentHash(latestDoc));

    const raw = await getDocumentsClient().execute({
      sql: "SELECT doc_version, content_hash, doc_pm FROM documents WHERE id = ?",
      args: ["doc-load-desync"],
    });
    expect(raw.rows[0]?.doc_version).toBe(4);
    expect(raw.rows[0]?.content_hash).toBe(getPmContentHash(latestDoc));
    expect(JSON.parse(String(raw.rows[0]?.doc_pm))).toEqual(latestDoc);
  });

  it("lists by resourceId with pagination and updated_at descending", async () => {
    await documentRepo.saveMany([
      input("doc-a", { resourceId: "r1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      input("doc-b", { resourceId: "r1", updatedAt: "2026-01-03T00:00:00.000Z" }),
      input("doc-c", { resourceId: "r2", updatedAt: "2026-01-04T00:00:00.000Z" }),
      input("doc-d", { resourceId: "r1", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    const page0 = await documentRepo.list({ resourceId: "r1", page: 0, perPage: 2 });
    const page1 = await documentRepo.list({ resourceId: "r1", page: 1, perPage: 2 });

    expect(page0.total).toBe(3);
    expect(page0.rows.map((row) => row.id)).toEqual(["doc-b", "doc-d"]);
    expect(page1.rows.map((row) => row.id)).toEqual(["doc-a"]);
  });

  it("后台巡检修复过期 PM 镜像", async () => {
    const pmDoc = legacySectionsToPm([section("镜像正文")] as never);
    await documentRepo.save(input("pm-mirror", { pmDoc }));
    await getDocumentsClient().execute({
      sql: "UPDATE documents SET content_hash = ?, doc_schema_version = ?, doc_format = ? WHERE id = ?",
      args: ["stale-hash", 0, "legacy", "pm-mirror"],
    });

    const stats = await repairStoredDocumentRows();
    expect(stats.pmMirrorsRepaired).toBe(1);
    const raw = await getDocumentsClient().execute({
      sql: "SELECT content_hash, doc_schema_version, doc_format FROM documents WHERE id = ?",
      args: ["pm-mirror"],
    });
    expect(raw.rows[0]?.content_hash).toBe(getPmContentHash(pmDoc));
    expect(raw.rows[0]?.doc_schema_version).toBe(pmDoc.attrs.schemaVersion);
    expect(raw.rows[0]?.doc_format).toBe("pm");
  });

  it("load/list 保持纯读，且 list 不为每行追加查询", async () => {
    await documentRepo.saveMany([
      input("read-a", { resourceId: "read-resource" }),
      input("read-b", { resourceId: "read-resource" }),
    ]);
    const client = getDocumentsClient();
    const execute = vi.spyOn(client, "execute");

    await documentRepo.load("read-a");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.every(([statement]) => {
      const sql = (statement as unknown as { sql?: string }).sql ?? String(statement);
      return /^\s*SELECT\b/i.test(sql);
    })).toBe(true);

    execute.mockClear();
    await documentRepo.list({ resourceId: "read-resource" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(([statement]) => {
      const sql = (statement as unknown as { sql?: string }).sql ?? String(statement);
      return /^\s*SELECT\b/i.test(sql);
    })).toBe(true);
  });
});
