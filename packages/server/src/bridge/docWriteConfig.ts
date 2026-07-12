export const DEFAULT_USER_VERSION_WINDOW_MS = 60_000;

export function readUserVersionWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QINGAGENT_USER_VERSION_WINDOW_MS;
  if (raw === undefined) return DEFAULT_USER_VERSION_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export const USER_VERSION_WINDOW_MS = readUserVersionWindowMs();
