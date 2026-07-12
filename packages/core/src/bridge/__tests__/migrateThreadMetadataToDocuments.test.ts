import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacySection, IncomingDocState } from "@qingagent/contract-ts";
import { legacySectionsToPm } from "@qingagent/pm-schema";
import type { QingagentThreadMetadata } from "../../bridge/threadPersistence.js";
import {
  __resetDocumentsClientForTest,
  __resetMigrationsForTest,
  documentRepo,
} from "@qingagent/db";

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
        perPage: number;
      }) => {
        const all = Array.from(threads.values())
          .filter((thread) => thread.resourceId === filter.resourceId)
          .sort(
            (a, b) =>
              (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime(),
          );
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
  threads.set(id, {
    id,
    title: metadata.title ?? id,
    resourceId: "qingagent-user",
    createdAt: new Date(`2026-01-01T00:00:0${threads.size}.000Z`),
    updatedAt: new Date(`2026-01-02T00:00:0${threads.size}.000Z`),
    metadata,
  });
}

async function saveDocumentFromMetadata(
  threadId: string,
  metadata: QingagentThreadMetadata,
  overrides: {
    id?: string;
    docState?: string;
    docVersion?: number;
    legacySections?: LegacySection[];
  } = {},
): Promise<void> {
  await documentRepo.save({
    id: overrides.id ?? metadata.docId ?? threadId,
    threadId,
    resourceId: "qingagent-user",
    title: metadata.title,
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
});

afterEach(() => {
  __resetDocumentsClientForTest();
  __resetMigrationsForTest();
  delete process.env.DATABASE_URL;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("migrateThreadMetadataToDocuments", () => {
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
    expect(second.migrated).toBe(2);
    const listed = await documentRepo.list({ resourceId: "qingagent-user" });
    expect(listed.total).toBe(2);
    expect(await documentRepo.load("doc-1")).toMatchObject({
      threadId: "thread-1",
      docState: "editing",
      docVersion: 2,
      legacySections: [section("一")],
    });
  }, 10_000);

  it("skips startup migration only when sampled documents match metadata", async () => {
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

  it("does not skip when sampled legacySections have the same length but different text", async () => {
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

  it("does not skip when sampled docVersion differs", async () => {
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

  it("does not skip when sampled docState differs", async () => {
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

  it("does not skip when counts match but a sampled document row is missing", async () => {
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

    expect(stats.migrated).toBe(2);
    expect(await documentRepo.load("doc-missing")).toMatchObject({
      threadId: "thread-missing",
      legacySections: [section("missing")],
    });
  });

  it("fails open when the sampled document load throws", async () => {
    const meta = validMetadata("load-error", { docId: "doc-load-error" });
    addThread("thread-load-error", meta);
    await saveDocumentFromMetadata("thread-load-error", meta);
    vi.spyOn(documentRepo, "load").mockRejectedValueOnce(new Error("parse failed"));

    const { migrateThreadMetadataToDocuments } = await import(
      "../migrateThreadMetadataToDocuments.js"
    );
    const stats = await migrateThreadMetadataToDocuments();

    expect(stats.migrated).toBe(1);
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
    expect(second.migrated).toBe(2);
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
