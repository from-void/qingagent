import { createRequire } from "node:module";
import os from "node:os";
import JSZip from "jszip";
import {
  DIAG_SCHEMA_VERSION,
  type DiagManifest,
  type DiagSection,
  type DiagSpan,
} from "@qingagent/contract-ts";
import { collectFrameLogs, collectLogs, collectSpans, type CollectedFrameLogFile, type CollectedTextFile } from "./collect.js";
import { redactDiagnosticText, redactValueDeep } from "./redact.js";
import { collectEnvSnapshot, collectSettingsSnapshot } from "./snapshot.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

const LOGS_DAYS = 7;
const SPAN_DAYS = 7;
const FRAMELOG_SESSIONS = 20;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_REPORT_BYTES = 128 * 1024;

export interface BuildDiagnosticsZipOptions {
  privacyLevel: "L1" | "L2";
  report?: string;
  /** 用户在「报bug」里勾选的具体文档(会话)id;不传则回退到最近 FRAMELOG_SESSIONS 个会话。 */
  sessionIds?: string[];
}

interface ZipEntry {
  path: string;
  content: string;
}

export async function buildDiagnosticsZip(
  opts: BuildDiagnosticsZipOptions,
): Promise<{ buffer: Buffer; manifest: DiagManifest; filename: string }> {
  const createdAt = new Date();
  const logsDir = process.env.QINGAGENT_LOG_DIR;
  const [envSnapshot, settingsSnapshot, logs, spans, frameLogs] = await Promise.all([
    Promise.resolve(collectEnvSnapshot()),
    collectSettingsSnapshot(),
    collectLogs(logsDir, LOGS_DAYS),
    collectSpans({ logsDir, spanDays: SPAN_DAYS, privacyLevel: opts.privacyLevel }),
    collectFrameLogs(opts.privacyLevel, { maxSessions: FRAMELOG_SESSIONS, sessionIds: opts.sessionIds }),
  ]);

  const report = truncateReport(redactDiagnosticText(opts.report ?? ""));
  const state = {
    report: report.content,
    envJson: `${JSON.stringify(redactValueDeep(envSnapshot), null, 2)}\n`,
    settingsJson: `${JSON.stringify(redactValueDeep(settingsSnapshot), null, 2)}\n`,
    logs: [...logs],
    spans: [...spans],
    frameLogs: [...frameLogs],
    truncated: new Set<string>(),
  };
  if (report.truncated) state.truncated.add("report");

  let manifest = makeManifest(opts.privacyLevel, createdAt, state);
  let buffer = await renderZip(makeEntries(state, manifest));

  while (buffer.byteLength > MAX_ZIP_BYTES && trimOldest(state)) {
    manifest = makeManifest(opts.privacyLevel, createdAt, state);
    buffer = await renderZip(makeEntries(state, manifest));
  }

  return {
    buffer,
    manifest,
    filename: `qingagent-diag-v1-${formatFilenameDate(createdAt)}.zip`,
  };
}

function makeEntries(state: {
  report: string;
  envJson: string;
  settingsJson: string;
  logs: CollectedTextFile[];
  spans: DiagSpan[];
  frameLogs: CollectedFrameLogFile[];
}, manifest: DiagManifest): ZipEntry[] {
  return [
    { path: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "report.txt", content: state.report },
    { path: "env.json", content: state.envJson },
    { path: "settings.json", content: state.settingsJson },
    ...state.logs.map((file) => ({ path: file.path, content: file.content })),
    {
      path: "spans.jsonl",
      content: state.spans.length > 0
        ? `${state.spans.map((span) => JSON.stringify(redactValueDeep(span))).join("\n")}\n`
        : "",
    },
    ...state.frameLogs.map((file) => ({ path: file.path, content: file.content })),
  ];
}

async function renderZip(entries: ZipEntry[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.path, entry.content);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function makeManifest(
  privacyLevel: "L1" | "L2",
  createdAt: Date,
  state: {
    report: string;
    logs: CollectedTextFile[];
    spans: DiagSpan[];
    frameLogs: CollectedFrameLogFile[];
    truncated: Set<string>;
  },
): DiagManifest {
  const sections: DiagSection[] = [
    section("report", ["report.txt"], state.report.length > 0 ? 1 : 0, state.truncated.has("report")),
    section("env", ["env.json"], 1, false),
    section("settings", ["settings.json"], 1, false),
    section("logs", state.logs.map((file) => file.path), state.logs.length, state.truncated.has("logs")),
    section("spans", ["spans.jsonl"], state.spans.length, state.truncated.has("spans")),
    section(
      "framelog",
      state.frameLogs.map((file) => file.path),
      state.frameLogs.reduce((sum, file) => sum + file.frameCount, 0),
      state.truncated.has("framelog"),
    ),
  ];

  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    appVersion: process.env.QINGAGENT_APP_VERSION ?? packageJson.version ?? "0.0.0",
    buildSha: process.env.QINGAGENT_BUILD_SHA ?? process.env.GITHUB_SHA ?? "unknown",
    platform: {
      os: os.platform(),
      arch: os.arch(),
      runtime: process.env.QINGAGENT_RUNTIME === "desktop" ? "desktop" : "server",
    },
    createdAt: createdAt.toISOString(),
    privacyLevel,
    sections,
    ranges: {
      logsDays: LOGS_DAYS,
      spanDays: SPAN_DAYS,
      framelogSessions: FRAMELOG_SESSIONS,
    },
    userReportPresent: state.report.trim().length > 0,
  };
}

function section(name: string, files: string[], count: number, truncated: boolean): DiagSection {
  return { name, files, count, truncated };
}

function trimOldest(state: {
  logs: CollectedTextFile[];
  spans: DiagSpan[];
  frameLogs: CollectedFrameLogFile[];
  truncated: Set<string>;
}): boolean {
  const oldestLog = state.logs[0];
  const oldestSpanTime = state.spans[0]?.startedAt ?? null;
  const oldestFrame = state.frameLogs[0];
  const candidates = [
    oldestLog ? { kind: "logs" as const, time: oldestLog.mtime } : null,
    oldestSpanTime !== null ? { kind: "spans" as const, time: oldestSpanTime } : null,
    oldestFrame ? { kind: "framelog" as const, time: oldestFrame.mtime } : null,
  ]
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.time - b.time);

  const target = candidates[0]?.kind;
  if (!target) return false;
  state.truncated.add(target);
  if (target === "logs") {
    state.logs.shift();
    return true;
  }
  if (target === "spans") {
    state.spans.splice(0, Math.max(1, Math.ceil(state.spans.length * 0.1)));
    return true;
  }
  state.frameLogs.shift();
  return true;
}

function truncateReport(value: string): { content: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_REPORT_BYTES) return { content: value, truncated: false };
  return {
    content: `${truncateUtf8(value, MAX_REPORT_BYTES)}\n[truncated]\n`,
    truncated: true,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
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

function formatFilenameDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}
