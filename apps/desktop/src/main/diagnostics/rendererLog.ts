import type { WebContents } from "electron";
import { createRollingConsoleTransport } from "./rollingFiles.js";

const MAX_RENDERER_LINE_CHARS = 2000;
const transports = new Map<string, ReturnType<typeof createRollingConsoleTransport>>();

export function attachRendererDiagnostics(contents: WebContents, logDir: string): void {
  const transport = rendererTransport(logDir);

  contents.on("console-message", (_event, ...args: unknown[]) => {
    const parsed = parseConsoleMessageArgs(args);
    if (!parsed || (parsed.level !== "warning" && parsed.level !== "error")) return;
    transport.write(parsed.level === "error" ? "error" : "warn", [
      formatRendererConsoleLine({
        level: parsed.level,
        message: parsed.message,
        sourceId: parsed.sourceId,
        lineNumber: parsed.lineNumber,
      }),
    ]);
  });

  contents.on("render-process-gone", (_event, details) => {
    const reason = details?.reason ?? "unknown";
    const exitCode = details?.exitCode ?? "unknown";
    const line = `render-process-gone reason=${reason} exitCode=${exitCode}`;
    console.error("[renderer]", line);
    transport.write("error", [line]);
  });

  contents.on("unresponsive", () => {
    const line = "unresponsive";
    console.error("[renderer]", line);
    transport.write("error", [line]);
  });

  contents.on("responsive", () => {
    const line = "responsive";
    console.info("[renderer]", line);
    transport.write("info", [line]);
  });
}

export function formatRendererConsoleLine(input: {
  level: "warning" | "error";
  message: string;
  sourceId?: string;
  lineNumber?: number;
}): string {
  const source = input.sourceId ? ` source=${input.sourceId}` : "";
  const line = typeof input.lineNumber === "number" ? ` line=${input.lineNumber}` : "";
  return truncateRendererLine(`rendererConsole level=${input.level}${source}${line} message=${input.message}`);
}

export function truncateRendererLine(value: string, maxChars = MAX_RENDERER_LINE_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - "[truncated]".length))}[truncated]`;
}

function rendererTransport(logDir: string): ReturnType<typeof createRollingConsoleTransport> {
  const existing = transports.get(logDir);
  if (existing) return existing;
  const created = createRollingConsoleTransport(logDir, {
    prefix: "renderer",
    maxDays: 7,
    maxBytes: 20 * 1024 * 1024,
  });
  transports.set(logDir, created);
  return created;
}

function parseConsoleMessageArgs(args: unknown[]): {
  level: "warning" | "error" | "info" | "debug";
  message: string;
  sourceId?: string;
  lineNumber?: number;
} | null {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const record = first as Record<string, unknown>;
    const level = normalizeConsoleLevel(record.level);
    const message = typeof record.message === "string" ? record.message : "";
    if (!level || !message) return null;
    return {
      level,
      message,
      sourceId: typeof record.sourceId === "string" ? record.sourceId : undefined,
      lineNumber: typeof record.lineNumber === "number" ? record.lineNumber : undefined,
    };
  }

  const level = normalizeConsoleLevel(first);
  const message = typeof args[1] === "string" ? args[1] : "";
  if (!level || !message) return null;
  return {
    level,
    message,
    lineNumber: typeof args[2] === "number" ? args[2] : undefined,
    sourceId: typeof args[3] === "string" ? args[3] : undefined,
  };
}

function normalizeConsoleLevel(value: unknown): "warning" | "error" | "info" | "debug" | null {
  if (typeof value === "number") {
    if (value === 2) return "warning";
    if (value === 3) return "error";
    if (value === 1) return "info";
    return "debug";
  }
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (normalized === "warning" || normalized === "warn") return "warning";
  if (normalized === "error") return "error";
  if (normalized === "info" || normalized === "log") return "info";
  return "debug";
}
