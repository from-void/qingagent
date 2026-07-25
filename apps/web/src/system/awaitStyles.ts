// 切页前等样式表落地。
//
// 病根:Vite 的 preload helper 用一张模块级 `seen` 表给依赖去重 ——
//   if (dep in seen) return;  seen[dep] = true;  ...  if (isCss) return new Promise(load)
// 只有**第一次**碰到某个 CSS 才会返回「等 link load」的 promise。App.tsx 的空闲预热
// (void loadWorkspace())就是那第一次:它把 CSS 记进 seen、把 <link rel=stylesheet> 插进
// head,然后把等待 promise 丢掉了。等用户真正切页、React.lazy 第二次调同一个工厂时,
// `dep in seen` 命中直接短路,**不再等 CSS load** 就把 chunk 交出去 —— 页面组件先挂载、
// 皮肤 CSS 后到,那几帧露出 index.html 的 --app-boot-bg 暖纸底(实测:#view-workspace 已挂载
// 而 link.sheet 仍为 null,页框回落到 1440 限宽 + 暖纸底)。
//
// 切页这一步在我们自己手里(首页转场跑完才改 hash),所以在切之前把这一步等回来。
// 超时即放行:慢网络下最多多等 timeoutMs,不会把导航卡死。dev 模式 CSS 是同步注入的
// <style>、没有 pending 的 <link>,这里天然立即 resolve。
//
// 只等同源样式表 —— 跨域 CDN(如 Google Fonts)被墙时会长期 pending,不该拖住切页。

const DEFAULT_TIMEOUT_MS = 400;

function isSameOrigin(href: string): boolean {
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** 已插入 DOM 但还没生效(link.sheet 为空)的同源样式表。 */
function pendingStylesheets(): HTMLLinkElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ).filter((link) => !link.sheet && isSameOrigin(link.href));
}

export function awaitPendingStylesheets(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return Promise.resolve();
  }
  const pending = pendingStylesheets();
  if (pending.length === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let remaining = pending.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    // load / error 都算「不再 pending」:样式表失败时继续切页,总比卡在首页强。
    const one = () => {
      remaining -= 1;
      if (remaining <= 0) finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    for (const link of pending) {
      link.addEventListener("load", one, { once: true });
      link.addEventListener("error", one, { once: true });
    }
  });
}
