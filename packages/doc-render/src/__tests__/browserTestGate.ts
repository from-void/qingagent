import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { systemBrowserExecutablePath } from "../browser/systemBrowser.js";

/**
 * PDF 导出已改为 headless Chromium 渲染。本地 / CI 没装 Chromium 二进制时,相关 PDF 烟测
 * 应跳过而非失败(CI 会单独装 chromium 后再跑)。这里探测 Playwright 的 Chromium 可执行文件。
 */
export const hasChromium = (() => {
  try {
    const candidates = [systemBrowserExecutablePath(), chromium.executablePath()];
    return candidates.some((exe) => Boolean(exe) && existsSync(exe!));
  } catch {
    return false;
  }
})();
