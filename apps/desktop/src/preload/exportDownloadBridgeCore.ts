import {
  EXPORT_DOWNLOAD_SAVE_CHANNEL,
  type ExportDownloadFailureReason,
  type ExportDownloadSaveInput,
  type ExportDownloadSaveResult,
} from "../exportDownloadContract.js";

interface ExportDownloadIpc {
  invoke(channel: string, input: ExportDownloadSaveInput): Promise<unknown>;
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 35_000;
const FAILURE_REASONS = new Set<ExportDownloadFailureReason>([
  "cancelled",
  "interrupted",
  "not-started",
  "missing-file",
  "write-failed",
  "timeout",
  "window-closed",
]);

export function createSaveExportDownload(
  ipc: ExportDownloadIpc,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
): (input: ExportDownloadSaveInput) => Promise<ExportDownloadSaveResult> {
  return async (input) => {
    const fallbackFilename = readFallbackFilename(input);
    if (!isSaveInput(input)) {
      return failure(fallbackFilename, "not-started");
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ExportDownloadSaveResult>((resolve) => {
      timeout = setTimeout(() => {
        resolve(failure(fallbackFilename, "timeout"));
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      const invokePromise = ipc
        .invoke(EXPORT_DOWNLOAD_SAVE_CHANNEL, input)
        .then((value) => (
          isSaveResult(value)
            ? value
            : failure(fallbackFilename, "not-started")
        ))
        .catch(() => failure(fallbackFilename, "not-started"));
      return await Promise.race([invokePromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

function isSaveInput(value: unknown): value is ExportDownloadSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<ExportDownloadSaveInput>;
  return (
    typeof input.filename === "string" &&
    typeof input.format === "string" &&
    input.bytes instanceof Uint8Array
  );
}

function isSaveResult(value: unknown): value is ExportDownloadSaveResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.saved !== "boolean" || typeof result.filename !== "string") {
    return false;
  }
  return result.saved
    ? typeof result.revealToken === "string" && result.revealToken.length > 0
    : typeof result.reason === "string" && (
      FAILURE_REASONS.has(result.reason as ExportDownloadFailureReason)
    );
}

function readFallbackFilename(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "qingagent-export";
  }
  const filename = (input as Record<string, unknown>).filename;
  return typeof filename === "string" && filename.length > 0
    ? filename
    : "qingagent-export";
}

function failure(
  filename: string,
  reason: ExportDownloadFailureReason,
): ExportDownloadSaveResult {
  return { saved: false, filename, reason };
}
