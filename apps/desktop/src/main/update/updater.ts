import { app, type BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";
import { fetchUpdatePolicy, isBelowMinSupported, resolveUpdatePolicyUrl } from "./policy.js";

export const RELEASES_URL = "https://github.com/from-void/qingagent/releases";

export type UpdateStatusPayload = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none";
  version?: string;
  notesUrl?: string;
};

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

async function getAutoUpdater(): Promise<AppUpdater> {
  if (!cachedAutoUpdater) {
    cachedAutoUpdater = (await import("electron-updater")).autoUpdater;
  }
  return cachedAutoUpdater;
}

function sendUpdateStatus(window: BrowserWindow, payload: UpdateStatusPayload): void {
  if (window.isDestroyed()) return;
  window.webContents.send("qingagent:update-status", payload);
}

function payloadVersion(info: UpdateInfoLike): string | undefined {
  return typeof info.version === "string" && info.version ? info.version : undefined;
}

function configureAutoUpdater(updater: AppUpdater, window: BrowserWindow, appVersion: string): void {
  updater.logger = console;
  updater.allowPrerelease = appVersion.includes("-beta");
  updater.autoDownload = process.platform !== "darwin";
  updater.setFeedURL({
    provider: "github",
    owner: "from-void",
    repo: "qingagent",
  });

  updater.on("update-available", (info: UpdateInfoLike) => {
    const version = payloadVersion(info);
    if (process.platform === "darwin") {
      sendUpdateStatus(window, { kind: "mac-manual", version, notesUrl: RELEASES_URL });
      return;
    }
    sendUpdateStatus(window, { kind: "soft-available", version, notesUrl: RELEASES_URL });
  });

  updater.on("update-downloaded", (event: UpdateInfoLike) => {
    sendUpdateStatus(window, {
      kind: "soft-ready",
      version: payloadVersion(event),
      notesUrl: RELEASES_URL,
    });
  });

  updater.on("update-not-available", () => {
    sendUpdateStatus(window, { kind: "none" });
  });

  updater.on("error", (err) => {
    console.warn("[update] check failed:", err);
    sendUpdateStatus(window, { kind: "none" });
  });
}

export async function startDesktopUpdater(options: StartDesktopUpdaterOptions): Promise<void> {
  if (updaterStarted) return;
  updaterStarted = true;

  const appVersion = options.appVersion ?? app.getVersion();
  if (!app.isPackaged || appVersion.includes("-dev.")) {
    sendUpdateStatus(options.window, { kind: "none" });
    return;
  }

  const policy = await (options.fetchPolicy ?? fetchUpdatePolicy)(
    options.policyUrl ?? resolveUpdatePolicyUrl(),
  );
  if (policy.minSupported && isBelowMinSupported(appVersion, policy.minSupported)) {
    sendUpdateStatus(options.window, {
      kind: "force",
      version: policy.minSupported,
      notesUrl: RELEASES_URL,
    });
    return;
  }

  const updater = await getAutoUpdater();
  configureAutoUpdater(updater, options.window, appVersion);
  try {
    await updater.checkForUpdates();
  } catch (err) {
    console.warn("[update] check failed:", err);
    sendUpdateStatus(options.window, { kind: "none" });
  }
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
