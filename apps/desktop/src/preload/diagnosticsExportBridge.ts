import { ipcRenderer } from "electron";
import type {
  DiagnosticsExportInput,
  DiagnosticsExportResult,
} from "../diagnosticsExportContract.js";
import { createExportDiagnostics } from "./diagnosticsExportBridgeCore.js";

export const exportDiagnostics: (
  input: DiagnosticsExportInput,
) => Promise<DiagnosticsExportResult> = createExportDiagnostics(ipcRenderer);
