export const RENDERER_RECOVERY_WINDOW_MS = 30_000;

export type ProcessLifecycleLog = (
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

export interface RenderingModeDetails {
  mode: "hardware" | "software";
  reason: "default" | "user-enabled" | "user-disabled" | "linux" | "unc-path";
}

export interface RenderProcessGoneDetailsLike {
  reason?: string;
  exitCode?: number;
}

export interface ChildProcessGoneDetailsLike {
  type?: string;
  reason?: string;
  exitCode?: number;
  serviceName?: string;
  name?: string;
}

export interface ProcessLifecycleWebContents {
  readonly id: number;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: RenderProcessGoneDetailsLike) => void,
  ): unknown;
  on(event: "unresponsive" | "responsive", listener: () => void): unknown;
  isDestroyed(): boolean;
  reload(): void;
  getURL?(): string;
  getOSProcessId?(): number;
}

export interface MainWindowProcessMonitor {
  requestGpuRecovery(details?: ChildProcessGoneDetailsLike): void;
}

export interface MainWindowProcessMonitorOptions {
  isQuitting: () => boolean;
  showRecoveryStopped: () => void | Promise<void>;
  log?: ProcessLifecycleLog;
  now?: () => number;
  schedule?: (task: () => void) => void;
  recoveryWindowMs?: number;
}

interface RecoveryIncident {
  trigger: "renderer-process-gone" | "gpu-process-gone";
  details: Record<string, unknown>;
}

const defaultLog: ProcessLifecycleLog = (level, event, details) => {
  console[level](`[process-lifecycle] ${event}`, details);
};

/** 每次主进程启动记录一行当前渲染模式，供空白屏事件统计时关联。 */
export function logRenderingMode(
  details: RenderingModeDetails,
  log: ProcessLifecycleLog = defaultLog,
): void {
  log("info", "rendering-mode", { ...details });
}

/**
 * 主窗口 renderer 进程观测与有限恢复。
 *
 * reload 刻意排到下一个 timer turn：Electron 39 的 renderer 死亡通知回调内同步
 * reload 仍可能撞到 Chromium teardown；同时按故障类型记录 30 秒窗口，第二次同类
 * 故障停止恢复，避免 crash → reload → crash 循环。
 */
export function attachMainWindowProcessMonitor(
  contents: ProcessLifecycleWebContents,
  options: MainWindowProcessMonitorOptions,
): MainWindowProcessMonitor {
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((task: () => void) => {
    setTimeout(task, 0);
  });
  const requestedWindowMs = options.recoveryWindowMs ?? RENDERER_RECOVERY_WINDOW_MS;
  const recoveryWindowMs = Number.isFinite(requestedWindowMs)
    ? Math.max(1, Math.floor(requestedWindowMs))
    : RENDERER_RECOVERY_WINDOW_MS;
  const lastFailureAt = new Map<RecoveryIncident["trigger"], number>();
  let reloadScheduled = false;
  let recoveryStopped = false;
  let nativeFallbackShown = false;
  let unresponsiveAt: number | null = null;

  const rendererContext = (): Record<string, unknown> => ({
    webContentsId: contents.id,
    osProcessId: safeRead(() => contents.getOSProcessId?.()) ?? "unknown",
    url: safeRead(() => contents.getURL?.()) ?? "unknown",
  });

  const showRecoveryStoppedOnce = (): void => {
    if (nativeFallbackShown) return;
    nativeFallbackShown = true;
    try {
      void Promise.resolve(options.showRecoveryStopped()).catch((error: unknown) => {
        log("error", "renderer-recovery-native-prompt-failed", {
          error: errorMessage(error),
        });
      });
    } catch (error) {
      log("error", "renderer-recovery-native-prompt-failed", {
        error: errorMessage(error),
      });
    }
  };

  const requestRecovery = (incident: RecoveryIncident): void => {
    if (recoveryStopped) {
      log("warn", "renderer-recovery", {
        ...incident.details,
        action: "skip",
        reason: "recovery-stopped",
        trigger: incident.trigger,
      });
      return;
    }
    if (options.isQuitting()) {
      log("info", "renderer-recovery", {
        ...incident.details,
        action: "skip",
        reason: "app-quitting",
        trigger: incident.trigger,
      });
      return;
    }

    const failureAt = now();
    const previousFailureAt = lastFailureAt.get(incident.trigger);
    if (
      previousFailureAt !== undefined &&
      failureAt - previousFailureAt < recoveryWindowMs
    ) {
      recoveryStopped = true;
      reloadScheduled = false;
      log("error", "renderer-recovery", {
        ...incident.details,
        action: "stop",
        reason: "repeated-process-failure",
        trigger: incident.trigger,
        elapsedMs: Math.max(0, failureAt - previousFailureAt),
        recoveryWindowMs,
      });
      showRecoveryStoppedOnce();
      return;
    }
    lastFailureAt.set(incident.trigger, failureAt);

    if (reloadScheduled) {
      log("info", "renderer-recovery", {
        action: "coalesce",
        reason: "reload-already-scheduled",
        trigger: incident.trigger,
        ...incident.details,
      });
      return;
    }
    reloadScheduled = true;
    log("warn", "renderer-recovery", {
      action: "schedule-reload",
      trigger: incident.trigger,
      recoveryWindowMs,
      ...incident.details,
    });

    schedule(() => {
      reloadScheduled = false;
      if (recoveryStopped) {
        log("warn", "renderer-recovery", {
          action: "skip",
          reason: "recovery-stopped",
          trigger: incident.trigger,
        });
        return;
      }
      if (options.isQuitting()) {
        log("info", "renderer-recovery", {
          action: "skip",
          reason: "app-quitting",
          trigger: incident.trigger,
        });
        return;
      }
      if (contents.isDestroyed()) {
        log("info", "renderer-recovery", {
          action: "skip",
          reason: "web-contents-destroyed",
          trigger: incident.trigger,
        });
        return;
      }
      try {
        contents.reload();
        log("warn", "renderer-recovery", {
          action: "reload",
          trigger: incident.trigger,
          ...rendererContext(),
        });
      } catch (error) {
        recoveryStopped = true;
        log("error", "renderer-recovery", {
          action: "stop",
          reason: "reload-threw",
          trigger: incident.trigger,
          error: errorMessage(error),
          ...rendererContext(),
        });
        showRecoveryStoppedOnce();
      }
    });
  };

  contents.on("render-process-gone", (_event, details) => {
    const context = {
      type: "Renderer",
      ...rendererContext(),
      reason: details?.reason ?? "unknown",
      exitCode: details?.exitCode ?? "unknown",
    };
    log("error", "renderer-process-gone", context);
    requestRecovery({ trigger: "renderer-process-gone", details: context });
  });

  contents.on("unresponsive", () => {
    unresponsiveAt = now();
    log("error", "renderer-unresponsive", rendererContext());
  });

  contents.on("responsive", () => {
    const responsiveAt = now();
    const context = rendererContext();
    if (unresponsiveAt !== null) {
      context.unresponsiveMs = Math.max(0, responsiveAt - unresponsiveAt);
    }
    unresponsiveAt = null;
    log("info", "renderer-responsive", context);
  });

  return {
    requestGpuRecovery(details = {}) {
      requestRecovery({
        trigger: "gpu-process-gone",
        details: childProcessDetails(details),
      });
    },
  };
}

export function handleChildProcessGone(
  details: ChildProcessGoneDetailsLike,
  options: {
    log?: ProcessLifecycleLog;
    recoverGpu: (details: ChildProcessGoneDetailsLike) => void;
  },
): void {
  const log = options.log ?? defaultLog;
  const normalized = childProcessDetails(details);
  const failed = details.reason !== "clean-exit";
  log(failed ? "error" : "info", "child-process-gone", normalized);
  if (details.type === "GPU" && failed) {
    // Chromium 会重启 GPU 子进程；主进程只在新 GPU 就绪的后续 turn 重载内容，
    // 让仍存活但合成层已失效的窗口重新建立 compositor surface。
    options.recoverGpu(details);
  }
}

function childProcessDetails(
  details: ChildProcessGoneDetailsLike,
): Record<string, unknown> {
  return {
    type: details.type ?? "unknown",
    reason: details.reason ?? "unknown",
    exitCode: details.exitCode ?? "unknown",
    ...(details.serviceName ? { serviceName: details.serviceName } : {}),
    ...(details.name ? { name: details.name } : {}),
  };
}

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
