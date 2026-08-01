import { ipcRenderer } from "electron";
import {
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
  type ExportDownloadSaveInput,
  type ExportDownloadSaveResult,
} from "../exportDownloadContract.js";
import { createSaveExportDownload } from "./exportDownloadBridgeCore.js";

export const saveExportDownload: (
  input: ExportDownloadSaveInput,
) => Promise<ExportDownloadSaveResult> = createSaveExportDownload(ipcRenderer);

export function revealExportDownload(revealToken: string): Promise<boolean> {
  return ipcRenderer.invoke(EXPORT_DOWNLOAD_REVEAL_CHANNEL, revealToken) as Promise<boolean>;
}
