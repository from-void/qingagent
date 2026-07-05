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
  // 不 unref:唯一调用方(telemetry.shutdown)始终 await 本函数,且 finally 恒 clearTimeout,
  // 故 ref 的 timer 最多存活到 budget(ms)即被清/触发,绝不拖过退出预算——unref 在此冗余。
  // 反而 unref 的 timer 会让 node:test(Node 22.x)误判"event loop 已 resolve 但 promise 仍
  // pending"而整文件报错(该工具刻意让在途 promise 自生自灭,派生天然悬挂)。保持 ref 即两全。
  let timer: NodeJS.Timeout | undefined;
  const gate = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([settled, gate]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
