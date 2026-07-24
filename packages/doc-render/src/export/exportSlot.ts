import { withBrowserContextSlot } from "../browser/pool.js";

export const EXPORT_DEADLINE_MS = 60_000;

export class ExportDeadlineExceededError extends Error {
  readonly code = "EXPORT_DEADLINE_EXCEEDED";

  constructor(timeoutMs: number) {
    super(`导出超过总时限 ${timeoutMs}ms，已中止`);
    this.name = "ExportDeadlineExceededError";
  }
}

export interface ExportRunContext {
  signal: AbortSignal;
  deadlineAt: number;
  remainingMs: () => number;
}

export interface ExportSlotOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 所有导出浏览器后端共享 browser/pool 的 3 槽限流与总 deadline。
 *
 * deadline 从排队前开始计算；到期后先 abort 后端，调用方立即收到超时错误。槽位要等后端
 * 真正完成清理后才释放，避免一个不响应 abort 的慢任务在后台继续占资源时又放入新任务。
 */
export async function withExportSlot<T>(
  run: (context: ExportRunContext) => Promise<T>,
  options: ExportSlotOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? EXPORT_DEADLINE_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("export timeoutMs must be a positive finite number");
  }

  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeoutError = new ExportDeadlineExceededError(timeoutMs);
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const context: ExportRunContext = {
    signal: controller.signal,
    deadlineAt,
    remainingMs: () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw timeoutError;
      return Math.max(1, remaining);
    },
  };
  // withBrowserContextSlot 在 run 真正 settle 前不会释放槽；deadline race 先返回给调用方时，
  // 已 abort 但尚在清理的后端仍继续占槽，避免后台残留与新任务叠加。
  const task = withBrowserContextSlot(async () => {
    controller.signal.throwIfAborted();
    return run(context);
  }, controller.signal);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });

  try {
    return await Promise.race([task, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
