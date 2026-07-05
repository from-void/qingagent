import type { DiagLayer, DiagSpan, DiagSpanField, DiagStatus } from "@qingagent/contract-ts";
import type { AnyExportedSpan } from "@mastra/core/observability";
import { SpanType } from "@mastra/core/observability";

export const DEFAULT_DIAG_FIELD_BYTES = 4096;
export const DEFAULT_DIAG_ERROR_FIELD_BYTES = 16384;

export interface ClassifyDiagLayerInput {
  name: string;
  spanType: string | null | undefined;
  meta?: Record<string, unknown> | null;
}

export interface ExportedSpanToDiagSpanOptions {
  seq: number;
  parentKey?: string | null;
  fieldMaxBytes?: number;
  errorFieldMaxBytes?: number;
}

export function classifyDiagLayer(input: ClassifyDiagLayerInput): DiagLayer {
  const spanType = input.spanType ?? "";
  const eventKind = stringValue(input.meta?.eventKind);

  if (eventKind === "client_event") return "client";
  if (eventKind === "command") return "command";
  if (eventKind === "db_write") return "db";

  if (spanType === SpanType.AGENT_RUN) return "agent";
  if (
    spanType === SpanType.MODEL_GENERATION ||
    spanType === SpanType.MODEL_STEP ||
    spanType === SpanType.MODEL_INFERENCE
  ) {
    return "model";
  }
  if (spanType === SpanType.TOOL_CALL || spanType === SpanType.MCP_TOOL_CALL) {
    return "tool";
  }

  return "other";
}

export function truncateField(value: unknown, maxBytes: number): DiagSpanField {
  const summary = safeStringify(value);
  const bytes = utf8Bytes(summary);
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (bytes <= byteLimit) {
    return { summary, bytes, truncated: false };
  }
  return {
    summary: truncateUtf8(summary, byteLimit),
    bytes,
    truncated: true,
  };
}

export function statusFromError(
  errorInfo: unknown,
  meta?: Record<string, unknown> | null,
): DiagStatus {
  if (errorInfo !== undefined && errorInfo !== null) return "error";

  const status = stringValue(meta?.status) ?? stringValue(meta?.outcome);
  const reason =
    stringValue(meta?.reason) ??
    stringValue(meta?.failureReason) ??
    stringValue(meta?.errorKind) ??
    stringValue(meta?.code);
  const marker = `${status ?? ""} ${reason ?? ""}`.toLowerCase();
  if (marker.includes("timeout") || marker.includes("timedout") || marker.includes("timed_out")) {
    return "timeout";
  }
  if (
    marker.includes("abort") ||
    marker.includes("cancel") ||
    marker.includes("canceled") ||
    marker.includes("cancelled")
  ) {
    return "abort";
  }
  return "ok";
}

export function exportedSpanToDiagSpan(
  exportedSpan: AnyExportedSpan,
  opts: ExportedSpanToDiagSpanOptions,
): DiagSpan {
  const spanType = exportedSpan.type ? String(exportedSpan.type) : null;
  const meta = normalizeRecord(exportedSpan.metadata);
  const status = statusFromError(exportedSpan.errorInfo, meta);
  const fieldMaxBytes =
    status === "error"
      ? opts.errorFieldMaxBytes ?? DEFAULT_DIAG_ERROR_FIELD_BYTES
      : opts.fieldMaxBytes ?? DEFAULT_DIAG_FIELD_BYTES;
  const startedAt = dateMs(exportedSpan.startTime);
  const endedAt = dateMs(exportedSpan.endTime);
  const key = `${exportedSpan.traceId.slice(0, 8)}::${exportedSpan.name}::${spanType ?? ""}::${opts.seq}`;
  const output = fieldFromValue(exportedSpan.output, fieldMaxBytes);
  const usage = extractUsage(exportedSpan);
  if (output && usage !== undefined) {
    output.usage = usage;
  }

  return {
    key,
    traceId: exportedSpan.traceId,
    parentKey: opts.parentKey ?? null,
    sessionId: readCorrelationId("sessionId", exportedSpan),
    clientTraceId: readCorrelationId("clientTraceId", exportedSpan),
    layer: classifyDiagLayer({ name: exportedSpan.name, spanType, meta }),
    name: exportedSpan.name,
    spanType,
    startedAt,
    endedAt,
    durMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    status,
    input: fieldFromValue(exportedSpan.input, fieldMaxBytes),
    output,
    error: exportedSpan.errorInfo ?? null,
    meta,
    ...(isNoiseSpan(exportedSpan, meta) ? { noise: true } : {}),
  };
}

function fieldFromValue(value: unknown, maxBytes: number): DiagSpanField | null {
  if (value === undefined) return null;
  return truncateField(value, maxBytes);
}

function readCorrelationId(key: "sessionId" | "clientTraceId", exportedSpan: AnyExportedSpan): string | null {
  const metaValue = stringValue(exportedSpan.metadata?.[key]);
  if (metaValue) return metaValue;
  return stringValue(exportedSpan.requestContext?.[key]) ?? null;
}

function isNoiseSpan(exportedSpan: AnyExportedSpan, meta: Record<string, unknown>): boolean {
  if (exportedSpan.type === SpanType.MODEL_CHUNK) return true;
  const eventKind = stringValue(meta.eventKind)?.toLowerCase() ?? "";
  const name = exportedSpan.name.toLowerCase();
  return eventKind.includes("heartbeat") || name.includes("heartbeat");
}

function extractUsage(exportedSpan: AnyExportedSpan): unknown {
  const outputUsage = recordValue(exportedSpan.output)?.usage;
  if (outputUsage !== undefined) return outputUsage;
  return recordValue(exportedSpan.attributes)?.usage;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return `${current.toString()}n`;
      if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
      if (typeof current === "symbol") return current.toString();
      if (current instanceof Error) {
        return {
          name: current.name,
          message: current.message,
          stack: current.stack,
          cause: current.cause,
        };
      }
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    });
    return json === undefined ? String(value) : json;
  } catch (err) {
    return JSON.stringify({
      unserializable: true,
      summary: value instanceof Error ? value.message : String(value),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bytes = encoder.encode(value);
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function dateMs(value: Date | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return recordValue(value) ?? {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
