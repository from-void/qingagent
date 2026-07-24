import { isSensitiveField, redactSensitiveText } from "@qingagent/core";

const HOME_PATH_RE = /\/(?:Users|home)\/[^/\s"'`),]+/g;
const FILE_URL_RE = /file:\/\/\/[^\s"'`),]+/gi;
const DRIVE_PATH_RE = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'`),]+/g;
const UNC_PATH_RE = /\\\\[^\s"'`),]+/g;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bbearer\s+[A-Za-z0-9._\-+/=]{3,}/gi, "Bearer [redacted]"],
  [/\b(cookie|set-cookie)\b(\s*[:=]\s*)[^\r\n]+/gi, "$1$2[redacted]"],
  [
    /\b(api[-_]?key|x-api-key|access[-_]?token|authorization|auth|token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{3,}/gi,
    "$1=[redacted]",
  ],
  [/\b(?:sk|pk|rk|phx|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9._-]{3,}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]"],
];

/** 诊断包文本脱敏的唯一出口。任何写入 zip 的文本必须先经过这里。 */
export function redactDiagnosticText(s: string): string {
  let redacted = redactSensitiveText(s);
  redacted = redacted.replace(HOME_PATH_RE, "~");
  redacted = redacted.replace(FILE_URL_RE, "file://[path]");
  redacted = redacted.replace(DRIVE_PATH_RE, "[path]");
  redacted = redacted.replace(UNC_PATH_RE, "[path]");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function redactValueDeep(v: unknown): unknown {
  return redactValueDeepInner(v, new WeakMap<object, unknown>());
}

function redactValueDeepInner(v: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof v === "string") return redactDiagnosticText(v);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) {
    return {
      name: v.name,
      message: redactDiagnosticText(v.message),
      stack: v.stack ? redactDiagnosticText(v.stack) : undefined,
      cause: redactValueDeepInner(v.cause, seen),
    };
  }
  const cached = seen.get(v);
  if (cached) return cached;

  if (Array.isArray(v)) {
    const out: unknown[] = [];
    seen.set(v, out);
    for (const item of v) out.push(redactValueDeepInner(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    out[key] = isSensitiveField(key) ? "***" : redactValueDeepInner(value, seen);
  }
  return out;
}
