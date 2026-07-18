// 主窗口只承载本地应用。SPA 的 history 路由不会触发 will-navigate；这里放行的仅是
// 同源整页刷新/相对链接，以及开发服务器地址，避免 file:、about: 等 scheme 进入渲染器。
export function isAllowedMainFrameNavigation(
  targetUrl: string,
  currentUrl: string,
  devUrl?: string,
): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") return false;

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
