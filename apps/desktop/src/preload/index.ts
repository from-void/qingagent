import { contextBridge, ipcRenderer } from "electron";

type UpdateStatusPayload = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none" | "error";
  version?: string;
  notesUrl?: string;
};

// 应用版本号:启动期同步取一次(主进程回 app.getVersion()),供关于页显示与「复制版本信息」。
let appVersion = "";
try {
  const value = ipcRenderer.sendSync("qingagent:app-version") as unknown;
  if (typeof value === "string") appVersion = value;
} catch {
  // 取不到留空:关于页据此降级(桌面端取不到再退回构建期注入的 web 版本)。
}

// 内核版本:preload 阶段可直读 process.versions,给关于页展示 Electron / Chromium / Node。
const versions = {
  electron: process.versions.electron ?? "",
  chrome: process.versions.chrome ?? "",
  node: process.versions.node ?? "",
};

// 启动期同步取一次客户端配置快照(凭证/模型 key 等,落 userData):渲染层需在构造请求
// header 时同步读 key,故用 sendSync 在 preload 阶段拿到初值,挂到 window.electron.clientConfig。
let clientConfig: Record<string, string> = {};
try {
  const snapshot = ipcRenderer.sendSync("qingagent:client-config-get") as unknown;
  if (snapshot && typeof snapshot === "object") {
    clientConfig = snapshot as Record<string, string>;
  }
} catch {
  // 取不到就给空对象:渲染层据此仍判定为桌面持久化(写入会落 userData)。
}

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  isDesktop: true,
  selectFolderSource: () => ipcRenderer.invoke("qingagent:select-folder-source"),
  exportDiagnostics: (opts: { privacyLevel: "L1" | "L2"; report?: string; sessionIds?: string[] }) =>
    ipcRenderer.invoke("qingagent:export-diagnostics", opts),
  clientConfig,
  setClientConfig: (patch: Record<string, string | null>) =>
    ipcRenderer.invoke("qingagent:client-config-set", patch),
  onUpdateStatus: (cb: (payload: UpdateStatusPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatusPayload) => cb(payload);
    ipcRenderer.on("qingagent:update-status", listener);
    return () => ipcRenderer.removeListener("qingagent:update-status", listener);
  },
  quitAndInstall: () => ipcRenderer.invoke("qingagent:update-quit-install"),
  openDownloadPage: () => ipcRenderer.invoke("qingagent:update-open-download"),
  appVersion,
  versions,
  // 手动检查更新:请求-响应,直接拿回本次结果(含 error 态)。
  checkForUpdate: () => ipcRenderer.invoke("qingagent:update-check") as Promise<UpdateStatusPayload>,
  // 第三方开源声明全文;读不到返回 null,前端降级跳 GitHub。
  getThirdPartyNotices: () =>
    ipcRenderer.invoke("qingagent:third-party-notices-get") as Promise<string | null>,
});
