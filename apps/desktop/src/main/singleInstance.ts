export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

/**
 * 尽早取得 Electron 的 OS 级单实例锁，并把后续启动转交给当前窗口。
 * 返回 false 时调用方不得注册 ready/startServer 启动链。
 */
export function acquireSingleInstanceLock(
  app: SingleInstanceApp,
  getActiveWindow: () => FocusableWindow | null,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on("second-instance", () => {
    const window = getActiveWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  return true;
}
