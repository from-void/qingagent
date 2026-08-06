export const RUN_SCRIPT_FAILURE_KINDS = [
  "codeError",
  "resourceExceeded",
  "timedOut",
  "aborted",
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
