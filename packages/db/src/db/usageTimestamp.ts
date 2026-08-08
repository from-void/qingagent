/**
 * usage.created_at 的账务 canonical 形式。严格往返可同时拒绝不可解析日期、
 * 非三位毫秒文本与 SQLite 会接受但 JS 会归一化的 T24:00。
 */
export function isCanonicalUsageTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** 可解析文本归一化为 canonical UTC ISO；不可解析时返回 null。 */
export function canonicalizeUsageTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
