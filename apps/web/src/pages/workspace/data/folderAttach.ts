import type {
  BridgeFrame,
  Command,
  FolderSourceOperationResult,
} from "@qingagent/contract-ts";
import type { PickedBrowserFolderSource } from "./browserFolderBridge";

export const FOLDER_ATTACH_TIMEOUT_MS = 30_000;
export const FOLDER_ATTACH_TIMEOUT_MESSAGE = "连接文件夹超时，请重试";

interface FolderAttachStream {
  sendCommand: (command: Command, abortSignal?: AbortSignal) => Promise<unknown>;
  waitForFrame: (
    predicate: (frame: BridgeFrame) => boolean,
    timeoutMessage: string,
    timeoutMs?: number,
    onTimeout?: (error: Error) => void,
    abortSignal?: AbortSignal,
  ) => Promise<BridgeFrame>;
}

export class FolderAttachTimeoutError extends Error {
  constructor() {
    super(FOLDER_ATTACH_TIMEOUT_MESSAGE);
    this.name = "FolderAttachTimeoutError";
  }
}

export function folderSourceOperationFailureToast(
  data: Extract<FolderSourceOperationResult, { ok: false }>,
): string {
  const op = data.op === "attach" ? "连接文件夹" : "断开文件夹";
  switch (data.reason) {
    case "agent_busy":
      return `${op}失败：青简正在处理，请稍后再试`;
    case "unsupported_environment":
      return `${op}失败：当前环境暂不支持`;
    case "not_found":
      return `${op}失败：文件夹连接不存在或已断开`;
    case "too_many_sources":
      return `${op}失败：当前会话暂只支持连接一个文件夹`;
    case "permission_denied":
      return `${op}失败：没有权限访问该文件夹`;
    case "invalid_path":
      return `${op}失败：这个文件夹无法连接，请换一个`;
    case "bridge_offline":
      return `${op}失败：文件夹桥接未就绪，请重试`;
    case "unknown":
      return `${op}失败：请重试`;
  }
}

export type FolderAttachSelection =
  | { provider: "desktop-local"; selectionToken: string }
  | { provider: "browser-fs-access"; picked: PickedBrowserFolderSource };

export function newFolderAttachRequestId(): string {
  return `folder_attach_${crypto.randomUUID()}`;
}

export function buildAttachFolderCommand(
  sessionId: string,
  selection: FolderAttachSelection,
  requestId: string,
): Extract<Command, { kind: "attachFolder" }> {
  return {
    kind: "attachFolder",
    data: {
      sessionId,
      requestId,
      source: selection.provider === "desktop-local"
        ? {
            provider: "desktop-local",
            selectionToken: selection.selectionToken,
          }
        : {
            provider: "browser-fs-access",
            clientSourceId: selection.picked.clientSourceId,
            name: selection.picked.name,
            browserHandleKey: selection.picked.browserHandleKey,
          },
    },
  };
}

export function matchesAttachFolderResult(
  data: FolderSourceOperationResult,
  requestId: string,
  selection: FolderAttachSelection,
): boolean {
  if (data.op !== "attach" || data.requestId !== requestId) return false;
  const expectedClientSourceId =
    selection.provider === "browser-fs-access"
      ? selection.picked.clientSourceId
      : null;
  return data.clientSourceId === expectedClientSourceId;
}

export async function submitAttachFolderCommand(
  stream: FolderAttachStream,
  command: Extract<Command, { kind: "attachFolder" }>,
  selection: FolderAttachSelection,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<FolderSourceOperationResult> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let timedOut = false;
  const framePromise = stream.waitForFrame(
    (frame) =>
      frame.kind === "folderSourceOperationResult" &&
      matchesAttachFolderResult(frame.data, command.data.requestId, selection),
    FOLDER_ATTACH_TIMEOUT_MESSAGE,
    options.timeoutMs ?? FOLDER_ATTACH_TIMEOUT_MS,
    (error) => {
      timedOut = true;
      controller.abort(error);
    },
    controller.signal,
  );

  try {
    const [, frame] = await Promise.all([
      stream.sendCommand(command, controller.signal),
      framePromise,
    ]);
    if (frame.kind !== "folderSourceOperationResult") {
      throw new Error(FOLDER_ATTACH_TIMEOUT_MESSAGE);
    }
    return frame.data;
  } catch (error) {
    controller.abort(error);
    if (timedOut) throw new FolderAttachTimeoutError();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
