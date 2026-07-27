export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopQuitCoordinatorOptions {
  telemetryEnabled: () => boolean;
  captureAppClosed: () => void;
  shutdownTelemetry: () => Promise<void>;
  drainServer: (deadlineAtMs: number) => Promise<void>;
  stopExternalInstance: () => Promise<void>;
  quit: () => void;
  deadlineMs?: number;
}

export interface DesktopQuitCoordinator {
  handleBeforeQuit(event: BeforeQuitEvent): Promise<void> | undefined;
}

export const DESKTOP_QUIT_DEADLINE_MS = 10_000;

/**
 * 把 Electron before-quit 的递归 app.quit() 变成一次性异步闸门。
 * 会话排空不依赖遥测开关；重复 before-quit 复用同一 completion。总 deadline 从
 * before-quit 一进入就计时，期限到达后不再等待任何清理任务，直接放行退出。
 */
export function createDesktopQuitCoordinator(
  options: DesktopQuitCoordinatorOptions,
): DesktopQuitCoordinator {
  let completion: Promise<void> | undefined;
  let resumed = false;

  return {
    handleBeforeQuit(event) {
      if (resumed) return undefined;
      const enteredAtMs = Date.now();
      event.preventDefault();
      if (completion) return completion;

      const requestedDeadlineMs = options.deadlineMs ?? DESKTOP_QUIT_DEADLINE_MS;
      const deadlineMs = Number.isFinite(requestedDeadlineMs)
        ? Math.max(1, Math.floor(requestedDeadlineMs))
        : DESKTOP_QUIT_DEADLINE_MS;
      const deadlineAtMs = enteredAtMs + deadlineMs;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlineReached = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(
          resolve,
          Math.max(0, deadlineAtMs - Date.now()),
        );
        deadlineTimer.unref?.();
      });
      const telemetryShutdown = Promise.resolve().then(async () => {
        if (!options.telemetryEnabled()) return;
        options.captureAppClosed();
        await options.shutdownTelemetry();
      });
      const serverDrain = Promise.resolve().then(() =>
        options.drainServer(deadlineAtMs)
      );
      const externalInstanceStop = Promise.resolve().then(() =>
        options.stopExternalInstance()
      );
      const allTasksSettled = Promise.allSettled([
        serverDrain,
        externalInstanceStop,
        telemetryShutdown,
      ]).then(() => undefined);
      completion = Promise.race([
        allTasksSettled,
        deadlineReached,
      ]).finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }).then(() => {
        resumed = true;
        options.quit();
      });
      return completion;
    },
  };
}
