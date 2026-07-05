import { contextBridge, ipcRenderer } from "electron";

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
});
