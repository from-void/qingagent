import type { StorageThreadType } from "@mastra/core/memory";
import {
  getPmContentHash,
  legacySectionsToPm,
  pmToLegacySections,
} from "@qingagent/pm-schema";
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
  const normalized = pmToLegacySections(legacySectionsToPm(sections as never));
  return JSON.stringify(normalized) ?? "";
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
  snapshot: Awaited<ReturnType<typeof listSessionThreads>>,
): Promise<boolean> {
  if (snapshot.total === 0) return true;

  try {
    const existing = await documentRepo.countByResourceId(QINGAGENT_RESOURCE_ID);
    if (existing !== snapshot.total) return false;

    const uniqueThreadIds = new Set(snapshot.threads.map((thread) => thread.id));
    if (
      uniqueThreadIds.size !== snapshot.threads.length ||
      uniqueThreadIds.size !== snapshot.total
    ) {
      return false;
    }
    for (const thread of snapshot.threads) {
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
  // Mastra 的 perPage:false 在一次存储查询中取回完整结果，避免 updatedAt 在 offset
  // 分页期间变化造成重复/漏读；pageSize 只控制后续写入批次。
  const snapshot = await listSessionThreads({ page: 0, perPage: false });
  const stats: MigrationStats = {
    total: snapshot.total,
    migrated: 0,
    skipped: 0,
    failed: 0,
    batches: 0,
    batchFallbacks: 0,
  };

  if (!opts.force && (await shouldSkipStartupMigration(snapshot))) {
    return stats;
  }

  const migratedThreads: MigratedThread[] = [];
  for (
    let page = 0;
    page * pageSize < snapshot.threads.length;
    page += 1
  ) {
    const pageThreads = snapshot.threads.slice(
      page * pageSize,
      (page + 1) * pageSize,
    );
    const candidates: Array<{ thread: StorageThreadType; input: DocumentSaveInput }> = [];
    for (const thread of pageThreads) {
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
    const eligibleRows = candidates.filter((row) => {
      const blocked = tombstoned.has(row.input.threadId) || isSessionDeleted(row.input.threadId);
      if (blocked) stats.skipped++;
      return !blocked;
    });
    const rows: typeof eligibleRows = [];
    for (const row of eligibleRows) {
      try {
        const existing = await documentRepo.load(row.input.id);
        if (!documentMatchesMetadata(row.input, existing)) {
          rows.push(row);
        }
      } catch (err) {
        // 读取不确定时 fail-open，继续以 metadata 覆盖写入；不能因核验故障漏迁。
        logger.warn("documents migration row verification failed open", {
          page,
          id: row.input.id,
          threadId: row.input.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        rows.push(row);
      }
    }

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

  }

  await markThreadsMigrated(migratedThreads, new Date().toISOString());

  return stats;
}
