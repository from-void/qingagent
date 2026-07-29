import { ipcRenderer } from "electron";
import {
  EXPORT_DOWNLOAD_CANCEL_CHANNEL,
  EXPORT_DOWNLOAD_REGISTER_CHANNEL,
  EXPORT_DOWNLOAD_REQUEST_FRAGMENT_KEY,
  EXPORT_DOWNLOAD_RESULT_CHANNEL,
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
  type ExportDownloadRegistration,
  type ExportDownloadResult,
  type ExportDownloadSaveResult,
  type ExportDownloadRegistrationInput,
} from "../exportDownloadContract.js";

export async function saveExportDownload(
  input: ExportDownloadRegistrationInput & { blobUrl: string },
): Promise<ExportDownloadSaveResult> {
  const fallbackFilename =
    input && typeof input.filename === "string" ? input.filename : "qingagent-export";
  if (!input || typeof input.blobUrl !== "string" || !input.blobUrl.startsWith("blob:")) {
    return { saved: false, filename: fallbackFilename, reason: "not-started" };
  }

  let requestId: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  let resolveResult: ((result: ExportDownloadResult) => void) | null = null;
  const resultPromise = new Promise<ExportDownloadResult>((resolve) => {
    resolveResult = resolve;
  });
  const onResult = (
    _event: Electron.IpcRendererEvent,
    result: ExportDownloadResult,
  ): void => {
    if (!requestId || !isExportDownloadResult(result) || result.requestId !== requestId) return;
    resolveResult?.(result);
  };
  ipcRenderer.on(EXPORT_DOWNLOAD_RESULT_CHANNEL, onResult);

  try {
    const registration = await ipcRenderer.invoke(
      EXPORT_DOWNLOAD_REGISTER_CHANNEL,
      { filename: input.filename, format: input.format },
    ) as ExportDownloadRegistration | null;
    if (!registration || typeof registration.requestId !== "string") {
      return { saved: false, filename: fallbackFilename, reason: "not-started" };
    }
    requestId = registration.requestId;

    anchor = document.createElement("a");
    const downloadUrl = new URL(input.blobUrl);
    downloadUrl.hash = `${EXPORT_DOWNLOAD_REQUEST_FRAGMENT_KEY}=${encodeURIComponent(requestId)}`;
    anchor.href = downloadUrl.href;
    anchor.download = input.filename;
    anchor.rel = "noopener";
    (document.body ?? document.documentElement).appendChild(anchor);
    anchor.click();

    const result = await resultPromise;
    if (result.saved) {
      return {
        saved: true,
        filename: result.filename,
        revealToken: result.revealToken,
      };
    }
    return {
      saved: false,
      filename: result.filename,
      reason: result.reason,
    };
  } catch {
    if (requestId) {
      await ipcRenderer.invoke(EXPORT_DOWNLOAD_CANCEL_CHANNEL, requestId).catch(() => false);
    }
    return { saved: false, filename: fallbackFilename, reason: "not-started" };
  } finally {
    anchor?.remove();
    ipcRenderer.removeListener(EXPORT_DOWNLOAD_RESULT_CHANNEL, onResult);
  }
}

export function revealExportDownload(revealToken: string): Promise<boolean> {
  return ipcRenderer.invoke(EXPORT_DOWNLOAD_REVEAL_CHANNEL, revealToken) as Promise<boolean>;
}

function isExportDownloadResult(value: unknown): value is ExportDownloadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === "string" &&
    typeof record.saved === "boolean" &&
    typeof record.filename === "string"
  );
}
