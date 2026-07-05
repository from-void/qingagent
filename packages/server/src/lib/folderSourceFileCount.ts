import type { WorkspaceFilesystem } from "@mastra/core/workspace";
import { shouldHideEntry, targetPath } from "./folderSourceRoutes";

export interface FolderSourceFileCountResult {
  fileCount: number;
  fileCountCapped: boolean;
}

export interface CountFolderSourceFilesOptions {
  limit?: number;
  timeoutMs?: number;
  concurrency?: number;
}

const DEFAULT_FILE_COUNT_LIMIT = 5_000;
const DEFAULT_FILE_COUNT_TIMEOUT_MS = 8_000;
const DEFAULT_FILE_COUNT_CONCURRENCY = 8;
const FILE_COUNT_TIMEOUT_MESSAGE = "folder source file count timed out";

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export async function countFolderSourceFiles(
  filesystem: WorkspaceFilesystem,
  rootPath: string,
  options: CountFolderSourceFilesOptions = {},
): Promise<FolderSourceFileCountResult> {
  const limit = normalizePositiveInteger(options.limit, DEFAULT_FILE_COUNT_LIMIT);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_FILE_COUNT_TIMEOUT_MS);
  const concurrency = Math.max(1, normalizePositiveInteger(options.concurrency, DEFAULT_FILE_COUNT_CONCURRENCY));
  const deadline = Date.now() + timeoutMs;
  const queue = [rootPath];
  let active = 0;
  let count = 0;
  let capped = limit === 0;
  let finished = capped;
  let timer: ReturnType<typeof setTimeout> | null = null;

  if (finished) return { fileCount: 0, fileCountCapped: true };

  return await new Promise<FolderSourceFileCountResult>((resolve, reject) => {
    const finish = (fileCountCapped: boolean) => {
      if (finished) return;
      finished = true;
      capped = capped || fileCountCapped;
      if (timer) clearTimeout(timer);
      resolve({ fileCount: Math.min(count, limit), fileCountCapped: capped });
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => fail(new Error(FILE_COUNT_TIMEOUT_MESSAGE)), timeoutMs);
    }

    const visit = async (dirPath: string) => {
      const remainingMs = deadline - Date.now();
      if (timeoutMs > 0 && remainingMs <= 0) {
        fail(new Error(FILE_COUNT_TIMEOUT_MESSAGE));
        return;
      }

      let entries: Awaited<ReturnType<WorkspaceFilesystem["readdir"]>>;
      try {
        entries = await filesystem.readdir(dirPath);
      } catch (error) {
        if (dirPath === rootPath) throw error;
        return;
      }
      if (finished) return;

      for (const entry of entries) {
        if (finished) return;
        if (shouldHideEntry(entry.name)) continue;
        if (entry.type === "directory") {
          queue.push(targetPath(dirPath, entry.name));
          continue;
        }
        count += 1;
        if (count >= limit) {
          count = limit;
          finish(true);
          return;
        }
      }
    };

    const pump = () => {
      if (finished) return;
      if (queue.length === 0 && active === 0) {
        finish(false);
        return;
      }

      while (!finished && active < concurrency && queue.length > 0) {
        const dirPath = queue.shift()!;
        active += 1;
        void visit(dirPath)
          .catch((error) => {
            fail(error);
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    };

    pump();
  });
}
