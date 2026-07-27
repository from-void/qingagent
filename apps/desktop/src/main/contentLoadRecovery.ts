export const CONTENT_LOAD_MAX_RETRIES = 3;
export const CONTENT_LOAD_RETRY_BASE_DELAY_MS = 1_000;

export type ContentLoadRecoveryStep =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "prompt" };

export function nextContentLoadRecoveryStep(
  completedRetries: number,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
  } = {},
): ContentLoadRecoveryStep {
  const maxRetries = options.maxRetries ?? CONTENT_LOAD_MAX_RETRIES;
  if (completedRetries >= maxRetries) return { kind: "prompt" };

  const baseDelayMs = options.baseDelayMs ?? CONTENT_LOAD_RETRY_BASE_DELAY_MS;
  return {
    kind: "retry",
    attempt: completedRetries + 1,
    delayMs: baseDelayMs * 2 ** completedRetries,
  };
}
