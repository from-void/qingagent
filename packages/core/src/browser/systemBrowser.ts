import { existsSync } from "node:fs";

/**
 * 系统已装浏览器(Edge 优先、其次 Chrome)的可执行文件探测。
 *
 * 用途:桌面客户端不随包 ~170MB Chromium,改用系统已装浏览器二进制——
 * @mastra/agent-browser 的 BrowserConfig 支持 executablePath,可直接指过去启动 browser_*;
 * agentBrowser 的代理 spawn 路径也用它替代缺失的 Playwright 自带 chromium。Windows 预装 Edge,
 * 故多数桌面开箱即用。Playwright channel 路径见 pool.ts(getBrowser 走 channel,这里走
 * executablePath,因为这两套库各自只接受其一)。
 */

/** 各平台系统浏览器(Edge 优先)常见安装路径候选。纯函数,便于单测。 */
export function systemBrowserCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pfx86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    return [
      `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
  }
  // linux
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
  ];
}

let memo: string | null | undefined;

/**
 * 返回首个存在的系统浏览器可执行路径;都没有返回 null。
 * QINGAGENT_BROWSER_EXECUTABLE_PATH 显式覆盖优先(信任用户,原样返回,不做存在性探测)。
 */
export function systemBrowserExecutablePath(): string | null {
  const override = process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (override) return override;
  if (memo !== undefined) return memo;
  memo = systemBrowserCandidates().find((p) => existsSync(p)) ?? null;
  return memo;
}

/** 仅供测试:清空探测缓存。 */
export function __resetSystemBrowserMemoForTest(): void {
  memo = undefined;
}
