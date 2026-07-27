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
 * 会话排空不依赖遥测开关；重复 before-quit 复用同一 completion。到总 deadline
 * 后只继续等待有界的 server 排空（其失败出口会同步写恢复标记），不再受其他清理任务阻塞。
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
      const requestedDeadlineMs = options.deadlineMs ?? DESKTOP_QUIT_DEADLINE_MS;
      const deadlineMs = Number.isFinite(requestedDeadlineMs)
        ? Math.max(1, Math.floor(requestedDeadlineMs))
        : DESKTOP_QUIT_DEADLINE_MS;
      const deadlineAtMs = Date.now() + deadlineMs;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlineReached = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(resolve, deadlineMs);
        deadlineTimer.unref?.();
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
      const serverDrainSettled = serverDrain.then(
        () => undefined,
        () => undefined,
      );
      completion = Promise.race([
        allTasksSettled,
        Promise.all([deadlineReached, serverDrainSettled]).then(() => undefined),
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
