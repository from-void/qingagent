import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BridgeFrame, DiagSpan } from "@qingagent/contract-ts";
import {
  DEFAULT_DIAG_ERROR_FIELD_BYTES,
  DEFAULT_DIAG_FIELD_BYTES,
  classifyDiagLayer,
  statusFromError,
  truncateField,
} from "@qingagent/core";
import { redactDiagnosticText, redactValueDeep } from "./redact.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_RE = /^(server|main)-\d{4}-\d{2}-\d{2}\.log$/;
const SPAN_FILE_RE = /^spans-\d{4}-\d{2}-\d{2}\.jsonl$/;

export interface CollectedTextFile {
  path: string;
  content: string;
  mtime: number;
}

export interface CollectedFrameLogFile {
  path: string;
  content: string;
  sessionId: string;
  frameCount: number;
  mtime: number;
}

interface DuckDbConnection {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
}

interface DuckDbStoreLike {
  db: {
    getConnection(): Promise<DuckDbConnection>;
    closeConnection(connection: DuckDbConnection): void;
  };
  close?: () => Promise<void> | void;
}

interface DuckSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanType: string | null;
  startedAt: number | null;
  endedAt: number | null;
  sessionId: string | null;
  requestContext: unknown;
  attributes: unknown;
  metadata: unknown;
  input: unknown;
  output: unknown;
  error: unknown;
}

interface FrameLogExportEntry {
  seq: number;
  epoch: number;
  generation: number;
  frame: BridgeFrame;
}

export async function collectLogs(logsDir: string | null | undefined, days = 7): Promise<CollectedTextFile[]> {
  if (!logsDir) return [];
  const cutoff = Date.now() - Math.max(0, days) * DAY_MS;
  const files = await listMatchingFiles(logsDir, LOG_FILE_RE, cutoff);
  const out: CollectedTextFile[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(file.absPath, "utf8");
      out.push({
        path: `logs/${file.name}`,
        content: redactLines(raw),
        mtime: file.mtime,
      });
    } catch {
      // 日志文件可能被滚动清理，跳过即可。
    }
  }
  return out;
}

export async function collectSpans(options: {
  logsDir?: string | null;
  spanDays?: number;
  duckdbPath?: string;
  privacyLevel?: "L1" | "L2";
} = {}): Promise<DiagSpan[]> {
  const logsDir = options.logsDir ?? process.env.QINGAGENT_LOG_DIR;
  const spanDays = options.spanDays ?? 7;
  const privacyLevel = options.privacyLevel ?? "L1";
  const spans = await collectSpansRaw(logsDir, spanDays, options.duckdbPath);
  // PRD F1 验收铁律:L1 包不得含文档正文/对话内容。span 的 input/output summary
  // 本地就是截断原文(最多 4KB),L1 时必须整体置换为占位,只保留长度与结构信号。
  return privacyLevel === "L1" ? spans.map(applyL1SpanPrivacy) : spans;
}

async function collectSpansRaw(
  logsDir: string | null | undefined,
  spanDays: number,
  duckdbPathOverride?: string,
): Promise<DiagSpan[]> {
  if (logsDir) {
    const jsonlSpans = await collectSpansFromJsonl(logsDir, spanDays);
    if (jsonlSpans.length > 0) return jsonlSpans;
  }
  if (process.env.QINGAGENT_RUNTIME === "desktop") return [];

  const duckdbPath = duckdbPathOverride ?? process.env.OBSERVABILITY_DUCKDB_PATH ?? "./observability.duckdb";
  if (!(await fileExists(duckdbPath))) return [];
  return collectSpansFromDuckDb(duckdbPath, spanDays);
}

/** L1 隐私:input/output 的截断原文替换为 [redacted:len=N],保留 bytes/truncated/usage。 */
export function applyL1SpanPrivacy(span: DiagSpan): DiagSpan {
  return {
    ...span,
    input: redactSpanField(span.input),
    output: redactSpanField(span.output),
  };
}

function redactSpanField(field: DiagSpan["input"]): DiagSpan["input"] {
  if (!field) return field;
  return { ...field, summary: `[redacted:len=${field.bytes}]` };
}

export async function collectFrameLogs(
  privacyLevel: "L1" | "L2",
  options: { maxSessions?: number; sessionIds?: string[] } = {},
): Promise<CollectedFrameLogFile[]> {
  const maxSessions = Math.max(0, Math.floor(options.maxSessions ?? 20));
  if (maxSessions === 0) return [];
  const bridge = await import("../bridge/bridgeHandler.js");
  const { sessionManager } = bridge;
  // 用户勾选了具体文档 → 只导出这些会话(去重 + 去空);否则回退到最近 maxSessions 个会话。
  const picked = Array.from(new Set((options.sessionIds ?? []).filter((id) => typeof id === "string" && id.length > 0)));
  const sessionIds = picked.length > 0 ? picked : sessionManager.listSessionIds(maxSessions);
  const out: CollectedFrameLogFile[] = [];
  for (const sessionId of sessionIds) {
    try {
      const read = sessionManager.frameLog.readFrom(sessionId, 0);
      let frames: FrameLogExportEntry[] = read.frames;
      let source: "frameLog" | "restore" = "frameLog";
      if (frames.length === 0) {
        const restored = await collectRestoreFrameLogEntries(bridge.collectRestoreFrames, sessionId, read.epoch);
        if (restored.length > 0) {
          frames = restored;
          source = "restore";
        }
      }
      if (frames.length === 0) {
        logFrameLogCollection({
          sessionId,
          privacyLevel,
          source,
          frameLogFrames: read.frames.length,
          exportedFrames: 0,
          summary: emptyFrameLogSummary(),
        });
        continue;
      }
      const redactedEntries = frames.map((entry) => redactFrameEntry(entry, privacyLevel));
      logFrameLogCollection({
        sessionId,
        privacyLevel,
        source,
        frameLogFrames: read.frames.length,
        exportedFrames: frames.length,
        summary: summarizeFrameLogEntries(redactedEntries),
      });
      const lines = redactedEntries.map((entry) => JSON.stringify(entry));
      out.push({
        path: `framelog/${safeSessionFilename(sessionId)}.jsonl`,
        content: `${lines.join("\n")}\n`,
        sessionId,
        frameCount: frames.length,
        mtime: lastFrameTime(frames),
      });
    } catch (error) {
      console.warn("[diagnostics] collectFrameLogs session failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // FrameLog 是诊断旁路，单会话失败不影响整包导出。
    }
  }
  return out;
}

async function collectRestoreFrameLogEntries(
  collectRestoreFrames: ((sessionId: string) => Promise<BridgeFrame[]>) | undefined,
  sessionId: string,
  epoch: number,
): Promise<FrameLogExportEntry[]> {
  if (typeof collectRestoreFrames !== "function") return [];
  try {
    const frames = await collectRestoreFrames(sessionId);
    return frames.map((frame, index) => ({
      seq: index + 1,
      epoch,
      generation: 0,
      frame,
    }));
  } catch (error) {
    console.warn("[diagnostics] collectFrameLogs restore fallback failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function collectSpansFromJsonl(logsDir: string, spanDays: number): Promise<DiagSpan[]> {
  const cutoff = Date.now() - Math.max(0, spanDays) * DAY_MS;
  const files = await listMatchingFiles(logsDir, SPAN_FILE_RE, cutoff);
  const spans: DiagSpan[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(file.absPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isDiagSpanLike(parsed)) {
            spans.push(redactValueDeep(parsed) as DiagSpan);
          }
        } catch {
          // 单行损坏跳过，保住其余 span。
        }
      }
    } catch {
      // 文件并发滚动时跳过。
    }
  }
  return spans.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

async function collectSpansFromDuckDb(duckdbPath: string, spanDays: number): Promise<DiagSpan[]> {
  const { DuckDBStore } = await importDuckDbStore();
  const store = new DuckDBStore({
    id: "qingagent-diagnostics-export",
    path: duckdbPath,
  }) as unknown as DuckDbStoreLike;
  const connection = await store.db.getConnection();
  try {
    const rows = await connection.runAndReadAll(buildDuckSpanQuery(spanDays));
    return rows.getRowObjects()
      .map(rowToDuckSpanRow)
      .filter((row): row is DuckSpanRow => row !== null)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .map(duckSpanMapper());
  } catch {
    return [];
  } finally {
    store.db.closeConnection(connection);
    await store.close?.();
  }
}

async function importDuckDbStore(): Promise<{
  DuckDBStore: new (config: { id: string; path: string }) => unknown;
}> {
  // 不能写字面量 dynamic import("@mastra/duckdb"):desktop build 会静态追踪到 native DuckDB。
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{ DuckDBStore: new (config: { id: string; path: string }) => unknown }>;
  return dynamicImport("@mastra/duckdb");
}

/**
 * 生成 row→DiagSpan 的映射闭包。稳定 key 表(trace+span → key)在第一行到来时
 * 基于全量 rows 构建一次(而不是每行重建,避免 O(n^2) 的 map 反复构建)。
 */
function duckSpanMapper(): (row: DuckSpanRow, index: number, rows: DuckSpanRow[]) => DiagSpan {
  let keyByTraceSpan: Map<string, string> | null = null;
  return (row, index, rows) => {
    if (!keyByTraceSpan) {
      keyByTraceSpan = new Map<string, string>();
      const seqByTraceNameType = new Map<string, number>();
      for (const candidate of rows) {
        const candidateType = candidate.spanType ?? "";
        const seqKey = `${candidate.traceId}::${candidate.name}::${candidateType}`;
        const seq = (seqByTraceNameType.get(seqKey) ?? 0) + 1;
        seqByTraceNameType.set(seqKey, seq);
        keyByTraceSpan.set(
          `${candidate.traceId}::${candidate.spanId}`,
          `${candidate.traceId.slice(0, 8)}::${candidate.name}::${candidateType}::${seq}`,
        );
      }
    }
    return duckSpanToDiagSpan(row, index, keyByTraceSpan);
  };
}

function duckSpanToDiagSpan(row: DuckSpanRow, index: number, keyByTraceSpan: Map<string, string>): DiagSpan {
  const spanType = row.spanType;
  const meta = recordValue(redactValueDeep(jsonValue(row.metadata))) ?? {};
  const attributes = jsonValue(row.attributes);
  const outputValue = redactValueDeep(jsonValue(row.output));
  const output = outputValue === undefined ? null : truncateRedactedField(outputValue, fieldLimitBytes(row.error, meta));
  const usage = recordValue(outputValue)?.usage ?? recordValue(jsonValue(attributes))?.usage;
  if (output && usage !== undefined) output.usage = redactValueDeep(usage);
  const error = redactValueDeep(jsonValue(row.error));
  const status = statusFromError(error, meta);
  const fieldLimit = status === "error" ? DEFAULT_DIAG_ERROR_FIELD_BYTES : DEFAULT_DIAG_FIELD_BYTES;
  const parentKey = row.parentSpanId
    ? keyByTraceSpan.get(`${row.traceId}::${row.parentSpanId}`) ?? null
    : null;

  return redactValueDeep({
    key: keyByTraceSpan.get(`${row.traceId}::${row.spanId}`) ??
      `${row.traceId.slice(0, 8)}::${row.name}::${spanType ?? ""}::${index + 1}`,
    traceId: row.traceId,
    parentKey,
    sessionId: row.sessionId ?? stringValue(recordValue(jsonValue(row.requestContext))?.sessionId),
    clientTraceId:
      stringValue(meta.clientTraceId) ??
      stringValue(recordValue(jsonValue(row.requestContext))?.clientTraceId),
    layer: classifyDiagLayer({ name: row.name, spanType, meta }),
    name: row.name,
    spanType,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durMs: row.startedAt !== null && row.endedAt !== null
      ? Math.max(0, row.endedAt - row.startedAt)
      : null,
    status,
    input: jsonValue(row.input) === undefined
      ? null
      : truncateRedactedField(redactValueDeep(jsonValue(row.input)), fieldLimit),
    output,
    error: error ?? null,
    meta,
    ...(isNoiseSpan(row, meta) ? { noise: true } : {}),
  }) as DiagSpan;
}

function fieldLimitBytes(error: unknown, meta: Record<string, unknown>): number {
  return statusFromError(error, meta) === "error" ? DEFAULT_DIAG_ERROR_FIELD_BYTES : DEFAULT_DIAG_FIELD_BYTES;
}

function truncateRedactedField(value: unknown, maxBytes: number) {
  const field = truncateField(value, maxBytes);
  return { ...field, summary: redactDiagnosticText(field.summary) };
}

function buildDuckSpanQuery(spanDays: number): string {
  const cutoff = duckTimestamp(new Date(Date.now() - Math.max(0, spanDays) * DAY_MS));
  return `
    SELECT
      traceId,
      spanId,
      arg_max(parentSpanId, timestamp) FILTER (WHERE parentSpanId IS NOT NULL) AS parentSpanId,
      arg_max(name, timestamp) FILTER (WHERE name IS NOT NULL) AS name,
      arg_max(spanType, timestamp) FILTER (WHERE spanType IS NOT NULL) AS spanType,
      coalesce(min(timestamp) FILTER (WHERE eventType = 'start'), min(timestamp)) AS startedAt,
      arg_max(endedAt, timestamp) FILTER (WHERE endedAt IS NOT NULL) AS endedAt,
      arg_max(sessionId, timestamp) FILTER (WHERE sessionId IS NOT NULL) AS sessionId,
      arg_max(requestContext, timestamp) FILTER (WHERE requestContext IS NOT NULL) AS requestContext,
      arg_max(attributes, timestamp) FILTER (WHERE attributes IS NOT NULL) AS attributes,
      arg_max(metadata, timestamp) FILTER (WHERE metadata IS NOT NULL) AS metadata,
      arg_max(input, timestamp) FILTER (WHERE input IS NOT NULL) AS input,
      arg_max(output, timestamp) FILTER (WHERE output IS NOT NULL) AS output,
      arg_max(error, timestamp) FILTER (WHERE error IS NOT NULL) AS error
    FROM span_events
    WHERE timestamp >= TIMESTAMP '${cutoff}'
    GROUP BY traceId, spanId
  `;
}

function rowToDuckSpanRow(row: Record<string, unknown>): DuckSpanRow | null {
  const traceId = stringValue(row.traceId);
  const spanId = stringValue(row.spanId);
  const name = stringValue(row.name);
  if (!traceId || !spanId || !name) return null;
  return {
    traceId,
    spanId,
    parentSpanId: stringValue(row.parentSpanId),
    name,
    spanType: stringValue(row.spanType),
    startedAt: timestampMs(row.startedAt),
    endedAt: timestampMs(row.endedAt),
    sessionId: stringValue(row.sessionId),
    requestContext: jsonValue(row.requestContext),
    attributes: jsonValue(row.attributes),
    metadata: jsonValue(row.metadata),
    input: jsonValue(row.input),
    output: jsonValue(row.output),
    error: jsonValue(row.error),
  };
}

async function listMatchingFiles(
  dir: string,
  pattern: RegExp,
  cutoffMtime: number,
): Promise<Array<{ name: string; absPath: string; mtime: number }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: Array<{ name: string; absPath: string; mtime: number }> = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    pattern.lastIndex = 0;
    const absPath = path.join(dir, name);
    try {
      const st = await stat(absPath);
      if (!st.isFile() || st.mtimeMs < cutoffMtime) continue;
      files.push({ name, absPath, mtime: st.mtimeMs });
    } catch {
      // 并发删除时跳过。
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}

function redactLines(raw: string): string {
  return raw.split(/\r?\n/).map((line) => redactDiagnosticText(line)).join("\n");
}

function redactFrameEntry(entry: unknown, privacyLevel: "L1" | "L2"): unknown {
  return redactFrameValue(entry, privacyLevel, "");
}

interface FrameLogContentSummary {
  documentFrames: number;
  chatMessages: number;
  visibleContentChars: number;
  redactedMarkers: number;
}

function emptyFrameLogSummary(): FrameLogContentSummary {
  return {
    documentFrames: 0,
    chatMessages: 0,
    visibleContentChars: 0,
    redactedMarkers: 0,
  };
}

function summarizeFrameLogEntries(entries: readonly unknown[]): FrameLogContentSummary {
  const summary = emptyFrameLogSummary();
  for (const entry of entries) {
    const frame = recordValue(entry)?.frame;
    const kind = stringValue(recordValue(frame)?.kind);
    if (kind === "documentSnapshotWritten") summary.documentFrames += 1;
    if (kind === "chatMessageAdded" || kind === "chatMessageAppended") summary.chatMessages += 1;
    walkFrameValue(entry, "", (value, key) => {
      if (!isFrameContentKey(key)) return;
      if (value.startsWith("[redacted:len=")) {
        summary.redactedMarkers += 1;
        return;
      }
      summary.visibleContentChars += value.length;
    });
  }
  return summary;
}

function walkFrameValue(
  value: unknown,
  key: string,
  visit: (value: string, key: string) => void,
): void {
  if (typeof value === "string") {
    visit(value, key);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkFrameValue(item, key, visit);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    walkFrameValue(childValue, childKey, visit);
  }
}

function logFrameLogCollection(input: {
  sessionId: string;
  privacyLevel: "L1" | "L2";
  source: "frameLog" | "restore";
  frameLogFrames: number;
  exportedFrames: number;
  summary: FrameLogContentSummary;
}): void {
  console.info("[diagnostics] collectFrameLogs session", input);
}

function redactFrameValue(value: unknown, privacyLevel: "L1" | "L2", key: string): unknown {
  if (typeof value === "string") {
    if (privacyLevel === "L1" && isFrameContentKey(key)) {
      return `[redacted:len=${value.length}]`;
    }
    return redactDiagnosticText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactFrameValue(item, privacyLevel, key));
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactFrameValue(childValue, privacyLevel, childKey);
  }
  return out;
}

function isFrameContentKey(key: string): boolean {
  return /^(text|content|delta|markdown|html|prompt|body|raw|answer|message|doc|document)$/i.test(key);
}

function isNoiseSpan(row: DuckSpanRow, meta: Record<string, unknown>): boolean {
  const spanType = row.spanType?.toLowerCase() ?? "";
  const eventKind = stringValue(meta.eventKind)?.toLowerCase() ?? "";
  const name = row.name.toLowerCase();
  return spanType.includes("model_chunk") || eventKind.includes("heartbeat") || name.includes("heartbeat");
}

function isDiagSpanLike(value: unknown): value is DiagSpan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" &&
    typeof record.traceId === "string" &&
    typeof record.name === "string" &&
    typeof record.layer === "string";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeSessionFilename(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session";
}

function lastFrameTime(frames: Array<{ seq: number }>): number {
  return frames.length > 0 ? frames[frames.length - 1]!.seq : 0;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function duckTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
