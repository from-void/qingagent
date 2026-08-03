import {
  DIAGNOSTICS_EXPORT_CHANNEL,
  type DiagnosticsExportFailureReason,
  type DiagnosticsExportInput,
  type DiagnosticsExportResult,
} from "../diagnosticsExportContract.js";

interface DiagnosticsExportIpc {
  invoke(channel: string, input: DiagnosticsExportInput): Promise<unknown>;
}

const DEFAULT_BRIDGE_TIMEOUT_MS = 70_000;
const FAILURE_REASONS = new Set<DiagnosticsExportFailureReason>([
  "cancelled",
  "interrupted",
  "not-started",
  "missing-file",
  "write-failed",
  "timeout",
  "window-closed",
  "request-failed",
]);

export function createExportDiagnostics(
  ipc: DiagnosticsExportIpc,
  timeoutMs = DEFAULT_BRIDGE_TIMEOUT_MS,
): (input: DiagnosticsExportInput) => Promise<DiagnosticsExportResult> {
  return async (input) => {
    if (!isDiagnosticsExportInput(input)) return failure("not-started");

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<DiagnosticsExportResult>((resolve) => {
      timeout = setTimeout(() => resolve(failure("timeout")), timeoutMs);
      timeout.unref?.();
    });
    try {
      const invokePromise = ipc
        .invoke(DIAGNOSTICS_EXPORT_CHANNEL, input)
        .then((value) => (
          isDiagnosticsExportResult(value) ? value : failure("not-started")
        ))
        .catch(() => failure("request-failed"));
      return await Promise.race([invokePromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

function isDiagnosticsExportInput(value: unknown): value is DiagnosticsExportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.privacyLevel !== "L1" && input.privacyLevel !== "L2") return false;
  if (input.report !== undefined && typeof input.report !== "string") return false;
  return input.sessionIds === undefined || (
    Array.isArray(input.sessionIds) &&
    input.sessionIds.every((sessionId) => typeof sessionId === "string")
  );
}

function isDiagnosticsExportResult(value: unknown): value is DiagnosticsExportResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.saved === true) {
    return typeof result.path === "string" && result.path.length > 0;
  }
  return result.saved === false &&
    typeof result.reason === "string" &&
    FAILURE_REASONS.has(result.reason as DiagnosticsExportFailureReason);
}

function failure(reason: DiagnosticsExportFailureReason): DiagnosticsExportResult {
  return { saved: false, reason };
}
