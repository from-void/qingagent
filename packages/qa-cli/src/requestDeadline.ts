export interface RequestDeadline {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function createRequestDeadline(
  upstream: AbortSignal | null | undefined,
  timeoutMs: number,
): RequestDeadline {
  const controller = new AbortController();
  let timeoutReached = false;
  const onUpstreamAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) {
    onUpstreamAbort();
  } else {
    upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    },
  };
}
