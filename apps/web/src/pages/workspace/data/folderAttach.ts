import type { Command, FolderSourceOperationResult } from "@qingagent/contract-ts";
import type { PendingFolderSource } from "../../../system";
import type { PickedBrowserFolderSource } from "./browserFolderBridge";

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

export function folderAttachSelectionFromPending(source: PendingFolderSource): FolderAttachSelection {
  if (source.provider === "desktop-local") {
    return { provider: "desktop-local", selectionToken: source.selection.selectionToken };
  }
  return { provider: "browser-fs-access", picked: source.picked };
}

export function buildAttachFolderCommand(
  sessionId: string,
  selection: FolderAttachSelection,
): Extract<Command, { kind: "attachFolder" }> {
  return {
    kind: "attachFolder",
    data: {
      sessionId,
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
