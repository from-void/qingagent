// 桌面更新推送(onUpdateStatus)的单一订阅源:AppUpdateWatcher(软更 toast / 强更 Modal)与
// 关于页共用这一份订阅,避免各自独立挂 IPC 监听「双订阅打架」。用引用计数管理底层 IPC 监听的
// 挂载/卸载(订阅者从 0→1 挂,1→0 卸),配合 useSyncExternalStore 使用。
//
// 注意:手动检查(checkForUpdate)走请求-响应,不经此 store;此 store 只承载被动推送
// (下载完成 soft-ready、强更 force 等)。

export type DesktopUpdateStatus = {
  kind: "soft-ready" | "soft-available" | "force" | "mac-manual" | "none" | "error";
  version?: string;
  notesUrl?: string;
};

type Listener = () => void;

let snapshot: DesktopUpdateStatus | null = null;
const listeners = new Set<Listener>();
let detachIpc: (() => void) | null = null;

function ensureAttached(): void {
  if (detachIpc) return;
  const electron = window.electron;
  if (!electron?.isDesktop || !electron.onUpdateStatus) return;
  detachIpc = electron.onUpdateStatus((payload) => {
    snapshot = payload as DesktopUpdateStatus;
    for (const listener of [...listeners]) listener();
  });
}

export function subscribeDesktopUpdate(listener: Listener): () => void {
  listeners.add(listener);
  ensureAttached();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachIpc) {
      detachIpc();
      detachIpc = null;
    }
  };
}

// useSyncExternalStore 的 getSnapshot:返回稳定引用(仅推送到来时才换新对象)。
export function getDesktopUpdateSnapshot(): DesktopUpdateStatus | null {
  return snapshot;
}

// 单测复位:清快照、卸载 IPC 监听、清订阅者,避免模块级单例跨用例泄漏。
export function resetDesktopUpdateStoreForTest(): void {
  snapshot = null;
  if (detachIpc) {
    detachIpc();
    detachIpc = null;
  }
  listeners.clear();
}
