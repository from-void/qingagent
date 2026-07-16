/**
 * 将 embedded server 的完整启动流程收敛为进程级 single-flight。
 * 多次 activate 在首次启动完成前后都复用同一个 promise，避免重复监听端口和注册路由。
 */
export function createSingleFlightStarter<TOptions, TResult>(
  start: (options: TOptions) => Promise<TResult>,
): (options: TOptions) => Promise<TResult> {
  let started: Promise<TResult> | null = null;

  return (options) => {
    if (started) return started;
    const current = start(options);
    const wrapped = current.catch((error: unknown) => {
      if (started === wrapped) started = null;
      throw error;
    });
    started = wrapped;
    return wrapped;
  };
}
