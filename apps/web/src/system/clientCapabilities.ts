import { useSyncExternalStore } from "react";
import type { ClientCapabilities } from "@qingagent/contract-ts";

export async function fetchClientCapabilities(signal?: AbortSignal): Promise<ClientCapabilities> {
  const response = await fetch("/api/v1/capabilities", { signal });
  if (!response.ok) {
    throw new Error(`capabilities request failed: ${response.status}`);
  }
  return await response.json() as ClientCapabilities;
}

type Listener = () => void;

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

let snapshot: ClientCapabilities | null = null;
const listeners = new Set<Listener>();
let requestController: AbortController | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let detachLifecycleListeners: (() => void) | null = null;

function clearRetryTimer(): void {
  if (retryTimer === null) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function publish(next: ClientCapabilities): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function scheduleRetry(): void {
  if (
    listeners.size === 0 ||
    snapshot !== null ||
    retryTimer !== null
  ) {
    return;
  }
  const delay = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    RETRY_MAX_DELAY_MS,
  );
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void requestCapabilities();
  }, delay);
}

async function requestCapabilities(): Promise<void> {
  if (
    listeners.size === 0 ||
    snapshot !== null ||
    requestController !== null
  ) {
    return;
  }

  const controller = new AbortController();
  requestController = controller;
  try {
    const next = await fetchClientCapabilities(controller.signal);
    if (controller.signal.aborted || requestController !== controller) return;
    retryAttempt = 0;
    clearRetryTimer();
    publish(next);
  } catch (error) {
    if (controller.signal.aborted || requestController !== controller) return;
    console.error("[clientCapabilities] fetch failed", error);
    scheduleRetry();
  } finally {
    if (requestController === controller) requestController = null;
  }
}

function retryImmediately(): void {
  if (listeners.size === 0 || snapshot !== null) return;
  clearRetryTimer();
  void requestCapabilities();
}

function attachLifecycleListeners(): void {
  if (
    detachLifecycleListeners ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  const onFocus = () => retryImmediately();
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") retryImmediately();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  detachLifecycleListeners = () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    detachLifecycleListeners = null;
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    retryAttempt = 0;
    attachLifecycleListeners();
    void requestCapabilities();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearRetryTimer();
    retryAttempt = 0;
    const controller = requestController;
    requestController = null;
    controller?.abort();
    detachLifecycleListeners?.();
  };
}

function getSnapshot(): ClientCapabilities | null {
  return snapshot;
}

export function useClientCapabilities(): ClientCapabilities | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
