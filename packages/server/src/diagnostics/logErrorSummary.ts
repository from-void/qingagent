const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_TOP_N = 20;
const MAX_PREFIX_CHARS = 120;
const MAX_SUMMARY_BYTES = 16 * 1024;

interface SummaryItem {
  key: string;
  level: string;
  count: number;
  latestAt: number;
  files: Set<string>;
}

/** 从日志文本行提取最近 windowHours 内的 ERROR/WARN,按"归一化消息前缀"聚合计数,取 top N。 */
export function summarizeLogErrors(
  files: { path: string; content: string }[],
  opts: { windowHours?: number; topN?: number } = {},
): string {
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const cutoff = Date.now() - Math.max(0, windowHours) * 60 * 60 * 1000;
  const items = new Map<string, SummaryItem>();

  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const parsed = parseLogLine(line);
      if (!parsed || parsed.time < cutoff) continue;
      const normalized = normalizeMessagePrefix(parsed.message);
      const key = `${parsed.level}\0${normalized}`;
      const item = items.get(key) ?? {
        key: normalized,
        level: parsed.level,
        count: 0,
        latestAt: parsed.time,
        files: new Set<string>(),
      };
      item.count += 1;
      item.latestAt = Math.max(item.latestAt, parsed.time);
      item.files.add(file.path);
      items.set(key, item);
    }
  }

  const sorted = Array.from(items.values())
    .sort((a, b) => b.count - a.count || b.latestAt - a.latestAt || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, topN));
  if (sorted.length === 0) return "无";

  return truncateUtf8(
    sorted.map((item, index) =>
      `${index + 1}. [${item.level}] count=${item.count} latest=${new Date(item.latestAt).toISOString()} files=${
        Array.from(item.files).sort().join(",")
      }\n   ${item.key}`
    ).join("\n"),
    MAX_SUMMARY_BYTES,
  );
}

function parseLogLine(line: string): { time: number; level: "ERROR" | "WARN"; message: string } | null {
  const match = /^\[([^\]]+)] \[(ERROR|WARN)] (.*)$/.exec(line);
  if (!match) return null;
  const time = Date.parse(match[1]!);
  if (!Number.isFinite(time)) return null;
  return { time, level: match[2]! as "ERROR" | "WARN", message: match[3]! };
}

function normalizeMessagePrefix(message: string): string {
  return message
    .slice(0, MAX_PREFIX_CHARS)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/(?:[A-Za-z]:)?(?:\/[\w .-]+){2,}/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<num>")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    try {
      return `${decoder.decode(bytes.slice(0, end))}\n[truncated]`;
    } catch {
      end -= 1;
    }
  }
  return "[truncated]";
}
