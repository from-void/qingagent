import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import { getRegisteredFolderSourceHostRoots } from "../folderSources/runtime.js";
import { mastra, getObservability } from "../mastra.js";
import type { SessionState } from "./sessionState.js";
import { getToolIoMaxBytes, summarizeToolValue } from "./redaction.js";
import { sessionIdToTraceId } from "./agentSpans.js";

const logger = mastra.getLogger();

export function startToolIoSpan(
  state: SessionState,
  streamId: string,
  runId: string,
  toolName: string,
  toolCallId: string,
  input: unknown,
): Span<SpanType.TOOL_CALL> | null {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return null;
    const traceId = sessionIdToTraceId(state.sessionId);
    return instance.startSpan({
      type: SpanType.TOOL_CALL,
      name: toolName,
      ...(traceId ? { traceId } : {}),
      attributes: { toolType: "qingagent" },
      metadata: {
        eventKind: "tool_call",
        sessionId: state.sessionId,
        clientTraceId: state.clientTraceId ?? null,
        streamId,
        runId,
        toolName,
        toolCallId,
        origin: state.origin ?? "manual",
      },
      input: summarizeToolInputForSpan(toolName, input),
    }) as Span<SpanType.TOOL_CALL>;
  } catch (err) {
    logger.warn("startToolIoSpan failed (non-fatal)", {
      sessionId: state.sessionId,
      toolName,
      toolCallId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function endToolIoSpan(
  span: Span<SpanType.TOOL_CALL> | null | undefined,
  output: unknown,
  success: boolean,
  metadata: Record<string, unknown> = {},
  toolName = "",
): void {
  if (!span) return;
  try {
    span.end({
      attributes: { success },
      metadata,
      output: summarizeToolOutputForSpan(toolName, output),
    });
  } catch (err) {
    logger.warn("endToolIoSpan failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function buildToolIoEndMetadata(
  toolResultOk: boolean,
  toolResult: unknown,
): Record<string, unknown> {
  const resultRecord = asRecord(toolResult);
  return {
    status: toolResultOk ? "done" : "failed",
    ...(
      resultRecord?.suppressed === true
        ? {
            suppressed: true,
            suppressReason:
              typeof resultRecord.reason === "string" ? resultRecord.reason : null,
          }
        : {}
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

// ── 文件夹源 telemetry 脱敏:readDocument/searchDocuments 的 /sources 正文不进 span ──
function summarizeReadDocumentOutputForSpan(output: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: output.ok,
    path: output.path,
    cacheHit: output.cacheHit,
    wordCount: output.wordCount,
    pages: output.pages,
    title: output.title,
    truncated: output.truncated,
    ...(typeof output.error === "string" ? { error: output.error } : {}),
  };
}

function summarizeSearchDocumentsOutputForSpan(output: Record<string, unknown>): Record<string, unknown> {
  const results = Array.isArray(output.results)
    ? output.results.map((item) => {
        const record = asRecord(item);
        if (!record) return {};
        return {
          path: record.path,
          folderId: record.folderId,
          relPath: record.relPath,
          score: record.score,
        };
      })
    : [];
  return {
    ok: output.ok,
    resultCount: results.length,
    results,
    indexedCount: output.indexedCount,
    scannedCount: output.scannedCount,
    fileCountCapped: output.fileCountCapped,
    ...(typeof output.error === "string" ? { error: output.error } : {}),
  };
}

function toolValueToPathScanText(value: unknown): string | null {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

function textMentionsVirtualFolderSources(text: string): boolean {
  return /(^|[^\w./-])\/sources(?:\/|$|(?=[^\w./-]))/.test(text);
}

function trimTrailingPathSeparators(value: string): string {
  let next = value.trim();
  while (next.length > 1 && /[\\/]$/.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

function normalizePathTextForHostRootMatch(value: string): string {
  return value.replace(/\\+/g, "/");
}

function textMentionsFolderSourceHostRoot(text: string, folderSourceHostRoots: readonly string[]): boolean {
  if (folderSourceHostRoots.length === 0) return false;
  const normalizedText = normalizePathTextForHostRootMatch(text);
  for (const rawRoot of folderSourceHostRoots) {
    const root = trimTrailingPathSeparators(rawRoot);
    if (!root) continue;
    if (text.includes(root)) return true;
    const escapedRoot = root.replace(/\\/g, "\\\\");
    if (escapedRoot !== root && text.includes(escapedRoot)) return true;
    const normalizedRoot = trimTrailingPathSeparators(normalizePathTextForHostRootMatch(root));
    if (normalizedRoot && normalizedText.includes(normalizedRoot)) return true;
  }
  return false;
}

function toolValueMentionsFolderSources(value: unknown, folderSourceHostRoots: readonly string[] = []): boolean {
  const text = toolValueToPathScanText(value);
  if (!text) return false;
  const effectiveHostRoots = folderSourceHostRoots.length > 0
    ? folderSourceHostRoots
    : getRegisteredFolderSourceHostRoots();
  return textMentionsVirtualFolderSources(text) ||
    textMentionsFolderSourceHostRoot(text, effectiveHostRoots);
}

function summarizeFolderSourceToolIoForSpan(
  toolName: string,
  value: unknown,
  io: "input" | "output",
  maxBytes: number,
  folderSourceHostRoots: readonly string[] = [],
): unknown | null {
  if (!toolValueMentionsFolderSources(value, folderSourceHostRoots)) return null;
  return summarizeToolValue({
    redacted: true,
    reason: "folder_source_tool_io",
    toolName,
    io,
    pathScope: "/sources",
  }, maxBytes);
}

export function summarizeToolInputForSpan(
  toolName: string,
  input: unknown,
  maxBytes = getToolIoMaxBytes(),
  folderSourceHostRoots: readonly string[] = [],
): unknown {
  return summarizeFolderSourceToolIoForSpan(toolName, input, "input", maxBytes, folderSourceHostRoots) ??
    summarizeToolValue(input, maxBytes);
}

export function summarizeToolOutputForSpan(
  toolName: string,
  output: unknown,
  maxBytes = getToolIoMaxBytes(),
  folderSourceHostRoots: readonly string[] = [],
): unknown {
  const record = asRecord(output);
  if (toolName === "readDocument" && record) {
    return summarizeToolValue(summarizeReadDocumentOutputForSpan(record), maxBytes);
  }
  if (toolName === "searchDocuments" && record) {
    return summarizeToolValue(summarizeSearchDocumentsOutputForSpan(record), maxBytes);
  }
  const folderSourceSummary = summarizeFolderSourceToolIoForSpan(
    toolName,
    output,
    "output",
    maxBytes,
    folderSourceHostRoots,
  );
  if (folderSourceSummary) return folderSourceSummary;
  return summarizeToolValue(output, maxBytes);
}

export function markToolIoSpanSuspended(
  span: Span<SpanType.TOOL_CALL> | null | undefined,
): void {
  if (!span) return;
  try {
    span.end({
      attributes: { success: true },
      metadata: { status: "suspended" },
      output: { status: "suspended" },
    });
  } catch (err) {
    logger.warn("markToolIoSpanSuspended failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
