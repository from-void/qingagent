/// <reference types="vite/client" />

// 打包信息:vite.config.ts 编译期定值注入(build-win.sh 提供 QINGAGENT_BUILD_INFO,dev 为 "dev")。
declare const __BUILD_INFO__: string;

// 应用版本号:vite.config.ts 由 package.json version 编译期注入(web 端降级显示用)。
// vitest 无此 define,引用处需用 typeof 兜底避免 ReferenceError。
declare const __APP_VERSION__: string;

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
  // error:仅手动检查的请求-响应结果会带,区分「已是最新」与「检查失败」。
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none" | "error";
  version?: string;
  notesUrl?: string;
}

interface ElectronKernelVersions {
  electron: string;
  chrome: string;
  node: string;
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
    // 客户端凭证/模型配置持久化(落 userData,见 clientPersist.ts)：只暴露固定用途的单项 API，
    // 不把整份解密配置挂到 window。
    getDeepseekApiKey?: () => string | null;
    setDeepseekApiKey?: (value: string | null) => Promise<boolean>;
    getCustomProvider?: () => string | null;
    setCustomProvider?: (value: string | null) => Promise<boolean>;
    getVisionProvider?: () => string | null;
    setVisionProvider?: (value: string | null) => Promise<boolean>;
    getOfficialModel?: () => string | null;
    setOfficialModel?: (value: string | null) => Promise<boolean>;
    getModelTier?: () => string | null;
    setModelTier?: (value: string | null) => Promise<boolean>;
    onUpdateStatus?: (cb: (payload: ElectronUpdateStatus) => void) => () => void;
    getUpdateStatus?: () => Promise<ElectronUpdateStatus>;
    quitAndInstall?: () => Promise<unknown>;
    openDownloadPage?: () => Promise<unknown>;
    // 关于页:应用版本号(preload 启动期同步注入)、内核版本、手动检查、第三方声明全文。
    appVersion?: string;
    versions?: ElectronKernelVersions;
    checkForUpdate?: () => Promise<ElectronUpdateStatus>;
    getThirdPartyNotices?: () => Promise<string | null>;
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
