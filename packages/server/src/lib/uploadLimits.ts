export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export function resolveUploadMaxBytes(raw = process.env.QINGAGENT_UPLOAD_MAX_BYTES): number {
  if (raw == null || raw.trim() === "") return DEFAULT_UPLOAD_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_UPLOAD_MAX_BYTES;
  }
  return parsed;
}
