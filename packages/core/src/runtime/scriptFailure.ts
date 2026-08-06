export const RUN_SCRIPT_FAILURE_KINDS = [
  "codeError",
  "resourceExceeded",
  "timedOut",
  "aborted",
  /** 隔离执行器自身不可用(启动失败/IPC 断链等),与用户代码无关。 */
  "platformError",
] as const;

export type RunScriptFailureKind = (typeof RUN_SCRIPT_FAILURE_KINDS)[number];

export function isRunScriptFailureKind(value: unknown): value is RunScriptFailureKind {
  return RUN_SCRIPT_FAILURE_KINDS.some((kind) => kind === value);
}

/** Node 只为 Worker 内存上限提供稳定错误码；其它 Worker 故障不猜测资源归因。 */
export function failureKindFromWorkerError(error: unknown): RunScriptFailureKind {
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return code === "ERR_WORKER_OUT_OF_MEMORY" ? "resourceExceeded" : "codeError";
}
