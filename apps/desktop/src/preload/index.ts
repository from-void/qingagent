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

type DesktopConfigKey =
  | "qingagent.deepseek_api_key"
  | "qingagent.custom_provider"
  | "qingagent.vision_provider"
  | "qingagent.official_model"
  | "qingagent.model_tier"
  | "qingagent.kimi_model_tier"
  // 与 web clientPersist.ts、desktop main 的白名单保持同步。
  | "qingagent.kimi_api_key"
  | "qingagent.kimi_custom_provider"
  | "qingagent.kimi_official_model"
  | "qingagent.model_provider";

// 请求 header 仍需同步读取本机配置，因此保留 sendSync，但每次只读取调用方明确请求的一项；
// contextBridge 不再挂整份已解密配置对象，也不暴露可枚举任意 key 的通用 API。
function readDesktopConfigValue(key: DesktopConfigKey): string | null {
  try {
    const value = ipcRenderer.sendSync("qingagent:client-config-value-get", key) as unknown;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeDesktopConfigValue(
  key: DesktopConfigKey,
  value: string | null,
): Promise<boolean> {
  return ipcRenderer.invoke("qingagent:client-config-value-set", key, value) as Promise<boolean>;
}

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  isDesktop: true,
  selectFolderSource: () => ipcRenderer.invoke("qingagent:select-folder-source"),
  exportDiagnostics: (opts: { privacyLevel: "L1" | "L2"; report?: string; sessionIds?: string[] }) =>
    ipcRenderer.invoke("qingagent:export-diagnostics", opts),
  getDeepseekApiKey: () => readDesktopConfigValue("qingagent.deepseek_api_key"),
  setDeepseekApiKey: (value: string | null) =>
    writeDesktopConfigValue("qingagent.deepseek_api_key", value),
  getCustomProvider: () => readDesktopConfigValue("qingagent.custom_provider"),
  setCustomProvider: (value: string | null) =>
    writeDesktopConfigValue("qingagent.custom_provider", value),
  getVisionProvider: () => readDesktopConfigValue("qingagent.vision_provider"),
  setVisionProvider: (value: string | null) =>
    writeDesktopConfigValue("qingagent.vision_provider", value),
  getOfficialModel: () => readDesktopConfigValue("qingagent.official_model"),
  setOfficialModel: (value: string | null) =>
    writeDesktopConfigValue("qingagent.official_model", value),
  getModelTier: () => readDesktopConfigValue("qingagent.model_tier"),
  setModelTier: (value: string | null) =>
    writeDesktopConfigValue("qingagent.model_tier", value),
  getKimiModelTier: () => readDesktopConfigValue("qingagent.kimi_model_tier"),
  setKimiModelTier: (value: string | null) =>
    writeDesktopConfigValue("qingagent.kimi_model_tier", value),
  getKimiApiKey: () => readDesktopConfigValue("qingagent.kimi_api_key"),
  setKimiApiKey: (value: string | null) =>
    writeDesktopConfigValue("qingagent.kimi_api_key", value),
  getKimiCustomProvider: () => readDesktopConfigValue("qingagent.kimi_custom_provider"),
  setKimiCustomProvider: (value: string | null) =>
    writeDesktopConfigValue("qingagent.kimi_custom_provider", value),
  getKimiOfficialModel: () => readDesktopConfigValue("qingagent.kimi_official_model"),
  setKimiOfficialModel: (value: string | null) =>
    writeDesktopConfigValue("qingagent.kimi_official_model", value),
  getModelProvider: () => readDesktopConfigValue("qingagent.model_provider"),
  setModelProvider: (value: string | null) =>
    writeDesktopConfigValue("qingagent.model_provider", value),
  requestConfirmRememberGrant: (input: {
    sessionId: string;
    confirmId: string;
    kind: "install" | "command";
    trustedGesture: boolean;
  }) => ipcRenderer.invoke("qingagent:confirm-remember-grant", input) as Promise<string | null>,
  requestSettingsRememberGrant: (input: {
    kind: "install" | "command";
    trustedGesture: boolean;
  }) => ipcRenderer.invoke("qingagent:settings-remember-grant", input) as Promise<string | null>,
  onUpdateStatus: (cb: (payload: UpdateStatusPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateStatusPayload) => cb(payload);
    ipcRenderer.on("qingagent:update-status", listener);
    return () => ipcRenderer.removeListener("qingagent:update-status", listener);
  },
  getUpdateStatus: () =>
    ipcRenderer.invoke("qingagent:update-status-get") as Promise<UpdateStatusPayload>,
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
