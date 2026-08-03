import type {
  DiagnosticsExportInput,
  DiagnosticsExportResult,
} from "../diagnosticsExportContract.js";
import type {
  ExportDownloadSaveInput,
  ExportDownloadSaveResult,
} from "../exportDownloadContract.js";

interface DiagnosticsExportDependencies {
  serverOrigin: string;
  downloadsDirectory: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  save: (input: ExportDownloadSaveInput) => Promise<ExportDownloadSaveResult>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;

/**
 * 诊断包与普通文档导出共用主进程原子写盘通道，固定落到系统 Downloads。
 * 这里不再弹原生保存框：原保存框在部分 Windows 真机上不显示且 Promise 不回调，
 * 会把整个 invoke 永久悬住。请求/响应体与写盘各自有独立超时，preload 再兜总时限。
 */
export async function exportDiagnosticsToDownloads(
  rawInput: unknown,
  dependencies: DiagnosticsExportDependencies,
): Promise<DiagnosticsExportResult> {
  const input = normalizeInput(rawInput);
  let response: Awaited<ReturnType<typeof fetchDiagnosticsZip>>;
  try {
    response = await fetchDiagnosticsZip(input, dependencies);
  } catch (error) {
    return {
      saved: false,
      reason: error instanceof DiagnosticsRequestTimeoutError
        ? "timeout"
        : "request-failed",
    };
  }

  const filename = filenameFromContentDisposition(
    response.contentDisposition,
  ) ?? fallbackFilename();
  try {
    const saved = await dependencies.save({
      filename,
      format: "zip",
      bytes: response.bytes,
    });
    if (!saved.saved) return { saved: false, reason: saved.reason };
    return {
      saved: true,
      path: saved.path,
    };
  } catch {
    return { saved: false, reason: "write-failed" };
  }
}

async function fetchDiagnosticsZip(
  input: DiagnosticsExportInput,
  dependencies: DiagnosticsExportDependencies,
): Promise<{ contentDisposition: string | null; bytes: Uint8Array }> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: dependencies.serverOrigin,
  };
  if (dependencies.authToken) headers.Authorization = `Bearer ${dependencies.authToken}`;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DiagnosticsRequestTimeoutError());
    }, dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
  });
  const requestPromise = (async () => {
    const response = await (dependencies.fetchImpl ?? fetch)(
      `${dependencies.serverOrigin}/api/v1/diagnostics/export`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`diagnostics export HTTP ${response.status}`);
    return {
      contentDisposition: response.headers.get("content-disposition"),
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  })();

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeInput(rawInput: unknown): DiagnosticsExportInput {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { privacyLevel: "L1" };
  }
  const input = rawInput as Record<string, unknown>;
  const report = typeof input.report === "string" ? input.report : undefined;
  const sessionIds = Array.isArray(input.sessionIds)
    ? input.sessionIds.filter((value): value is string => (
      typeof value === "string" && value.length > 0
    ))
    : undefined;
  return {
    privacyLevel: input.privacyLevel === "L2" ? "L2" : "L1",
    ...(report !== undefined ? { report } : {}),
    ...(sessionIds && sessionIds.length > 0 ? { sessionIds } : {}),
  };
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return utf8;
    }
  }
  const plain = /filename="([^"]+)"/i.exec(value)?.[1] ??
    /filename=([^;]+)/i.exec(value)?.[1];
  return plain ? plain.trim() : null;
}

function fallbackFilename(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `qingagent-diag-v1-${stamp}.zip`;
}

class DiagnosticsRequestTimeoutError extends Error {}
