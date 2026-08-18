import { app, type BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";
import { checkForUpdatesAndWatchDownload } from "./checkForUpdates.js";
import { fetchUpdatePolicy, isBelowMinSupported, resolveUpdatePolicyUrl } from "./policy.js";
import { runManualCheck, type CheckableUpdater } from "./manualCheck.js";
import { RELEASES_URL, type UpdateStatusPayload } from "./updateTypes.js";
import { UpdateStatusDispatcher } from "./updateStatusDispatcher.js";

export { RELEASES_URL } from "./updateTypes.js";
export type { UpdateStatusPayload } from "./updateTypes.js";

type UpdateInfoLike = {
  version?: string;
};

export type StartDesktopUpdaterOptions = {
  window: BrowserWindow;
  appVersion?: string;
  policyUrl?: string;
  fetchPolicy?: typeof fetchUpdatePolicy;
};

let updaterStarted = false;
let cachedAutoUpdater: AppUpdater | null = null;
// 常驻推送监听只挂一次:startDesktopUpdater 与 manualCheckForUpdates 共享同一个 autoUpdater,
// 重复 configure 会叠加 .on 监听导致对渲染层重复推送。首配置后置真,后续只刷 feed/开关不再挂监听。
let autoUpdaterConfigured = false;
const updateStatusDispatcher = new UpdateStatusDispatcher();
const reportedCheckErrors = new WeakSet<object>();

function reportCheckFailure(err: unknown): void {
  if ((typeof err === "object" && err !== null) || typeof err === "function") {
    const errorObject = err as object;
    if (reportedCheckErrors.has(errorObject)) return;
    reportedCheckErrors.add(errorObject);
  }
  console.warn("[update] check failed:", err);
  updateStatusDispatcher.dispatch({ kind: "none" });
}

async function getAutoUpdater(): Promise<AppUpdater> {
  if (!cachedAutoUpdater) {
    cachedAutoUpdater = (await import("electron-updater")).autoUpdater;
  }
  return cachedAutoUpdater;
}

function payloadVersion(info: UpdateInfoLike): string | undefined {
  return typeof info.version === "string" && info.version ? info.version : undefined;
}

function configureAutoUpdater(updater: AppUpdater, appVersion: string): void {
  updater.logger = console;
  updater.allowPrerelease = appVersion.includes("-beta");
  updater.autoDownload = process.platform !== "darwin";
  updater.setFeedURL({
    provider: "github",
    owner: "void2anything",
    repo: "qingagent",
  });

  // 常驻推送监听幂等:只在首次 configure 时挂。update-downloaded 等被动状态由这批监听推送。
  if (autoUpdaterConfigured) return;
  autoUpdaterConfigured = true;

  updater.on("update-available", (info: UpdateInfoLike) => {
    const version = payloadVersion(info);
    if (process.platform === "darwin") {
      updateStatusDispatcher.dispatch({ kind: "mac-manual", version, notesUrl: RELEASES_URL });
      return;
    }
    updateStatusDispatcher.dispatch({ kind: "soft-available", version, notesUrl: RELEASES_URL });
  });

  updater.on("update-downloaded", (event: UpdateInfoLike) => {
    updateStatusDispatcher.dispatch({
      kind: "soft-ready",
      version: payloadVersion(event),
      notesUrl: RELEASES_URL,
    });
  });

  updater.on("update-not-available", () => {
    updateStatusDispatcher.dispatch({ kind: "none" });
  });

  updater.on("error", (err) => {
    reportCheckFailure(err);
  });
}

export async function startDesktopUpdater(options: StartDesktopUpdaterOptions): Promise<void> {
  updateStatusDispatcher.setWindow(options.window);
  if (updaterStarted) return;
  updaterStarted = true;

  const appVersion = options.appVersion ?? app.getVersion();
  if (!app.isPackaged || appVersion.includes("-dev.")) {
    updateStatusDispatcher.dispatch({ kind: "none" });
    return;
  }

  const policy = await (options.fetchPolicy ?? fetchUpdatePolicy)(
    options.policyUrl ?? resolveUpdatePolicyUrl(),
  );
  if (policy.minSupported && isBelowMinSupported(appVersion, policy.minSupported)) {
    updateStatusDispatcher.dispatch({
      kind: "force",
      version: policy.minSupported,
      notesUrl: RELEASES_URL,
    });
    return;
  }

  const updater = await getAutoUpdater();
  configureAutoUpdater(updater, appVersion);
  try {
    await checkForUpdatesAndWatchDownload(updater, reportCheckFailure);
  } catch (err) {
    reportCheckFailure(err);
  }
}

// 手动检查更新(旁路补充,不动启动检查主链):请求-响应直接返回本次结果(含 error 态)。
// 复用 cachedAutoUpdater 与 configureAutoUpdater(幂等),尊重 dev 短路;并发去重在 runManualCheck 内。
export async function manualCheckForUpdates(options: {
  window: BrowserWindow;
  appVersion?: string;
}): Promise<UpdateStatusPayload> {
  updateStatusDispatcher.setWindow(options.window);
  const appVersion = options.appVersion ?? app.getVersion();
  // dev 短路:未打包/开发版直接 none,连 electron-updater 都不 import。
  if (!app.isPackaged || appVersion.includes("-dev.")) {
    return { kind: "none" };
  }

  const updater = await getAutoUpdater();
  configureAutoUpdater(updater, appVersion);
  return runManualCheck({
    updater: updater as unknown as CheckableUpdater,
    platform: process.platform,
    appVersion,
    isPackaged: app.isPackaged,
    onStatus: (payload) => updateStatusDispatcher.dispatch(payload),
    onCheckError: reportCheckFailure,
  });
}

export async function quitAndInstallUpdate(): Promise<boolean> {
  try {
    const updater = await getAutoUpdater();
    updater.quitAndInstall();
    return true;
  } catch (err) {
    console.warn("[update] quitAndInstall failed:", err);
    return false;
  }
}

export function getCurrentUpdateStatus(): UpdateStatusPayload {
  return updateStatusDispatcher.getStatus();
}
