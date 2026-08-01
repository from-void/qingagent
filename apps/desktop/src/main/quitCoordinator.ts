export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopQuitCoordinatorOptions {
  hasActiveGeneration?: () => boolean | Promise<boolean>;
  confirmQuitDuringGeneration?: () => Promise<boolean>;
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
  handleWindowClose(event: BeforeQuitEvent): void;
}

export const DESKTOP_QUIT_DEADLINE_MS = 10_000;

/**
 * 把 Electron before-quit 的递归 app.quit() 变成一次性异步闸门。
 * 会话排空不依赖遥测开关；重复 before-quit 复用同一 completion。总 deadline 从
 * 用户确认退出后开始计时，期限到达后不再等待任何清理任务，直接放行退出。
 */
export function createDesktopQuitCoordinator(
  options: DesktopQuitCoordinatorOptions,
): DesktopQuitCoordinator {
  let completion: Promise<void> | undefined;
  let resumed = false;
  let windowCloseQuitRequested = false;

  return {
    handleBeforeQuit(event) {
      if (resumed) return undefined;
      event.preventDefault();
      if (completion) return completion;

      completion = (async () => {
        let generationActive = false;
        try {
          generationActive = await options.hasActiveGeneration?.() ?? false;
        } catch (error) {
          generationActive = true;
          console.warn("[desktop] 退出前无法确认生成状态，按生成中保护", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (generationActive) {
          let confirmed = false;
          try {
            confirmed = await options.confirmQuitDuringGeneration?.() ?? false;
          } catch (error) {
            console.warn("[desktop] 生成中退出确认未完成，保留应用", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (!confirmed) return;
        }

        const enteredAtMs = Date.now();
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
        await Promise.race([allTasksSettled, deadlineReached]).finally(() => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        });
        resumed = true;
        options.quit();
      })().finally(() => {
        if (!resumed) {
          completion = undefined;
          windowCloseQuitRequested = false;
        }
      });
      return completion;
    },
    handleWindowClose(event) {
      if (resumed) return;
      event.preventDefault();
      if (windowCloseQuitRequested) return;
      windowCloseQuitRequested = true;
      options.quit();
    },
  };
}
