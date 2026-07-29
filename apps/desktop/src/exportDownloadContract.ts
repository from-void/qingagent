export const EXPORT_DOWNLOAD_REGISTER_CHANNEL = "qingagent:export-download-register";
export const EXPORT_DOWNLOAD_CANCEL_CHANNEL = "qingagent:export-download-cancel";
export const EXPORT_DOWNLOAD_RESULT_CHANNEL = "qingagent:export-download-result";
export const EXPORT_DOWNLOAD_REVEAL_CHANNEL = "qingagent:export-download-reveal";
export const EXPORT_DOWNLOAD_REQUEST_FRAGMENT_KEY = "qingagent-export-request";

export type ExportDownloadFormat = "pdf" | "docx" | "html" | "markdown" | "txt";
export type ExportDownloadFailureReason =
  | "cancelled"
  | "interrupted"
  | "not-started"
  | "missing-file"
  | "window-closed";

export interface ExportDownloadRegistrationInput {
  filename: string;
  format: ExportDownloadFormat;
}

export interface ExportDownloadRegistration {
  requestId: string;
}

export type ExportDownloadSaveResult =
  | {
      saved: true;
      filename: string;
      revealToken: string;
    }
  | {
      saved: false;
      filename: string;
      reason: ExportDownloadFailureReason;
    };

export type ExportDownloadResult = ExportDownloadSaveResult & {
  requestId: string;
};
