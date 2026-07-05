/// <reference types="vite/client" />

// 打包信息:vite.config.ts 编译期定值注入(build-win.sh 提供 QINGAGENT_BUILD_INFO,dev 为 "dev")。
declare const __BUILD_INFO__: string;

// 构建期注入的前端环境变量(envPrefix: ["VITE_"])。
interface ImportMetaEnv {
  // 桌面版站点地址;官方构建注入,fork 默认空(移动端提示不点名域名)。
  readonly VITE_DESKTOP_SITE_URL?: string;
}

interface ElectronFolderSourceSelection {
  selectionToken: string;
  name: string;
  pathLabel: string;
  fileCount: number | null;
  fileCountCapped: boolean;
}

interface ElectronUpdateStatus {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none";
  version?: string;
  notesUrl?: string;
}

interface Window {
  electron?: {
    platform: string;
    isDesktop: boolean;
    selectFolderSource?: () => Promise<ElectronFolderSourceSelection | null>;
    exportDiagnostics?: (opts: {
      privacyLevel: "L1" | "L2";
      report?: string;
      sessionIds?: string[];
    }) => Promise<{ saved: boolean; path?: string }>;
    // 客户端凭证/模型配置持久化(落 userData,见 clientPersist.ts):
    // clientConfig 是 preload 阶段同步注入的初值快照;setClientConfig 异步落盘(value=null 删除)。
    clientConfig?: Record<string, string>;
    setClientConfig?: (patch: Record<string, string | null>) => Promise<boolean>;
    onUpdateStatus?: (cb: (payload: ElectronUpdateStatus) => void) => () => void;
    quitAndInstall?: () => Promise<unknown>;
    openDownloadPage?: () => Promise<unknown>;
  };
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
  queryPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (descriptor?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: "file";
  getFile: () => Promise<File>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: "directory";
  entries: () => AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandle>;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.jpeg" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.gif" {
  const src: string;
  export default src;
}

declare module "*.webp" {
  const src: string;
  export default src;
}
