export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopQuitCoordinatorOptions {
  telemetryEnabled: () => boolean;
  captureAppClosed: () => void;
  shutdownTelemetry: () => Promise<void>;
  drainServer: () => Promise<void>;
  stopExternalInstance: () => Promise<void>;
  quit: () => void;
}

export interface DesktopQuitCoordinator {
  handleBeforeQuit(event: BeforeQuitEvent): Promise<void> | undefined;
}

/**
 * 把 Electron before-quit 的递归 app.quit() 变成一次性异步闸门。
 * 会话排空不依赖遥测开关；重复 before-quit 复用同一 completion。
 */
export function createDesktopQuitCoordinator(
  options: DesktopQuitCoordinatorOptions,
): DesktopQuitCoordinator {
  let completion: Promise<void> | undefined;
  let resumed = false;

  return {
    handleBeforeQuit(event) {
      if (resumed) return undefined;
      event.preventDefault();
      if (completion) return completion;

      const telemetryEnabled = options.telemetryEnabled();
      if (telemetryEnabled) options.captureAppClosed();
      const telemetryShutdown = telemetryEnabled
        ? options.shutdownTelemetry()
        : Promise.resolve();
      completion = Promise.allSettled([
        options.drainServer(),
        options.stopExternalInstance(),
        telemetryShutdown,
      ]).then(() => {
        resumed = true;
        options.quit();
      });
      return completion;
    },
  };
}
