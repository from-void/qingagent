import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection, IncomingDocState } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import type { QingagentThreadMetadata } from "../../session/threadPersistence.js";
import {
  __resetDocumentsClientForTest,
  __resetMigrationsForTest,
  beginSessionDeletion,
  documentRepo,
} from "@qingagent/db";
import {
  __resetSessionPersistenceForTest,
  drainSessionPersistenceForSession,
  markSessionDeleted,
} from "../../session/threadPersistence.js";

const { memory, threads } = vi.hoisted(() => {
  const threads = new Map<string, Record<string, unknown>>();
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) => {
      return threads.get(threadId) ?? null;
    }),
    updateThread: vi.fn(
      async ({
        id,
        title,
        metadata,
      }: {
        id: string;
        title: string;
        metadata: Record<string, unknown>;
      }) => {
        const existing = threads.get(id);
        if (!existing) return;
        threads.set(id, {
          ...existing,
          title,
          metadata,
        });
      },
    ),
    listThreads: vi.fn(
      async ({
        filter,
        page,
        perPage,
      }: {
        filter: { resourceId: string };
        page: number;
        perPage: number | false;
      }) => {
        const all = Array.from(threads.values())
          .filter((thread) => thread.resourceId === filter.resourceId)
          .sort(
            (a, b) =>
              (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime(),
          );
        if (perPage === false) {
          return {
            threads: all,
            total: all.length,
            hasMore: false,
          };
        }
        const start = page * perPage;
        const pageThreads = all.slice(start, start + perPage);
        return {
          threads: pageThreads,
          total: all.length,
          hasMore: start + perPage < all.length,
        };
      },
    ),
  };
  return { memory, threads };
});

vi.mock("../../mastra.js", () => ({
  mastra: {
    getLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getMemory: () => memory,
  },
  getObservability: () => null,
}));

let tempDir: string;

function section(text: string): LegacySection {
  return { kind: "p", data: { text } };
}

function legacyDocState(kind: IncomingDocState["kind"]): QingagentThreadMetadata["docState"] {
  return { kind } as QingagentThreadMetadata["docState"];
}

function validMetadata(
  text: string,
  overrides: Partial<QingagentThreadMetadata> = {},
): QingagentThreadMetadata {
  return {
    docState: { kind: "editing" },
    docVersion: 1,
    lastSyncedDocumentSnapshot: 0,
    legacySections: [section(text)],
    materials: [],
    title: text,
    runId: null,
    toolCallId: null,
    askUserCompleted: false,
    lastPersistedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function addThread(id: string, metadata: Partial<QingagentThreadMetadata>): void {
  const offsetMs = threads.size * 1_000;
  threads.set(id, {
    id,
    title: metadata.title ?? id,
    resourceId: "qingagent-user",
    createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs),
    updatedAt: new Date(Date.parse("2026-01-02T00:00:00.000Z") + offsetMs),
    metadata,
  });
}

async function saveDocumentFromMetadata(
  threadId: string,
  metadata: QingagentThreadMetadata,
  overrides: {
    id?: string;
    docState?: string;
    title?: string;
    docVersion?: number;
    legacySections?: LegacySection[];
  } = {},
): Promise<void> {
  await documentRepo.save({
    id: overrides.id ?? metadata.docId ?? threadId,
    threadId,
    resourceId: "qingagent-user",
    title: overrides.title ?? metadata.title,
    docState: overrides.docState ?? metadata.docState.kind,
    docVersion: overrides.docVersion ?? metadata.docVersion,
    lastSyncedVersion: metadata.lastSyncedDocumentSnapshot,
    legacySections: overrides.legacySections ?? metadata.legacySections,
    pmDoc: legacySectionsToPm((overrides.legacySections ?? metadata.legacySections) as never),
    createdAt: metadata.lastPersistedAt,
    updatedAt: metadata.lastPersistedAt,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qingagent-migration-"));
  // 影子双写已恒开:DATABASE_URL 指向临时库即是隔离。
  process.env.DATABASE_URL = `file:${join(tempDir, "migration.db")}`;
  threads.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  __resetSessionPersistenceForTest();
});

afterEach(() => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  __resetSessionPersistenceForTest();
  delete process.env.DATABASE_URL;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("migrateThreadMetadataToDocuments", () => {
  it("F6: 启动回填跳过持久化墓碑中的会话", async () => {
    const meta = validMetadata("deleted-backfill", { docId: "doc-deleted-backfill" });
    addThread("thread-deleted-backfill", meta);
    await beginSessionDeletion("thread-deleted-backfill");

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ force: true });

    expect(stats.skipped).toBe(1);
    expect(stats.migrated).toBe(0);
    expect(await documentRepo.load("doc-deleted-backfill")).toBeNull();
  });

  it("F6: 删除 drain 会等待已开始的启动回填任务", async () => {
    const meta = validMetadata("drained-backfill", { docId: "doc-drained-backfill" });
    addThread("thread-drained-backfill", meta);
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    vi.spyOn(documentRepo, "saveMany").mockImplementationOnce(async () => {
      writeStarted();
      await writeGate;
    });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const migration = migrateThreadMetadataToDocuments({ force: true });
    await started;
    markSessionDeleted("thread-drained-backfill", "doc-drained-backfill");
    let drained = false;
    const drain = drainSessionPersistenceForSession("thread-drained-backfill", 1_000)
      .then(() => {
        drained = true;
      });
    const earlyState = await Promise.race([
      drain.then(() => "drained" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20)),
    ]);
    expect(earlyState).toBe("waiting");

    releaseWrite();
    await Promise.all([migration, drain]);
    expect(drained).toBe(true);
  });

  it("migrates thread metadata into documents and is idempotent", async () => {
    addThread("thread-1", {
      docId: "doc-1",
      docState: legacyDocState("draft"),
      docVersion: 2,
      lastSyncedDocumentSnapshot: 1,
      legacySections: [section("一")],
      materials: [],
      title: "一",
      runId: null,
      toolCallId: null,
      askUserCompleted: false,
      lastPersistedAt: "2026-01-01T00:00:00.000Z",
    });
    addThread("thread-2", {
      docId: "doc-2",
      docState: legacyDocState("review"),
      docVersion: 3,
      lastSyncedDocumentSnapshot: 2,
      legacySections: [section("二")],
      materials: [],
      title: "二",
      runId: null,
      toolCallId: null,
      askUserCompleted: false,
      lastPersistedAt: "2026-01-01T00:00:00.000Z",
    });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const first = await migrateThreadMetadataToDocuments({ force: true, pageSize: 1 });
    const second = await migrateThreadMetadataToDocuments({ force: true, pageSize: 2 });

    expect(first.migrated).toBe(2);
    expect(first.failed).toBe(0);
    expect(second.migrated).toBe(0);
    const listed = await documentRepo.list({ resourceId: "qingagent-user" });
    expect(listed.total).toBe(2);
    expect(await documentRepo.load("doc-1")).toMatchObject({
      threadId: "thread-1",
      docState: "editing",
      docVersion: 2,
      legacySections: [section("一")],
    });
  }, 10_000);

  it("skips startup migration only when every document matches metadata", async () => {
    const metaA = validMetadata("same-a", { docId: "doc-a", docVersion: 2 });
    const metaB = validMetadata("same-b", { docId: "doc-b", docVersion: 3 });
    addThread("thread-a", metaA);
    addThread("thread-b", metaB);
    await saveDocumentFromMetadata("thread-a", metaA);
    await saveDocumentFromMetadata("thread-b", metaB);
    const saveManySpy = vi.spyOn(documentRepo, "saveMany");

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ pageSize: 1 });

    expect(stats.migrated).toBe(0);
    expect(saveManySpy).not.toHaveBeenCalled();
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("已规范化的富文本 legacySections 与 metadata 等价时跳过启动迁移", async () => {
    const meta = validMetadata("rich-sections", {
      docId: "doc-rich-sections",
      legacySections: [
        { kind: "quote", data: { text: "引用正文" } },
        { kind: "code", data: { body: "const answer = 42;" } },
        {
          kind: "image",
          data: {
            src: "/api/v1/files/550e8400-e29b-41d4-a716-446655440000/figure.png",
            alt: "",
            caption: null,
            width: null,
            height: null,
          },
        },
      ],
    });
    addThread("thread-rich-sections", meta);
    await saveDocumentFromMetadata("thread-rich-sections", meta);
    const saveManySpy = vi.spyOn(documentRepo, "saveMany");

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(0);
    expect(saveManySpy).not.toHaveBeenCalled();
    expect(memory.updateThread).not.toHaveBeenCalled();
  });

  it("同批仅保存并标记 stale 线程，不刷新富文本等价线程", async () => {
    const stale = validMetadata("stale-current", {
      docId: "doc-stale-only",
    });
    const richEquivalent = validMetadata("rich-equivalent", {
      docId: "doc-rich-equivalent",
      legacySections: [
        { kind: "quote", data: { text: "引用正文" } },
        { kind: "code", data: { body: "const value = 1;" } },
      ],
    });
    addThread("thread-stale-only", stale);
    addThread("thread-rich-equivalent", richEquivalent);
    await saveDocumentFromMetadata("thread-stale-only", stale, {
      title: "stale-old",
    });
    await saveDocumentFromMetadata("thread-rich-equivalent", richEquivalent);
    const saveManySpy = vi.spyOn(documentRepo, "saveMany");

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ force: true });

    expect(stats.migrated).toBe(1);
    expect(saveManySpy).toHaveBeenCalledTimes(1);
    expect(saveManySpy.mock.calls[0]?.[0].map((row) => row.threadId)).toEqual([
      "thread-stale-only",
    ]);
    expect(memory.updateThread).toHaveBeenCalledTimes(1);
    expect(memory.updateThread).toHaveBeenCalledWith(expect.objectContaining({
      id: "thread-stale-only",
    }));
    expect((threads.get("thread-rich-equivalent")?.metadata as QingagentThreadMetadata)
      .migratedToDocumentsAt).toBeUndefined();
  });

  it("does not skip when legacySections have the same length but different text", async () => {
    const meta = validMetadata("aa", { docId: "doc-stale", docVersion: 5 });
    addThread("thread-stale", meta);
    await saveDocumentFromMetadata("thread-stale", meta, {
      legacySections: [section("bb")],
    });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-stale"))?.legacySections).toEqual([section("aa")]);
    const updatedMeta = threads.get("thread-stale")?.metadata as QingagentThreadMetadata;
    expect(updatedMeta.migratedToDocumentsAt).toEqual(expect.any(String));
  });

  it("does not skip when docVersion differs", async () => {
    const meta = validMetadata("versioned", { docId: "doc-version", docVersion: 7 });
    addThread("thread-version", meta);
    await saveDocumentFromMetadata("thread-version", meta, { docVersion: 6 });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-version"))?.docVersion).toBe(7);
  });

  it("does not skip when docState differs", async () => {
    const meta = validMetadata("stateful", {
      docId: "doc-state",
      docState: legacyDocState("review"),
    });
    addThread("thread-state", meta);
    await saveDocumentFromMetadata("thread-state", meta, { docState: "draft" });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-state"))?.docState).toBe("pendingReview");
  });

  it("does not skip when title differs", async () => {
    const meta = validMetadata("新标题", { docId: "doc-title" });
    addThread("thread-title", meta);
    await saveDocumentFromMetadata("thread-title", meta, { title: "旧标题" });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-title"))?.title).toBe("新标题");
  });

  it("does not skip when a document outside the first twenty rows is stale", async () => {
    const rows = Array.from({ length: 21 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      const metadata = validMetadata(`content-${suffix}`, {
        docId: `doc-${suffix}`,
        docVersion: index + 1,
      });
      addThread(`thread-${suffix}`, metadata);
      return { suffix, metadata };
    });
    for (const { suffix, metadata } of rows) {
      await saveDocumentFromMetadata(`thread-${suffix}`, metadata, suffix === "01"
        ? { title: "stale-title" }
        : {});
    }

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ pageSize: 7 });

    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-01"))?.title).toBe("content-01");
  });

  it("updatedAt 页间重排不会让最旧线程漏过启动核验", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => {
      const id = `thread-${String(index + 1).padStart(3, "0")}`;
      const metadata = validMetadata(`content-${index + 1}`, {
        docId: `doc-${String(index + 1).padStart(3, "0")}`,
      });
      addThread(id, metadata);
      return { id, metadata };
    });
    for (const { id, metadata } of rows) {
      await saveDocumentFromMetadata(id, metadata, id === "thread-001"
        ? { title: "stale-oldest" }
        : {});
    }

    let offsetPaginationCalls = 0;
    memory.listThreads.mockImplementation(async (args) => {
      const all = Array.from(threads.values())
        .filter((thread) => thread.resourceId === args.filter.resourceId)
        .sort(
          (a, b) =>
            (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime(),
        );
      if (args.perPage === false) {
        return { threads: all, total: all.length, hasMore: false };
      }
      if (args.filter.resourceId === "qingagent-user") {
        offsetPaginationCalls += 1;
        const start = args.page * args.perPage;
        const result = {
          threads: all.slice(start, start + args.perPage),
          total: all.length,
          hasMore: start + args.perPage < all.length,
        };
        if (args.page === 0) {
          const oldest = threads.get("thread-001");
          if (oldest) {
            oldest.updatedAt = new Date("2030-01-01T00:00:00.000Z");
          }
        }
        return result;
      }
      const start = args.page * args.perPage;
      return {
        threads: all.slice(start, start + args.perPage),
        total: all.length,
        hasMore: start + args.perPage < all.length,
      };
    });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ pageSize: 200 });

    expect(offsetPaginationCalls).toBe(0);
    expect(stats.migrated).toBe(1);
    expect((await documentRepo.load("doc-001"))?.title).toBe("content-1");
    expect(memory.listThreads).toHaveBeenCalledWith(expect.objectContaining({
      page: 0,
      perPage: false,
    }));
  }, 20_000);

  it("does not skip when counts match but a document row is missing", async () => {
    const metaA = validMetadata("present", { docId: "doc-present" });
    const metaB = validMetadata("missing", { docId: "doc-missing" });
    const extra = validMetadata("extra", { docId: "doc-extra" });
    addThread("thread-present", metaA);
    addThread("thread-missing", metaB);
    await saveDocumentFromMetadata("thread-present", metaA);
    await saveDocumentFromMetadata("thread-extra", extra);

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ pageSize: 1 });

    expect(stats.migrated).toBe(1);
    expect(await documentRepo.load("doc-missing")).toMatchObject({
      threadId: "thread-missing",
      legacySections: [section("missing")],
    });
  });

  it("fails open when a document load throws", async () => {
    const meta = validMetadata("load-error", { docId: "doc-load-error" });
    addThread("thread-load-error", meta);
    await saveDocumentFromMetadata("thread-load-error", meta);
    vi.spyOn(documentRepo, "load").mockRejectedValueOnce(new Error("parse failed"));

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(0);
  });

  it("reruns safely after a partial single-row failure", async () => {
    const metaA = validMetadata("first", { docId: "doc-first" });
    const metaB = validMetadata("second", { docId: "doc-second" });
    addThread("thread-first", metaA);
    addThread("thread-second", metaB);
    const saveManySpy = vi
      .spyOn(documentRepo, "saveMany")
      .mockRejectedValueOnce(new Error("batch failed"));
    const saveSpy = vi
      .spyOn(documentRepo, "save")
      .mockRejectedValueOnce(new Error("single failed"));

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const first = await migrateThreadMetadataToDocuments({ force: true });
    saveManySpy.mockRestore();
    saveSpy.mockRestore();
    const second = await migrateThreadMetadataToDocuments({ pageSize: 1 });

    expect(first.failed).toBe(1);
    expect(first.migrated).toBe(1);
    expect(second.migrated).toBe(1);
    expect(await documentRepo.load("doc-first")).toMatchObject({
      threadId: "thread-first",
      legacySections: [section("first")],
    });
    expect(await documentRepo.load("doc-second")).toMatchObject({
      threadId: "thread-second",
      legacySections: [section("second")],
    });
  });

  it("skips bad metadata without stopping valid rows", async () => {
    addThread("bad", {
      title: "bad",
      legacySections: [section("bad")],
    });
    addThread("good", {
      docState: legacyDocState("draft"),
      docVersion: 1,
      lastSyncedDocumentSnapshot: 0,
      legacySections: [section("good")],
      materials: [],
      title: "good",
      runId: null,
      toolCallId: null,
      askUserCompleted: false,
      lastPersistedAt: "2026-01-01T00:00:00.000Z",
    });

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ force: true });

    expect(stats.skipped).toBe(1);
    expect(stats.migrated).toBe(1);
    expect(await documentRepo.load("good")).not.toBeNull();
  });

  it("非法 legacySections 只隔离当前 thread，并继续迁移同页及后续页", async () => {
    const laterMeta = validMetadata("later-good", { docId: "doc-later-good" });
    const samePageMeta = validMetadata("same-page-good", { docId: "doc-same-page-good" });
    const invalidMeta = validMetadata("invalid", { docId: "doc-invalid" });
    invalidMeta.legacySections = [{
      kind: "table",
      data: { head: [], rows: null },
    }] as unknown as LegacySection[];
    // listThreads 按 updatedAt 倒序；最后加入的非法记录会排在第一页首位。
    addThread("thread-later-good", laterMeta);
    addThread("thread-same-page-good", samePageMeta);
    addThread("thread-invalid", invalidMeta);

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ force: true, pageSize: 2 });

    expect(stats).toMatchObject({
      total: 3,
      migrated: 2,
      skipped: 0,
      failed: 1,
    });
    expect(await documentRepo.load("doc-invalid")).toBeNull();
    expect(await documentRepo.load("doc-same-page-good")).toMatchObject({
      threadId: "thread-same-page-good",
    });
    expect(await documentRepo.load("doc-later-good")).toMatchObject({
      threadId: "thread-later-good",
    });
    expect((threads.get("thread-invalid")?.metadata as QingagentThreadMetadata).migratedToDocumentsAt)
      .toBeUndefined();
    expect((threads.get("thread-same-page-good")?.metadata as QingagentThreadMetadata).migratedToDocumentsAt)
      .toEqual(expect.any(String));
  });

  it("falls back to single-row writes when a batch fails", async () => {
    addThread("thread-a", {
      docState: legacyDocState("draft"),
      docVersion: 1,
      lastSyncedDocumentSnapshot: 0,
      legacySections: [section("a")],
      materials: [],
      title: "a",
      runId: null,
      toolCallId: null,
      askUserCompleted: false,
      lastPersistedAt: "2026-01-01T00:00:00.000Z",
    });
    addThread("thread-b", {
      docState: legacyDocState("draft"),
      docVersion: 1,
      lastSyncedDocumentSnapshot: 0,
      legacySections: [section("b")],
      materials: [],
      title: "b",
      runId: null,
      toolCallId: null,
      askUserCompleted: false,
      lastPersistedAt: "2026-01-01T00:00:00.000Z",
    });
    const saveManySpy = vi
      .spyOn(documentRepo, "saveMany")
      .mockRejectedValueOnce(new Error("batch failed"));

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments({ force: true });

    expect(saveManySpy).toHaveBeenCalledTimes(1);
    expect(stats.batchFallbacks).toBe(1);
    expect(stats.migrated).toBe(2);
    expect(stats.failed).toBe(0);
    expect((await documentRepo.list({ resourceId: "qingagent-user" })).total).toBe(2);
  });
});
