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

function detachFolderResult(
  reason: FolderSourceFailureReason,
): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: false, op: "detach", reason },
  };
}

function detachFolderOkResult(folderId: string): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: { ok: true, op: "detach", folderId },
  };
}

function attachFolderResult(
  requestId: string,
  clientSourceId: string | null,
  reason: FolderSourceFailureReason,
): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: {
      ok: false,
      op: "attach",
      requestId,
      clientSourceId,
      reason,
    },
  };
}

function attachFolderOkResult(
  requestId: string,
  clientSourceId: string | null,
  folderId: string,
): BridgeFrame {
  return {
    kind: "folderSourceOperationResult",
    data: {
      ok: true,
      op: "attach",
      requestId,
      clientSourceId,
      folderId,
    },
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
  requestId: string,
  source: AttachFolderSource,
): AsyncGenerator<BridgeFrame> {
  const clientSourceId =
    source.provider === "browser-fs-access" ? source.clientSourceId : null;
  if (session.streamId || session.runId) {
    yield attachFolderResult(requestId, clientSourceId, "agent_busy");
    return;
  }
  if (hasConnectedFolderSource(session)) {
    yield attachFolderResult(requestId, clientSourceId, "too_many_sources");
    return;
  }

  const folderId = `fld_${crypto.randomUUID()}`;
  const mountName = `source_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = new Date().toISOString();
  let record: FolderSourceRecord;

  if (source.provider === "desktop-local") {
    if (!localFolderSourcesEnabled()) {
      yield attachFolderResult(requestId, clientSourceId, "unsupported_environment");
      return;
    }
    const selection = peekDesktopFolderSelection(source.selectionToken);
    if (!selection) {
      yield attachFolderResult(requestId, clientSourceId, "invalid_path");
      return;
    }

    let rootPath: string;
    try {
      rootPath = await assertDirectory(selection.rootPath);
    } catch {
      yield attachFolderResult(requestId, clientSourceId, "invalid_path");
      return;
    }
    const consumedSelection = consumeDesktopFolderSelection(source.selectionToken);
    if (!consumedSelection || consumedSelection.rootPath !== selection.rootPath) {
      yield attachFolderResult(requestId, clientSourceId, "invalid_path");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield attachFolderResult(requestId, clientSourceId, "too_many_sources");
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
      yield attachFolderResult(requestId, clientSourceId, "unsupported_environment");
      return;
    }
    if (hasConnectedFolderSource(session)) {
      yield attachFolderResult(requestId, clientSourceId, "too_many_sources");
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

  yield attachFolderOkResult(requestId, clientSourceId, folderId);
  yield folderSourcesChangedFrame(session);
  startFolderSourceFileCountRefresh(session, folderId);
}

async function* handleDetachFolder(
  session: SessionState,
  folderId: string,
): AsyncGenerator<BridgeFrame> {
  if (session.streamId || session.runId) {
    yield detachFolderResult("agent_busy");
    return;
  }
  if (!session.folderSources.has(folderId)) {
    yield detachFolderResult("not_found");
    return;
  }

  await removeFolderSourceRuntimeState(session, folderId, "detach");
  registerSessionFolderSources(session.sessionId, session.folderSources.values());
  invalidateSessionWorkspace(session.sessionId);
  await persistFolderSourceChange(session, "command:detachFolder");

  yield detachFolderOkResult(folderId);
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
        const clientSourceId =
          command.data.source.provider === "browser-fs-access"
            ? command.data.source.clientSourceId
            : null;
        yield attachFolderResult(
          command.data.requestId,
          clientSourceId,
          "not_found",
        );
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () =>
        handleAttachFolder(
          session,
          command.data.requestId,
          command.data.source,
        ),
      );
      return;
    }

    case "detachFolder": {
      const session = await getOrRestoreSession(command.data.sessionId);
      if (!session) {
        yield detachFolderResult("not_found");
        return;
      }
      bindClientTraceId(session, resolvedClientTraceId, origin, modelOverrides);
      yield* runFolderSourceOperation(session, () => handleDetachFolder(session, command.data.folderId));
      return;
    }
  }
}
