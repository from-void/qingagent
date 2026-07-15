export const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const UPLOAD_BODY_OVERHEAD_BYTES = 64 * 1024;

const MAX_CONFIGURED_FILE_BYTES = Math.floor(
  (Number.MAX_SAFE_INTEGER - UPLOAD_BODY_OVERHEAD_BYTES) * 3 / 4,
);

export function resolveUploadMaxBytes(raw = process.env.QINGAGENT_UPLOAD_MAX_BYTES): number {
  if (raw == null || raw.trim() === "") return DEFAULT_UPLOAD_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_CONFIGURED_FILE_BYTES) {
    return DEFAULT_UPLOAD_MAX_BYTES;
  }
  return parsed;
}

export function uploadBodyMaxBytes(maxBytes: number): number {
  return Math.ceil(maxBytes * 4 / 3) + UPLOAD_BODY_OVERHEAD_BYTES;
}
