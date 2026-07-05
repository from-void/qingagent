export const DIAG_SCHEMA_VERSION = 1;

export type DiagLayer =
  | "client"
  | "command"
  | "model"
  | "tool"
  | "db"
  | "agent"
  | "other";

export type DiagStatus = "ok" | "error" | "abort" | "timeout";

export interface DiagSpanField {
  summary: string;
  bytes: number;
  truncated: boolean;
  usage?: unknown;
}

export interface DiagSpan {
  key: string;
  traceId: string;
  parentKey: string | null;
  sessionId: string | null;
  clientTraceId: string | null;
  layer: DiagLayer;
  name: string;
  spanType: string | null;
  startedAt: number | null;
  endedAt: number | null;
  durMs: number | null;
  status: DiagStatus;
  input: DiagSpanField | null;
  output: DiagSpanField | null;
  error: unknown | null;
  meta: Record<string, unknown>;
  /** model_chunk/心跳类高频低值，console 默认过滤。 */
  noise?: boolean;
}

export interface DiagSection {
  name: string;
  files: string[];
  count: number;
  truncated: boolean;
}

export interface DiagManifest {
  schemaVersion: 1;
  appVersion: string;
  buildSha: string;
  platform: {
    os: string;
    arch: string;
    runtime: "desktop" | "server";
  };
  createdAt: string;
  privacyLevel: "L1" | "L2";
  sections: DiagSection[];
  ranges: {
    logsDays: number;
    spanDays: number;
    framelogSessions: number;
  };
  userReportPresent: boolean;
}
