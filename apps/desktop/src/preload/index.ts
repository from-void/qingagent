import { contextBridge, ipcRenderer } from "electron";
import {
  revealExportDownload,
  saveExportDownload,
} from "./exportDownloadBridge.js";
import { exportDiagnostics } from "./diagnosticsExportBridge.js";
import {
  DESKTOP_DIALOG_READY_CHANNEL,
  DESKTOP_DIALOG_REQUEST_CHANNEL,
  DESKTOP_DIALOG_RESPONSE_CHANNEL,
  isDesktopDialogKind,
  type DesktopDialogKind,
  type DesktopDialogRequest,
  type DesktopDialogResponse,
  type DesktopDialogResult,
} from "../rendererDialogContract.js";
import {
  QINGJIAN_OPEN_SESSION_CHANNEL,
  type QingjianOpenSessionIntent,
} from "../qingjianDeepLinkContract.js";

type UpdateStatusPayload = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none" | "error";
  version?: string;
  notesUrl?: string;
};

const qingjianOpenSessionListeners = new Set<(intent: QingjianOpenSessionIntent) => void>();
let pendingQingjianOpenSession: QingjianOpenSessionIntent | null = null;
ipcRenderer.on(QINGJIAN_OPEN_SESSION_CHANNEL, (_event, rawIntent: unknown) => {
  if (!rawIntent || typeof rawIntent !== "object") return;
  const engineSessionId = (rawIntent as { engineSessionId?: unknown }).engineSessionId;
  if (typeof engineSessionId !== "string") return;
  const intent = { engineSessionId };
  if (qingjianOpenSessionListeners.size === 0) {
    pendingQingjianOpenSession = intent;
    return;
  }
  for (const listener of qingjianOpenSessionListeners) listener(intent);
});

function onQingjianOpenSession(
  callback: (intent: QingjianOpenSessionIntent) => void,
): () => void {
  qingjianOpenSessionListeners.add(callback);
  if (pendingQingjianOpenSession) {
    const intent = pendingQingjianOpenSession;
    pendingQingjianOpenSession = null;
    callback(intent);
  }
  return () => qingjianOpenSessionListeners.delete(callback);
}

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
  | "qingagent.model_provider"
  | "qingagent.hardware_acceleration";

type DesktopConfigReadResult =
  | { ok: true; value: string | null }
  | { ok: false };

let clientConfigReady = false;
try {
  clientConfigReady = ipcRenderer.sendSync("qingagent:client-config-ready-get") === true;
} catch {
  clientConfigReady = false;
}
ipcRenderer.on("qingagent:client-config-ready", () => {
  clientConfigReady = true;
});

// 请求 header 仍需同步读取本机配置，因此保留 sendSync，但每次只读取调用方明确请求的一项；
// contextBridge 不再挂整份已解密配置对象，也不暴露可枚举任意 key 的通用 API。
function readDesktopConfigValue(key: DesktopConfigKey): string | null {
  if (!clientConfigReady) throw new Error("desktop client config is not ready");
  const result = ipcRenderer.sendSync(
    "qingagent:client-config-value-get",
    key,
  ) as DesktopConfigReadResult;
  if (result.ok !== true) throw new Error("desktop client config read failed");
  return typeof result.value === "string" && result.value.length > 0 ? result.value : null;
}

async function writeDesktopConfigValue(
  key: DesktopConfigKey,
  value: string | null,
): Promise<boolean> {
  return ipcRenderer.invoke("qingagent:client-config-value-set", key, value) as Promise<boolean>;
}

function isDesktopDialogRequest(value: unknown): value is DesktopDialogRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as { id?: unknown; kind?: unknown };
  return Number.isSafeInteger(request.id) && isDesktopDialogKind(request.kind);
}

function onDesktopDialogRequest(
  callback: (request: DesktopDialogRequest) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, request: unknown) => {
    if (isDesktopDialogRequest(request)) callback(request);
  };
  ipcRenderer.on(DESKTOP_DIALOG_REQUEST_CHANNEL, listener);
  return () => ipcRenderer.removeListener(DESKTOP_DIALOG_REQUEST_CHANNEL, listener);
}

function markDesktopDialogReady(kinds: DesktopDialogKind[]): void {
  // 同步握手只传两个固定枚举，确保启动壳 loadURL resolve 后主进程已看见能力，避免首个
  // 自绘请求与异步 ready 消息竞速而误降级原生。
  ipcRenderer.sendSync(
    DESKTOP_DIALOG_READY_CHANNEL,
    kinds.filter(isDesktopDialogKind),
  );
}

function respondToDesktopDialog(id: number, result: DesktopDialogResult): void {
  if (!Number.isSafeInteger(id) || (result !== "confirm" && result !== "cancel")) return;
  const response: DesktopDialogResponse = { id, result };
  ipcRenderer.send(DESKTOP_DIALOG_RESPONSE_CHANNEL, response);
}

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  isDesktop: true,
  onQingjianOpenSession,
  saveExportDownload,
  revealExportDownload,
  selectFolderSource: () => ipcRenderer.invoke("qingagent:select-folder-source"),
  exportDiagnostics,
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
  getHardwareAccelerationEnabled: () =>
    readDesktopConfigValue("qingagent.hardware_acceleration") !== "false",
  setHardwareAccelerationEnabled: (enabled: boolean) =>
    writeDesktopConfigValue("qingagent.hardware_acceleration", enabled ? "true" : "false"),
  isClientConfigReady: () => clientConfigReady,
  onClientConfigReady: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("qingagent:client-config-ready", listener);
    return () => ipcRenderer.removeListener("qingagent:client-config-ready", listener);
  },
  requestConfirmRememberGrant: (input: {
    sessionId: string;
    confirmId: string;
    kind: "install" | "command" | "send" | "connect";
    trustedGesture: boolean;
  }) => ipcRenderer.invoke("qingagent:confirm-remember-grant", input) as Promise<string | null>,
  requestSettingsRememberGrant: (input: {
    kind: "install" | "command" | "send" | "connect";
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
  // 主进程只发语义请求；实际确认卡由 renderer 的产品 UI 绘制并回传用户选择。
  onDesktopDialogRequest,
  markDesktopDialogReady,
  respondToDesktopDialog,
});
