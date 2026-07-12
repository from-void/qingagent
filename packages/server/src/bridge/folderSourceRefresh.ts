import {
  getQingagentSessionWorkspace,
  registerSessionFolderSources,
  type SessionState,
} from "./bridgeCore";
import { countFolderSourceFiles, type FolderSourceFileCountResult } from "../lib/folderSourceFileCount";
import { folderSourcesChangedFrame } from "./folderSourceFrames";
import { persistFolderSourceChange } from "./folderSourceRuntime";
import { sessionManager } from "./sessionLifecycle";
import { sessions } from "./sessionRegistry";

const folderSourceFileCountCache = new Map<string, Promise<FolderSourceFileCountResult>>();

function folderSourceFileCountCacheKey(sessionId: string, folderId: string): string {
  return `${sessionId}\0${folderId}`;
}

export function clearFolderSourceFileCountCache(sessionId: string, folderId: string): void {
  folderSourceFileCountCache.delete(folderSourceFileCountCacheKey(sessionId, folderId));
}

function emitFolderSourcesChangedToClients(session: SessionState): void {
  sessionManager.frameLog.append(session.sessionId, folderSourcesChangedFrame(session));
}

export function startFolderSourceFileCountRefresh(session: SessionState, folderId: string): void {
  const source = session.folderSources.get(folderId);
  if (!source || source.status !== "connected") return;
  const key = folderSourceFileCountCacheKey(session.sessionId, folderId);
  if (folderSourceFileCountCache.has(key)) return;

  const task = (async (): Promise<FolderSourceFileCountResult> => {
    const workspace = await getQingagentSessionWorkspace(session.sessionId);
    const filesystem = workspace.filesystem;
    if (!filesystem) return { fileCount: 0, fileCountCapped: true };
    return await countFolderSourceFiles(filesystem, source.mountPath);
  })();
  folderSourceFileCountCache.set(key, task);

  void task
    .then(async (result) => {
      const current = session.folderSources.get(folderId);
      if (!current || current.status !== "connected") return;
      const updatedAt = new Date().toISOString();
      session.folderSources.set(folderId, {
        ...current,
        fileCount: result.fileCount,
        fileCountCapped: result.fileCountCapped,
        updatedAt,
      });
      registerSessionFolderSources(session.sessionId, session.folderSources.values());
      await persistFolderSourceChange(session, "background:folderSourceFileCount");
      emitFolderSourcesChangedToClients(session);
    })
    .catch((error) => {
      folderSourceFileCountCache.delete(key);
      console.warn("[bridge] folder source file count refresh failed", {
        sessionId: session.sessionId,
        folderId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function refreshBrowserFolderSourceFileCountsForBridgeConnection(
  sessionId: string,
  clientId: string,
  folderIds: readonly string[],
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const folderId of folderIds) {
    const source = session.folderSources.get(folderId);
    if (
      !source ||
      source.provider !== "browser-fs-access" ||
      source.browserClientSourceId !== clientId ||
      source.status !== "connected" ||
      source.fileCount != null
    ) {
      continue;
    }
    startFolderSourceFileCountRefresh(session, folderId);
  }
}
