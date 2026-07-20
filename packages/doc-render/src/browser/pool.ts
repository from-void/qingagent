import { chromium, type Browser } from "playwright";
import { systemBrowserExecutablePath } from "./systemBrowser.js";

// PDF-only browser pool. Web article scraping uses Node.js fetch in extractor.ts.
let browserPromise: Promise<Browser> | null = null;
let browserInstance: Browser | null = null;
const BROWSER_CONTEXT_CONCURRENCY = 3;
let activeBrowserContexts = 0;
type BrowserContextWaiter = {
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};
const browserContextQueue: BrowserContextWaiter[] = [];

async function acquireBrowserContextSlot(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activeBrowserContexts < BROWSER_CONTEXT_CONCURRENCY) {
    activeBrowserContexts += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: BrowserContextWaiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = browserContextQueue.indexOf(waiter);
        if (index >= 0) browserContextQueue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort);
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      },
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal?.aborted) {
      waiter.onAbort();
      return;
    }
    browserContextQueue.push(waiter);
  });
}

function releaseBrowserContextSlot(): void {
  activeBrowserContexts = Math.max(0, activeBrowserContexts - 1);
  while (browserContextQueue.length > 0) {
    const next = browserContextQueue.shift()!;
    next.signal?.removeEventListener("abort", next.onAbort);
    if (next.signal?.aborted) {
      next.reject(next.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      continue;
    }
    activeBrowserContexts += 1;
    next.resolve();
    break;
  }
}

export async function withBrowserContextSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquireBrowserContextSlot(signal);
  try {
    return await fn();
  } finally {
    releaseBrowserContextSlot();
  }
}

export function proxyFromEnv(): { server: string; bypass?: string } | undefined {
  const server =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!server) return undefined;

  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  return {
    server,
    ...(noProxy
      ? { bypass: noProxy.split(",").map((item) => item.trim()).join(", ") }
      : {}),
  };
}

/**
 * 浏览器启动候选(返回有序的「启动尝试」描述,逐个失败则试下一个,并打日志便于定位真因):
 *   1) 探测到的系统浏览器 executablePath(我们可控、与 agent-browser 同源;打包态最可靠)
 *   2) QINGAGENT_BROWSER_CHANNELS 的 Playwright channel(msedge/chrome;web/VPS 也常走这条)
 *   3) 默认(随包/随装的 Playwright Chromium)兜底
 * 每项描述 = { kind:"exec"|"channel"|"default", label, launch: ()=>Promise<Browser> }。
 * 优先 executablePath:Playwright 的 channel 依赖其内部注册表/路径解析,打包 Electron 下偶有解析
 * 不稳;executablePath 由 systemBrowserExecutablePath 显式探测得到,行为确定。
 */
export type BrowserLaunchCandidate = {
  kind: "exec" | "channel" | "default";
  label: string;
  launch: () => Promise<Browser>;
};

export function browserLaunchCandidates(): BrowserLaunchCandidate[] {
  const candidates: BrowserLaunchCandidate[] = [];
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // 反检测:去掉 navigator.webdriver / AutomationControlled 标记——headless 默认指纹会被
    // baike/zhihu/smzdm 等识别为爬虫只返回空壳。配合 scrapeWithBrowser 里的 stealth initScript。
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--lang=zh-CN",
  ];
  const proxy = proxyFromEnv();
  const base = { headless: true, args, proxy };

  // 1) 系统浏览器 executablePath(优先;桌面端主力)。
  const sysBrowser = systemBrowserExecutablePath();
  if (sysBrowser) {
    candidates.push({
      kind: "exec",
      label: `executablePath=${sysBrowser}`,
      launch: () => chromium.launch({ ...base, executablePath: sysBrowser }),
    });
  }
  // 2) Playwright channel(QINGAGENT_BROWSER_CHANNELS,逗号分隔)。
  const rawChannels = process.env.QINGAGENT_BROWSER_CHANNELS?.trim();
  const channels = rawChannels ? rawChannels.split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const ch of [...new Set(channels)]) {
    candidates.push({
      kind: "channel",
      label: `channel=${ch}`,
      launch: () => chromium.launch({ ...base, channel: ch }),
    });
  }
  // 3) 默认 Chromium 兜底(恒在最后;web/VPS 不设前两类即只有这一项,行为不变)。
  candidates.push({
    kind: "default",
    label: "default Playwright chromium",
    launch: () => chromium.launch(base),
  });
  return candidates;
}

async function launchBrowser(): Promise<Browser> {
  let lastError: unknown;
  for (const c of browserLaunchCandidates()) {
    try {
      const browser = await c.launch();
      console.log(`[browser] launched via ${c.label}`);
      return browser;
    } catch (error) {
      lastError = error;
      console.warn(
        `[browser] launch failed via ${c.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 试下一候选。
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  if (!browserPromise) {
    browserPromise = launchBrowser().then((browser) => {
      browserInstance = browser;
      browserPromise = null;
      browser.on("disconnected", () => {
        if (browserInstance === browser) {
          browserInstance = null;
        }
      });
      return browser;
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }

  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const browser = browserInstance;
  browserInstance = null;
  browserPromise = null;

  if (browser?.isConnected()) {
    await browser.close();
  }
}

function closeBrowserSync(): void {
  if (browserInstance?.isConnected()) {
    void browserInstance.close();
  }
}

process.once("exit", closeBrowserSync);
process.once("SIGINT", () => {
  void closeBrowser().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void closeBrowser().finally(() => process.exit(143));
});
