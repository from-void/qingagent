import { useSyncExternalStore } from "react";

type Listener = () => void;

let snapshot: ElectronBackendConnectionSnapshot | null = (() => {
  if (typeof window === "undefined") return null;
  try { return window.electron?.getBackendConnection?.() ?? null; } catch { return null; }
})();
let detachBridge: (() => void) | null = null;
const listeners = new Set<Listener>();

export function subscribeBackendConnection(listener: Listener): () => void {
  listeners.add(listener);
  if (!detachBridge && typeof window !== "undefined") {
    try {
      snapshot = window.electron?.getBackendConnection?.() ?? snapshot;
    } catch {
      // 首次订阅读取失败时保留启动快照；后续 IPC 事件仍可恢复。
    }
    detachBridge = window.electron?.onBackendConnectionChanged?.((next) => {
      snapshot = next;
      for (const current of [...listeners]) current();
    }) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    detachBridge?.();
    detachBridge = null;
  };
}

export function getBackendConnectionSnapshot(): ElectronBackendConnectionSnapshot | null {
  return snapshot;
}

export function useBackendConnection(): ElectronBackendConnectionSnapshot | null {
  return useSyncExternalStore(subscribeBackendConnection, getBackendConnectionSnapshot, () => null);
}

export function attachCapabilityEnabled(name: string): boolean {
  let current = snapshot;
  if (typeof window !== "undefined") {
    try {
      const latest = window.electron?.getBackendConnection?.() ?? null;
      if (latest) {
        snapshot = latest;
        current = latest;
      }
    } catch {
      // IPC 短暂不可用时保留最后一次主进程快照，仍按 fail-closed 能力值判断。
    }
  }
  return current?.mode !== "attach" || current.effectiveCapabilities[name] === true;
}
