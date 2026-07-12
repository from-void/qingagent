const PLAYWRIGHT_INSTALL_COMMAND = "npx playwright install chromium";

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  path?: unknown;
  syscall?: unknown;
};

function errorLike(error: unknown): ErrorLike {
  return error && typeof error === "object" ? (error as ErrorLike) : {};
}

export function browserErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isPlaywrightBrowserMissingError(error: unknown): boolean {
  const like = errorLike(error);
  const message = browserErrorMessage(error);
  const code = typeof like.code === "string" ? like.code : "";
  const syscall = typeof like.syscall === "string" ? like.syscall : "";

  return (
    code === "ENOENT" ||
    /Executable doesn't exist/i.test(message) ||
    /playwright install/i.test(message) ||
    /spawn .*ENOENT/i.test(message) ||
    (syscall.startsWith("spawn") && /ENOENT/i.test(message))
  );
}

export function isBrowserAvailabilityError(error: unknown): boolean {
  const message = browserErrorMessage(error);
  return (
    isPlaywrightBrowserMissingError(error) ||
    /Failed to launch/i.test(message) ||
    /browserType\.launch/i.test(message) ||
    /Failed to connect via CDP/i.test(message) ||
    /代理 chromium/i.test(message) ||
    /Browser was not initialized/i.test(message) ||
    /Browser not launched/i.test(message) ||
    /Cannot launch browser/i.test(message)
  );
}

export function formatBrowserUnavailableError(error: unknown): string {
  const message = browserErrorMessage(error);
  if (isPlaywrightBrowserMissingError(error)) {
    return `未安装 Playwright 浏览器,运行 ${PLAYWRIGHT_INSTALL_COMMAND} 后重试。原始错误：${message}`;
  }
  return `浏览器不可用，无法执行浏览器工具。原始错误：${message}`;
}

export function browserUnavailableRecoveryHint(error: unknown): string {
  if (isPlaywrightBrowserMissingError(error)) {
    return `在部署机器上运行 ${PLAYWRIGHT_INSTALL_COMMAND}；如果使用 pnpm，也可以运行 pnpm exec playwright install chromium。`;
  }
  return "检查浏览器可执行文件、CDP 地址或代理配置后重试；也可以改用 fetchArticle/webSearch 等非浏览器路径。";
}

export function browserUnavailableToolResult(error: unknown) {
  if (!isBrowserAvailabilityError(error)) {
    return {
      success: false,
      code: "browser_error",
      message: `浏览器工具执行失败。原始错误：${browserErrorMessage(error)}`,
      recoveryHint: "根据错误调整浏览器工具参数，或改用 fetchArticle/webSearch 等非浏览器路径。",
      canRetry: false,
    };
  }
  return {
    success: false,
    code: "browser_error",
    message: formatBrowserUnavailableError(error),
    recoveryHint: browserUnavailableRecoveryHint(error),
    canRetry: false,
  };
}
