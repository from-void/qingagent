function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 后台进程的默认 TTL，同时也是模型显式 timeout 无法越过的硬上限。 */
export const SANDBOX_BACKGROUND_TTL_MS =
  positiveIntegerEnv("QINGAGENT_SANDBOX_BACKGROUND_TTL_MS", 8 * 60 * 60 * 1_000);

export function formatCommandDuration(timeoutMs: number): string {
  if (timeoutMs % (60 * 60 * 1_000) === 0) return `${timeoutMs / (60 * 60 * 1_000)} 小时`;
  if (timeoutMs % (60 * 1_000) === 0) return `${timeoutMs / (60 * 1_000)} 分钟`;
  if (timeoutMs % 1_000 === 0) return `${timeoutMs / 1_000} 秒`;
  return `${timeoutMs / 1_000} 秒`;
}
