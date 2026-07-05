export interface ProbeRedactionOptions {
  dataDir?: string;
  resourcesPath?: string;
  sandboxBinDir?: string;
  execDir?: string;
}

const ENV_KEY_RE = /(^|_)(env|environment)$/i;
const PATH_KEY_RE = /path/i;

function sortedReplacements(options: ProbeRedactionOptions): Array<[string, string]> {
  return [
    [options.dataDir, "<DATA_DIR>"],
    [options.resourcesPath, "<RESOURCES>"],
    [options.sandboxBinDir, "<SANDBOX_BIN_DIR>"],
    [options.execDir, "<EXEC_DIR>"],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[0]))
    .sort((a, b) => b[0].length - a[0].length);
}

function redactString(value: string, replacements: Array<[string, string]>): string {
  let out = value;
  for (const [needle, replacement] of replacements) {
    out = out.split(needle).join(replacement);
  }
  return out;
}

function redactEnvObject(value: Record<string, unknown>, replacements: Array<[string, string]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PATH_KEY_RE.test(key) && typeof nested === "string") {
      out[key] = redactString(nested, replacements);
    } else if (typeof nested === "string") {
      out[key] = "<redacted>";
    } else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      out[key] = redactEnvObject(nested as Record<string, unknown>, replacements);
    } else {
      out[key] = redactProbeValue(nested, replacements);
    }
  }
  return out;
}

function redactProbeValue(value: unknown, replacements: Array<[string, string]>, key?: string): unknown {
  if (typeof value === "string") return redactString(value, replacements);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactProbeValue(item, replacements));
  const record = value as Record<string, unknown>;
  if (key && ENV_KEY_RE.test(key)) return redactEnvObject(record, replacements);

  const out: Record<string, unknown> = {};
  for (const [nestedKey, nested] of Object.entries(record)) {
    out[nestedKey] = redactProbeValue(nested, replacements, nestedKey);
  }
  return out;
}

export function redactProbe<T>(probe: T, options: ProbeRedactionOptions = {}): T {
  return redactProbeValue(probe, sortedReplacements(options)) as T;
}
