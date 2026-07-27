export function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > 64) return null;
  return normalized;
}
