/**
 * 测试辅助函数——提取 WorkspacePage 模块级未导出函数的可测入口
 * 目的：让 workspaceGlue.test.ts 能测 folderSourceOperationFailureToast 和
 * deriveFolderCapability 的逻辑契约。
 */
import type { FolderSourceOperationResult } from "@qingagent/contract-ts";
import { deriveFolderCapabilityFromEnv } from "../../../system";

export interface FolderCapabilityResult {
  enabled: boolean;
  reason: string | null;
}

interface DeriveFolderCapabilityInput {
  isDesktop: boolean;
  hasSelectFolderSource: boolean;
  hasShowDirectoryPicker?: boolean;
  isSecureContext?: boolean;
  isMobile?: boolean;
  serverDesktopFolderSourcesEnabled?: boolean;
  serverBrowserFolderSourcesEnabled?: boolean;
}

export function deriveFolderCapabilityForTest(
  input: DeriveFolderCapabilityInput,
): FolderCapabilityResult {
  return deriveFolderCapabilityFromEnv({
    isDesktop: input.isDesktop,
    hasDesktopPicker: input.hasSelectFolderSource,
    hasDirectoryPicker: input.hasShowDirectoryPicker ?? false,
    isSecureContext: input.isSecureContext ?? true,
    userAgent: input.isMobile ? "iPhone Mobile" : "Desktop Browser",
    maxTouchPoints: input.isMobile ? 5 : 0,
    serverDesktopFolderSourcesEnabled: input.serverDesktopFolderSourcesEnabled ?? true,
    serverBrowserFolderSourcesEnabled: input.serverBrowserFolderSourcesEnabled ?? true,
  });
}

/**
 * 镜像 WorkspacePage.tsx folderSourceOperationFailureToast() 的纯函数版本
 * 依据：WorkspacePage.tsx L255-L277
 */
export function folderSourceOperationFailureToastForTest(
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
