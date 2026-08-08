import { withBrowserContextSlot } from "../browser/pool.js";

// 预算依据（2026-07-25 本机真 Chromium 压测）：4 并发 × 每份 300 段正文 + 12 张
// Mermaid，最慢 1.42s、总墙钟 1.42s；仓库跨机器重回归预算仍为 120–150s。
// 因而执行给 300s（慢机重回归至少 2 倍余量），排队另给 120s：第 4 个正常任务的
// 等槽时间不侵蚀自身执行预算；持续过载超过 120s 则明确返回可重试繁忙。
export const EXPORT_QUEUE_TIMEOUT_MS = 120_000;
export const EXPORT_EXECUTION_DEADLINE_MS = 300_000;

export class ExportBusyError extends Error {
  readonly code = "EXPORT_BUSY";
  readonly retryable = true;

  constructor(timeoutMs: number) {
    super(`导出队列繁忙，等待槽位超过 ${timeoutMs}ms，请稍后重试`);
    this.name = "ExportBusyError";
  }
}

export class ExportDeadlineExceededError extends Error {
  readonly code = "EXPORT_DEADLINE_EXCEEDED";

  constructor(timeoutMs: number) {
    super(`导出获得槽位后执行超过 ${timeoutMs}ms，已中止`);
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
  queueTimeoutMs?: number;
  executionTimeoutMs?: number;
}

/**
 * 所有导出浏览器后端共享 browser/pool 的 3 槽限流。
 *
 * 排队等待上限与执行 deadline 完全分离：执行计时只在获得槽位后开始。任一阶段超时都会
 * 立即拒绝调用方；已开始的后端仍要真正完成清理后才释放槽，避免残留任务与新任务叠加。
 */
export async function withExportSlot<T>(
  run: (context: ExportRunContext) => Promise<T>,
  options: ExportSlotOptions = {},
): Promise<T> {
  const queueTimeoutMs = options.queueTimeoutMs ?? EXPORT_QUEUE_TIMEOUT_MS;
  const executionTimeoutMs = options.executionTimeoutMs ?? EXPORT_EXECUTION_DEADLINE_MS;
  if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs <= 0) {
    throw new TypeError("export queueTimeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) {
    throw new TypeError("export executionTimeoutMs must be a positive finite number");
  }

  const queueController = new AbortController();
  const executionController = new AbortController();
  const busyError = new ExportBusyError(queueTimeoutMs);
  const timeoutError = new ExportDeadlineExceededError(executionTimeoutMs);
  const onExternalAbort = () => {
    const reason =
      options.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
    queueController.abort(reason);
    executionController.abort(reason);
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  let queueTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => queueController.abort(busyError),
    queueTimeoutMs,
  );
  let executionTimer: ReturnType<typeof setTimeout> | undefined;

  // withBrowserContextSlot 的 callback 只在真正拿到槽后运行；执行 deadline 必须在这里启动。
  const task = withBrowserContextSlot(async () => {
    if (queueTimer) clearTimeout(queueTimer);
    queueTimer = undefined;
    queueController.signal.throwIfAborted();

    const deadlineAt = Date.now() + executionTimeoutMs;
    executionTimer = setTimeout(
      () => executionController.abort(timeoutError),
      executionTimeoutMs,
    );
    const context: ExportRunContext = {
      signal: executionController.signal,
      deadlineAt,
      remainingMs: () => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw timeoutError;
        return Math.max(1, remaining);
      },
    };
    executionController.signal.throwIfAborted();
    try {
      return await run(context);
    } finally {
      if (executionTimer) clearTimeout(executionTimer);
      executionTimer = undefined;
    }
  }, queueController.signal);

  let onQueueAbort: (() => void) | undefined;
  let onExecutionAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onQueueAbort = () => reject(queueController.signal.reason);
    onExecutionAbort = () => reject(executionController.signal.reason);
    queueController.signal.addEventListener("abort", onQueueAbort, { once: true });
    executionController.signal.addEventListener("abort", onExecutionAbort, { once: true });
    if (queueController.signal.aborted) onQueueAbort();
    if (executionController.signal.aborted) onExecutionAbort();
  });

  try {
    return await Promise.race([task, aborted]);
  } finally {
    // 调用方可能先收到 deadline；task 自身仍由 withBrowserContextSlot 持槽至 run 清理完毕。
    if (queueTimer) clearTimeout(queueTimer);
    if (onQueueAbort) queueController.signal.removeEventListener("abort", onQueueAbort);
    if (onExecutionAbort) executionController.signal.removeEventListener("abort", onExecutionAbort);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
