import { useCallback, useEffect, useRef } from "react";

export interface VisibilitySchedulerHandle {
  stop: () => void;
  wake: () => void;
}

export interface VisibilityPausedOptions {
  element?: Element | null;
  enabled?: boolean;
  runOnResume?: boolean;
}

type IntervalCallback = () => void;
type RafCallback = (timestamp: DOMHighResTimeStamp) => boolean | void;

interface SchedulerState {
  active: boolean;
  documentVisible: boolean;
  elementVisible: boolean;
  stopped: boolean;
}

export function createVisibilityPausedInterval(
  callback: IntervalCallback,
  delayMs: number,
  options: VisibilityPausedOptions = {},
): VisibilitySchedulerHandle {
  const state: SchedulerState = {
    active: false,
    documentVisible: !isDocumentHidden(),
    elementVisible: true,
    stopped: options.enabled === false,
  };
  let intervalId: number | null = null;
  const observer = createVisibilityObserver(options.element ?? null, state, sync);

  const onVisibilityChange = () => {
    state.documentVisible = !isDocumentHidden();
    if (!state.documentVisible) {
      pause();
      return;
    }
    if (options.runOnResume && shouldRun(state)) {
      callback();
    }
    sync();
  };

  function sync() {
    if (shouldRun(state)) {
      resume();
    } else {
      pause();
    }
  }

  function resume() {
    if (state.active) {
      return;
    }
    intervalId = window.setInterval(callback, delayMs);
    state.active = true;
  }

  function pause() {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
    state.active = false;
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  sync();

  return {
    stop: () => {
      state.stopped = true;
      pause();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
    wake: sync,
  };
}

export function createVisibilityPausedRaf(
  callback: RafCallback,
  options: VisibilityPausedOptions = {},
): VisibilitySchedulerHandle {
  const state: SchedulerState = {
    active: false,
    documentVisible: !isDocumentHidden(),
    elementVisible: true,
    stopped: options.enabled === false,
  };
  let rafId: number | null = null;
  let idle = true;
  const observer = createVisibilityObserver(options.element ?? null, state, () => {
    if (state.elementVisible) {
      wake();
    } else {
      sync();
    }
  });

  const onVisibilityChange = () => {
    state.documentVisible = !isDocumentHidden();
    if (!state.documentVisible) {
      pause();
      return;
    }
    wake();
  };

  const frame: FrameRequestCallback = (timestamp) => {
    rafId = null;
    state.active = false;
    if (!shouldRun(state)) {
      return;
    }
    const shouldContinue = callback(timestamp);
    if (shouldContinue === false) {
      idle = true;
      pause();
      return;
    }
    sync();
  };

  function sync() {
    if (!idle && shouldRun(state)) {
      resume();
    } else {
      pause();
    }
  }

  function resume() {
    if (state.active) {
      return;
    }
    rafId = window.requestAnimationFrame(frame);
    state.active = true;
  }

  function pause() {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    state.active = false;
  }

  function wake() {
    if (state.stopped) {
      return;
    }
    idle = false;
    sync();
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  wake();

  return {
    stop: () => {
      state.stopped = true;
      pause();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    },
    wake,
  };
}

export function useVisibilityPausedInterval(
  callback: IntervalCallback,
  delayMs: number | null,
  options: VisibilityPausedOptions = {},
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const enabled = options.enabled !== false && delayMs !== null;
  const element = options.element ?? null;
  const runOnResume = options.runOnResume === true;

  useEffect(() => {
    if (!enabled || delayMs === null) {
      return;
    }

    const handle = createVisibilityPausedInterval(
      () => callbackRef.current(),
      delayMs,
      { element, runOnResume },
    );
    return () => handle.stop();
  }, [delayMs, element, enabled, runOnResume]);
}

export function useVisibilityPausedRaf(
  callback: RafCallback,
  enabled = true,
  options: Omit<VisibilityPausedOptions, "enabled"> = {},
): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const wakeRef = useRef<() => void>(() => undefined);
  const wake = useCallback(() => {
    wakeRef.current();
  }, []);

  const element = options.element ?? null;

  useEffect(() => {
    if (!enabled) {
      wakeRef.current = () => undefined;
      return;
    }

    const handle = createVisibilityPausedRaf(
      (timestamp) => callbackRef.current(timestamp),
      { element },
    );
    wakeRef.current = handle.wake;
    return () => {
      if (wakeRef.current === handle.wake) {
        wakeRef.current = () => undefined;
      }
      handle.stop();
    };
  }, [element, enabled]);

  return wake;
}

function shouldRun(state: SchedulerState): boolean {
  return !state.stopped && state.documentVisible && state.elementVisible;
}

function isDocumentHidden(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.hidden;
}

function createVisibilityObserver(
  element: Element | null,
  state: SchedulerState,
  sync: () => void,
): IntersectionObserver | null {
  if (
    !element ||
    typeof IntersectionObserver === "undefined"
  ) {
    return null;
  }

  const observer = new IntersectionObserver((entries) => {
    const entry = entries[0];
    state.elementVisible = entry ? entry.isIntersecting : true;
    sync();
  });
  observer.observe(element);
  return observer;
}
