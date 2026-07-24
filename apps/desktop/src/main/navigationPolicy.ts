// 主窗口只承载本地应用。SPA 的 history 路由不会触发 will-navigate；这里放行的仅是
// 同源整页刷新/相对链接、开发服务器地址及显式登记的内置服务 origin，避免
// file:、about: 等 scheme 进入渲染器。
export function isAllowedMainFrameNavigation(
  targetUrl: string,
  currentUrl: string,
  devUrl?: string,
  allowedAppOrigins: ReadonlySet<string> = new Set(),
): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (allowedAppOrigins.has(target.origin)) return true;

  for (const allowedUrl of [currentUrl, devUrl]) {
    if (!allowedUrl) continue;
    try {
      const allowed = new URL(allowedUrl);
      if (
        (allowed.protocol === "http:" || allowed.protocol === "https:") &&
        target.origin === allowed.origin
      ) {
        return true;
      }
    } catch {
      // 当前页或开发地址异常时不扩大允许范围。
    }
  }

  return false;
}

export function shouldOpenMainWindowNavigationExternally(
  targetUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  try {
    const target = new URL(targetUrl);
    const isWeb = target.protocol === "http:" || target.protocol === "https:";
    return isWeb && !allowedAppOrigins.has(target.origin);
  } catch {
    return false;
  }
}
