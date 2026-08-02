export interface DestroyableWebContents {
  isDestroyed(): boolean;
}

export interface WindowWithWebContents<TContents extends DestroyableWebContents> {
  isDestroyed(): boolean;
  readonly webContents: TContents;
}

/**
 * Electron 在 BrowserWindow.closed 之后要求不再使用窗口对象。必须先查窗口，再读取
 * webContents；这个顺序也避免已销毁窗口的 webContents getter 自身抛异常。
 */
export function getLiveWebContents<TContents extends DestroyableWebContents>(
  window: WindowWithWebContents<TContents> | null,
): TContents | null {
  if (!window || window.isDestroyed()) return null;
  const contents = window.webContents;
  return contents.isDestroyed() ? null : contents;
}

export interface DestroyableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

/** 供 abort/finally 等可能重复到达的清理路径幂等销毁隐藏窗。 */
export function destroyWindowIfAlive(window: DestroyableWindow | null): void {
  if (!window || window.isDestroyed()) return;
  window.destroy();
}
