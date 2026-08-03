export const EXPORT_DOWNLOAD_SAVE_CHANNEL = "qingagent:export-download-save";
export const EXPORT_DOWNLOAD_REVEAL_CHANNEL = "qingagent:export-download-reveal";

export type ExportDownloadFormat =
  | "pdf"
  | "docx"
  | "html"
  | "markdown"
  | "txt"
  | "zip"
  | "png";
export type ExportDownloadFailureReason =
  | "cancelled"
  | "interrupted"
  | "not-started"
  | "missing-file"
  | "write-failed"
  | "timeout"
  | "window-closed";

/**
 * renderer 只传导出结果的字节，不传任意目标路径。最终文件名与 Downloads 路径均由
 * 主进程校验、避让重名并决定。
 */
export interface ExportDownloadSaveInput {
  filename: string;
  format: ExportDownloadFormat;
  bytes: Uint8Array;
}

export type ExportDownloadSaveResult =
  | {
      saved: true;
      filename: string;
      path: string;
      revealToken: string;
    }
  | {
      saved: false;
      filename: string;
      reason: ExportDownloadFailureReason;
    };
