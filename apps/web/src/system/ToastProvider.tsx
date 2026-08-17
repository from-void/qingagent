import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CloseIcon } from "./icons";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastShowOptions {
  message: string;
  durationMs?: number;
  tone?: ToastTone;
  sticky?: boolean;
  role?: "status" | "alert";
  action?: ToastAction;
  dedupeKey?: string;
  onDismiss?: () => void;
}

export interface ToastDismissOptions {
  runOnDismiss?: boolean;
}

export type ToastShow = {
  (message: string, durationMs?: number): string;
  (options: ToastShowOptions): string;
};

interface ToastContextValue {
  show: ToastShow;
  dismiss: (target: string, options?: ToastDismissOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
}

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  sticky: boolean;
  durationMs: number;
  role: "status" | "alert";
  action?: ToastAction;
  dedupeKey?: string;
  onDismiss?: () => void;
}

interface ToastState {
  items: ToastItem[];
  dismissedCallbacks: Array<() => void>;
}

const DEFAULT_TOAST_DURATION_MS = 2400;
const MAX_TOASTS = 3;

function capToastItems(input: ToastItem[]): { kept: ToastItem[]; removed: ToastItem[] } {
  const kept = input.slice();
  const removed: ToastItem[] = [];
  while (kept.length > MAX_TOASTS) {
    const removableIndex = (() => {
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        const toast = kept[index];
        if (toast && !toast.sticky) return index;
      }
      return kept.length - 1;
    })();
    const [toast] = kept.splice(removableIndex, 1);
    if (toast) removed.push(toast);
  }
  return { kept, removed };
}

/**
 * App-level toast host. Pages call `useToast().show(...)` instead of
 * mounting their own ephemeral status DOM. The shell renders the single
 * `.qa-toast` family, stacked from the bottom center.
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [state, setState] = useState<ToastState>({
    items: [],
    dismissedCallbacks: [],
  });
  const nextIdRef = useRef(1);

  const dismiss = useCallback((target: string, options?: ToastDismissOptions) => {
    setState((current) => {
      const removed: ToastItem[] = [];
      const kept = current.items.filter((item) => {
        const hit = item.id === target || item.dedupeKey === target;
        if (hit) removed.push(item);
        return !hit;
      });
      const dismissedCallbacks = options?.runOnDismiss === false
        ? current.dismissedCallbacks
        : [
            ...current.dismissedCallbacks,
            ...removed.flatMap((item) => item.onDismiss ? [item.onDismiss] : []),
          ];
      return { items: kept, dismissedCallbacks };
    });
  }, []);

  const show = useCallback<ToastShow>((input: string | ToastShowOptions, durationMs?: number) => {
    const options: ToastShowOptions = typeof input === "string" ? { message: input, durationMs } : input;
    const fallbackId = `toast-${nextIdRef.current++}`;
    const target = options.dedupeKey ?? fallbackId;

    setState((current) => {
      const existing = options.dedupeKey
        ? current.items.find((item) => item.dedupeKey === options.dedupeKey)
        : null;
      const id = existing?.id ?? fallbackId;
      const sticky = options.sticky ?? options.tone === "error";
      const item: ToastItem = {
        id,
        message: options.message,
        tone: options.tone ?? "info",
        sticky,
        durationMs: options.durationMs ?? DEFAULT_TOAST_DURATION_MS,
        role: options.role ?? (sticky || options.tone === "error" ? "alert" : "status"),
        action: options.action,
        dedupeKey: options.dedupeKey,
        onDismiss: options.onDismiss,
      };
      const withoutDuplicate = options.dedupeKey
        ? current.items.filter((currentItem) => currentItem.dedupeKey !== options.dedupeKey)
        : current.items;
      const { kept, removed } = capToastItems([item, ...withoutDuplicate]);
      return {
        items: kept,
        dismissedCallbacks: [
          ...current.dismissedCallbacks,
          ...removed.flatMap((removedItem) => removedItem.onDismiss ? [removedItem.onDismiss] : []),
        ],
      };
    });

    return target;
  }, []);

  useEffect(() => {
    if (state.dismissedCallbacks.length === 0) return;
    const callbacks = state.dismissedCallbacks;
    // 先排队清空，再执行用户回调；若回调同步 show/dismiss，后续更新会基于已清空的队列。
    setState((current) => current.dismissedCallbacks === callbacks
      ? { ...current, dismissedCallbacks: [] }
      : current);
    for (const callback of callbacks) callback();
  }, [state.dismissedCallbacks]);

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [dismiss, show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="qa-toast-stack" data-wf="GlobalToastHost" aria-live="polite" aria-relevant="additions">
        {state.items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const scheduleDismiss = useCallback(() => {
    if (item.sticky) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => onDismiss(item.id), item.durationMs);
  }, [clearTimer, item.durationMs, item.id, item.sticky, onDismiss]);

  useEffect(() => {
    scheduleDismiss();
    return clearTimer;
  }, [clearTimer, scheduleDismiss]);

  const toneClass = item.tone === "info" ? "" : ` ${item.tone}`;
  const stickyClass = item.sticky ? " sticky" : "";
  return (
    <div
      className={`qa-toast${toneClass}${stickyClass}`}
      data-wf="GlobalToast"
      data-toast-key={item.dedupeKey}
      role={item.role}
      onMouseEnter={clearTimer}
      onMouseLeave={scheduleDismiss}
    >
      <span className="qa-toast-msg">{item.message}</span>
      {item.action ? (
        <button
          className="qa-toast-act"
          type="button"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      {item.sticky ? (
        <button className="qa-toast-x" type="button" aria-label="关闭" onClick={() => onDismiss(item.id)}>
          <CloseIcon size={14} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Read the toast handle. Pages outside a `ToastProvider` get a no-op
 * (rather than crashing) so unit tests can render fragments without
 * setting up the full app shell.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    show(msg) {
      // eslint-disable-next-line no-console
      console.debug("[toast:no-provider]", msg);
      return "noop-toast";
    },
    dismiss() {
      /* no provider */
    },
  };
}
