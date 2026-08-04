/**
 * 测试辅助函数——提取 WorkspacePage 模块级未导出函数的可测入口。
 * 目的：让 workspaceGlue.test.ts 能测 deriveFolderCapability 的逻辑契约。
 */
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
