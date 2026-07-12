import type { BridgeFrame, Command, FolderSourceRecord } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import {
  browserFolderSourcesEnabled,
  clearFolderSourceCache,
  invalidateSessionWorkspace,
  localFolderSourcesEnabled,
  markFolderSourceDetached,
  registerBrowserFolderSource,
  registerSessionFolderSources,
  unregisterBrowserFolderSource,
  type SessionState,
} from "./bridgeCore";
import {
  assertDirectory,
  consumeDesktopFolderSelection,
  peekDesktopFolderSelection,
} from "../lib/desktopFolderSelection";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { folderSourcesChangedFrame } from "./folderSourceFrames";
import {
  clearFolderSourceFileCountCache,
  startFolderSourceFileCountRefresh,
} from "./folderSourceRefresh";
import {
  persistFolderSourceChange,
  withFolderSourceOperationLock,
} from "./folderSourceRuntime";
import { getOrRestoreSession } from "./sessionLifecycle";

async function collectBridgeFrames(frames: AsyncGenerator<BridgeFrame>): Promise<BridgeFrame[]> {
  const collected: BridgeFrame[] = [];
  for await (const frame of frames) {
    collected.push(frame);
  }
  return collected;
}

async function* runFolderSourceOperation(
  session: SessionState,
  operation: () => AsyncGenerator<BridgeFrame>,
): AsyncGenerator<BridgeFrame> {
  const frames = await withFolderSourceOperationLock(session.sessionId, () => collectBridgeFrames(operation()));
  for (const frame of frames) {
    yield frame;
  }
}

type AttachFolderSource = Extract<Command, { kind: "attachFolder" }>["data"]["source"];
type FolderSourceFailureReason = Extract<
  Extract<BridgeFrame, { kind: "folderSourceOperationResult" }>["data"],
  { ok: false }
>["reason"];

function folderSourceResult(
  op: "attach" | "detach",
  reason: FolderSourceFailureReason,
): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: false, op, reason },
  };
}

function folderSourceOkResult(op: "attach" | "detach", folderId: string): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: true, op, folderId },
  };
}

function hasConnectedFolderSource(session: SessionState): boolean {
  return Array.from(session.folderSources.values()).some((source) => source.status === "connected");
}

function staleFolderSourceIds(session: SessionState): string[] {
  return Array.from(session.folderSources.values())
    .filter((source) => source.status !== "connected")
    .map((source) => source.id);
}

async function removeFolderSourceRuntimeState(
  session: SessionState,
  folderId: string,
  reason: "detach" | "replace",
): Promise<void> {
  clearFolderSourceFileCountCache(session.sessionId, folderId);
  markFolderSourceDetached(session.sessionId, folderId);
  unregisterBrowserFolderSource(session.sessionId, folderId);
  try {
    await clearFolderSourceCache(session.sessionId, folderId);
  } catch (error) {
    console.warn(`[bridge] clear folder source cache failed during ${reason}`, {
      sessionId: session.sessionId,
      folderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  session.folderSources.delete(folderId);
}

async function* handleAttachFolder(
  session: SessionState,
  source: AttachFolderSource,
): AsyncGenerator<BridgeFrame> {
  if (session.streamId || session.runId) {
    yield folderSourceResult("attach", "agent_busy");
    return;
  }
  if (hasConnectedFolderSource(session)) {
    yield folderSourceResult("attach", "too_many_sources");
    return;
  }

  const folderId = `fld_${crypto.randomUUID()}`;
  const mountName = `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  let record: FolderSourceRecord;

  if (source.provider === "desktop-local") {
    if (!localFolderSourcesEnabled()) {
      yield folderSourceResult("attach", "unsupported_environment");
      return;
    }
    const selection = peekDesktopFolderSelection(source.selectionToken);
    if (!selection) {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }

    let rootPath: string;
    try {
      rootPath = await assertDirectory(selection.rootPath);
    } catch {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }
    const consumedSelection = consumeDesktopFolderSelection(source.selectionToken);
    if (!consumedSelection || consumedSelection.rootPath !== selection.rootPath) {
      yield folderSourceResult("attach", "invalid_path");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield folderSourceResult("attach", "too_many_sources");
      return;
    }
    for (const staleId of staleFolderSourceIds(session)) {
      await removeFolderSourceRuntimeState(session, staleId, "replace");
    }
    record = {
      id: folderId,
      sessionId: session.sessionId,
      provider: "desktop-local",
      name: consumedSelection.name,
      pathLabel: consumedSelection.pathLabel,
      mountName,
      mountPath: `/sources/${mountName}`,
      readOnly: true,
      fileCount: consumedSelection.fileCount,
      fileCountCapped: consumedSelection.fileCountCapped,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      desktopRootPath: rootPath,
    };
  } else {
    if (!browserFolderSourcesEnabled()) {
      yield folderSourceResult("attach", "unsupported_environment");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield folderSourceResult("attach", "too_many_sources");
      return;
    }
    for (const staleId of staleFolderSourceIds(session)) {
      await removeFolderSourceRuntimeState(session, staleId, "replace");
    }
    record = {
      id: folderId,
      sessionId: session.sessionId,
      provider: "browser-fs-access",
      name: source.name,
      pathLabel: source.name,
      mountName,
      mountPath: `/sources/${mountName}`,
      readOnly: true,
      fileCount: null,
      fileCountCapped: false,
      status: "connected",
      error: null,
      createdAt: now,
      updatedAt: now,
      browserHandleKey: source.browserHandleKey,
      browserClientSourceId: source.clientSourceId,
    };
  }

  session.folderSources.set(folderId, record);
  registerSessionFolderSources(session.sessionId, session.folderSources.values());
  if (record.provider === "browser-fs-access" && record.browserClientSourceId) {
    registerBrowserFolderSource(session.sessionId, folderId, record.browserClientSourceId, {
      reviveDetached: true,
    });
  }
  invalidateSessionWorkspace(session.sessionId);
  await persistFolderSourceChange(session, "command:attachFolder");

  yield folderSourceOkResult("attach", folderId);
  yield folderSourcesChangedFrame(session);
  startFolderSourceFileCountRefresh(session, folderId);
}

async function* handleDetachFolder(
  session: SessionState,
  folderId: string,
): AsyncGenerator<BridgeFrame> {
  if (session.streamId || session.runId) {
    yield folderSourceResult("detach", "agent_busy");
    return;
  }
  if (!session.folderSources.has(folderId)) {
    yield folderSourceResult("detach", "not_found");
    return;
  }

  await removeFolderSourceRuntimeState(session, folderId, "detach");
  registerSessionFolderSources(session.sessionId, session.folderSources.values());
  invalidateSessionWorkspace(session.sessionId);
  await persistFolderSourceChange(session, "command:detachFolder");

  yield folderSourceOkResult("detach", folderId);
  yield folderSourcesChangedFrame(session);
}

type FolderSourceCommand = Extract<Command, { kind: "attachFolder" | "detachFolder" }>;

export async function* handleFolderSourceCommand(
  command: FolderSourceCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const { resolvedClientTraceId, origin, modelOverrides } = context;
  switch (command.kind) {
    case "attachFolder": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        yield folderSourceResult("attach", "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () => handleAttachFolder(session, command.data.source));
      return;
    }

    case "detachFolder": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        yield folderSourceResult("detach", "not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () => handleDetachFolder(session, command.data.folderId));
      return;
    }
  }
}
