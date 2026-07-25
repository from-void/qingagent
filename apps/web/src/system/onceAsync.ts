/**
 * 把异步工厂记忆化:首次调用真的执行,后续调用复用同一个 promise。
 *
 * 用途(路由 chunk 的预热与 lazy 共用同一次 import):Vite 把 `import("./x")` 编译成
 * `__vitePreload(() => import("./x-hash.js"), deps)`,**每次调用工厂都会走一遍
 * __vitePreload**,而它内部用一张模块级 seen 表去重:
 *     if (dep in seen) return;          // 第二次:直接短路
 *     seen[dep] = true;
 *     if (isCss) return new Promise(res => link.addEventListener("load", res));
 * 也就是只有**第一次**碰到某个 CSS 才返回「等 link load」的 promise。若预热调一次
 * (把等待 void 掉)、用户切页时 lazy 再调一次,第二次就 seen 命中、不等 CSS 就把 chunk
 * 交出去 —— 组件先挂载、样式后到,那几百毫秒是完全无样式的裸 DOM(布局/字色/玻璃感全丢)。
 * 记忆化之后 __vitePreload 只被调用一次(预热那次,它会老实等 CSS),lazy 拿到同一个 promise,
 * resolve 时样式必然已生效:首屏仍只下首页 CSS,其余页面后台预载,两头都要到。
 *
 * 失败**不缓存**:否则一次网络抖动就把该路由永久钉死 —— 之后每次重试都拿到同一个 rejected
 * promise,页面再也打不开。清空后下次调用重新发起。
 */
export function onceAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = factory().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}
