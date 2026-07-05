// 退出预算封顶等待(纯函数,无 electron 依赖,便于单测)。
// 背景:telemetry.shutdown(2000) 的循环在 deadline 前检查,但单次 await flush() 内部的
// fetch 超时可达 8s——慢网络下退出会被单次在途请求拖到远超预算。这里把每次等待都按
// 剩余预算封顶:预算耗尽先行返回(在途 promise 继续在后台完成/被丢弃),保证"绝不卡退出"。

/** 等待 promise 至多 ms 毫秒;超时先行返回(不取消 promise,由其自生自灭)。 */
export async function awaitWithinMs(promise: Promise<unknown>, ms: number): Promise<void> {
  // 吞掉结果与错误:这里只关心"等没等到",错误由调用方自身逻辑处理。
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  if (ms <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([settled, gate]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
