import { contextBridge } from "electron";
import {
  revealExportDownload,
  saveExportDownload,
} from "../preload/exportDownloadBridge.js";

contextBridge.exposeInMainWorld("electron", {
  isDesktop: true,
  saveExportDownload,
  revealExportDownload,
});
