import type { StorageThreadType } from "@mastra/core/memory";
import { getPmContentHash, legacySectionsToPm } from "@qingagent/pm-schema";
import {
  documentRepo,
  getTombstonedSessionIds,
  type DocumentSaveInput,
} from "@qingagent/db";
import { coerceLegacyContentKind } from "./docStateMachine.js";
import {
  listSessionThreads,
  QINGAGENT_RESOURCE_ID,
  isSessionDeleted,
  trackSessionPersistenceForSessions,
  type QingagentThreadMetadata,
} from "../session/threadPersistence.js";
import { mastra } from "../mastra.js";

const logger = mastra.getLogger();

export interface MigrationStats {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  batches: number;
  batchFallbacks: number;
}

export interface MigrationOptions {
  force?: boolean;
  pageSize?: number;
}

const STARTUP_SAMPLE_LIMIT = 20;

function dateToIso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return fallback;
}

function metadataToDocumentInput(thread: StorageThreadType): DocumentSaveInput | null {
  const meta = (thread.metadata ?? {}) as Partial<QingagentThreadMetadata>;
  if (!meta.docState || typeof meta.docState.kind !== "string") return null;
  if (!Array.isArray(meta.legacySections)) return null;

  const now = new Date().toISOString();
  const threadRecord = thread as StorageThreadType & { resourceId?: string };
  const pmDoc = legacySectionsToPm(meta.legacySections as never);
  return {
    id: meta.docId ?? thread.id,
    threadId: thread.id,
    resourceId: threadRecord.resourceId ?? QINGAGENT_RESOURCE_ID,
    title: meta.title ?? thread.title ?? "",
    docState: coerceLegacyContentKind(meta.docState.kind).kind,
    docVersion: meta.docVersion ?? 0,
    lastSyncedVersion: meta.lastSyncedDocumentSnapshot ?? 0,
    legacySections: meta.legacySections,
    pmDoc,
    createdAt: dateToIso(thread.createdAt, meta.lastPersistedAt ?? now),
    updatedAt: dateToIso(thread.updatedAt, meta.lastPersistedAt ?? now),
  };
}

function legacySectionsSignature(sections: unknown): string {
  return JSON.stringify(sections) ?? "";
}

async function collectSampleThreads(
  firstPage: Awaited<ReturnType<typeof listSessionThreads>>,
  pageSize: number,
): Promise<StorageThreadType[]> {
  const sampleSize = Math.min(firstPage.total, STARTUP_SAMPLE_LIMIT);
  const threads = firstPage.threads.slice(0, sampleSize);
  let page = 0;
  let currentPage = firstPage;

  while (threads.length < sampleSize && currentPage.hasMore) {
    page++;
    currentPage = await listSessionThreads({ page, perPage: pageSize });
    threads.push(...currentPage.threads.slice(0, sampleSize - threads.length));
  }

  return threads;
}

function documentMatchesMetadata(
  input: DocumentSaveInput,
  docRow: Awaited<ReturnType<typeof documentRepo.load>>,
): boolean {
  if (!docRow) return false;
  return (
    docRow.docVersion === input.docVersion &&
    docRow.title === input.title &&
    docRow.docState === input.docState &&
    docRow.contentHash === getPmContentHash(input.pmDoc) &&
    legacySectionsSignature(docRow.legacySections) === legacySectionsSignature(input.legacySections)
  );
}

async function shouldSkipStartupMigration(
  firstPage: Awaited<ReturnType<typeof listSessionThreads>>,
  pageSize: number,
): Promise<boolean> {
  if (firstPage.total === 0) return true;

  try {
    const existing = await documentRepo.countByResourceId(QINGAGENT_RESOURCE_ID);
    if (existing !== firstPage.total) return false;

    const sampleThreads = await collectSampleThreads(firstPage, pageSize);
    if (sampleThreads.length !== Math.min(firstPage.total, STARTUP_SAMPLE_LIMIT)) {
      return false;
    }
    for (const thread of sampleThreads) {
      const input = metadataToDocumentInput(thread);
      if (!input) return false;
      const docRow = await documentRepo.load(input.id);
      if (!documentMatchesMetadata(input, docRow)) return false;
    }

    return true;
  } catch (err) {
    try {
      logger.warn("documents migration startup guard failed open", {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // 启动守卫任何不确定都 fail-safe：不跳过迁移。
    }
    return false;
  }
}

type MigratedThread = Pick<StorageThreadType, "id" | "title" | "metadata">;

interface MigrationMemory {
  getThreadById?: (args: { threadId: string }) => Promise<StorageThreadType | null>;
  updateThread?: (args: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}

async function markThreadsMigrated(
  threads: MigratedThread[],
  migratedToDocumentsAt: string,
): Promise<void> {
  if (threads.length === 0) return;
  const memory = mastra.getMemory("default") as unknown as MigrationMemory;
  if (!memory.updateThread) return;

  for (const thread of threads) {
    try {
      const currentThread = memory.getThreadById
        ? await memory.getThreadById({ threadId: thread.id })
        : thread;
      if (!currentThread) continue;
      await memory.updateThread({
        id: currentThread.id,
        title: currentThread.title ?? thread.title ?? "",
        metadata: {
          ...((currentThread.metadata ?? {}) as Record<string, unknown>),
          migratedToDocumentsAt,
        },
      });
    } catch (err) {
      try {
        logger.warn("documents migration marker update failed", {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // 审计标记失败不影响已完成的 documents 迁移。
      }
    }
  }
}

export async function migrateThreadMetadataToDocuments(
  opts: MigrationOptions = {},
): Promise<MigrationStats> {
  const pageSize = opts.pageSize ?? 200;
  const firstPage = await listSessionThreads({ page: 0, perPage: pageSize });
  const stats: MigrationStats = {
    total: firstPage.total,
    migrated: 0,
    skipped: 0,
    failed: 0,
    batches: 0,
    batchFallbacks: 0,
  };

  if (!opts.force && (await shouldSkipStartupMigration(firstPage, pageSize))) {
    return stats;
  }

  let page = 0;
  let currentPage = firstPage;
  const migratedThreads: MigratedThread[] = [];
  while (true) {
    const candidates: Array<{ thread: StorageThreadType; input: DocumentSaveInput }> = [];
    for (const thread of currentPage.threads) {
      try {
        const input = metadataToDocumentInput(thread);
        if (input) {
          candidates.push({ thread, input });
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        logger.warn("documents migration metadata conversion failed", {
          page,
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const tombstoned = await getTombstonedSessionIds(
      candidates.map((row) => row.input.threadId),
    );
    const rows = candidates.filter((row) => {
      const blocked = tombstoned.has(row.input.threadId) || isSessionDeleted(row.input.threadId);
      if (blocked) stats.skipped++;
      return !blocked;
    });

    if (rows.length > 0) {
      try {
        await trackSessionPersistenceForSessions(
          rows.map((row) => row.input.threadId),
          () => documentRepo.saveMany(rows.map((row) => row.input)),
        );
        stats.migrated += rows.length;
        migratedThreads.push(...rows.map((row) => row.thread));
        stats.batches++;
      } catch (err) {
        stats.batchFallbacks++;
        logger.warn("documents migration batch failed; falling back to single rows", {
          page,
          error: err instanceof Error ? err.message : String(err),
        });
        for (const row of rows) {
          try {
            const blocked = isSessionDeleted(row.input.threadId) ||
              (await getTombstonedSessionIds([row.input.threadId])).has(row.input.threadId);
            if (blocked || isSessionDeleted(row.input.threadId)) {
              stats.skipped++;
              continue;
            }
            await trackSessionPersistenceForSessions(
              [row.input.threadId],
              () => documentRepo.save(row.input),
            );
            stats.migrated++;
            migratedThreads.push(row.thread);
          } catch (singleErr) {
            stats.failed++;
            logger.warn("documents migration row failed", {
              id: row.input.id,
              threadId: row.input.threadId,
              error: singleErr instanceof Error ? singleErr.message : String(singleErr),
            });
          }
        }
      }
    }

    if (!currentPage.hasMore) break;
    page++;
    currentPage = await listSessionThreads({ page, perPage: pageSize });
  }

  await markThreadsMigrated(migratedThreads, new Date().toISOString());

  return stats;
}
