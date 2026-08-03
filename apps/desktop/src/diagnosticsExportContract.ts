import type { ExportDownloadFailureReason } from "./exportDownloadContract.js";

export const DIAGNOSTICS_EXPORT_CHANNEL = "qingagent:export-diagnostics";

export interface DiagnosticsExportInput {
  privacyLevel: "L1" | "L2";
  report?: string;
  sessionIds?: string[];
}

export type DiagnosticsExportFailureReason =
  | ExportDownloadFailureReason
  | "request-failed";

export type DiagnosticsExportResult =
  | {
      saved: true;
      path: string;
    }
  | {
      saved: false;
      reason: DiagnosticsExportFailureReason;
    };
