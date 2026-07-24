import { chromium, type Browser } from "playwright";
import { systemBrowserExecutablePath } from "./systemBrowser.js";

// PDF-only browser pool. Web article scraping uses Node.js fetch in extractor.ts.
let browserPromise: Promise<Browser> | null = null;
let browserInstance: Browser | null = null;
let sandboxAuditLogged = false;
export const ALLOW_NO_SANDBOX_ENV = "QINGAGENT_ALLOW_NO_SANDBOX";

export type BrowserCapabilityState = {
  status: "unknown" | "available" | "unavailable";
  sandbox: "required" | "disabled-by-explicit-override";
  reason: string | null;
};

let browserCapabilityState: BrowserCapabilityState = {
  status: "unknown",
  sandbox:
    process.env[ALLOW_NO_SANDBOX_ENV]?.trim() === "1"
      ? "disabled-by-explicit-override"
      : "required",
  reason: null,
};

export class BrowserCapabilityUnavailableError extends Error {
  readonly code = "BROWSER_CAPABILITY_UNAVAILABLE";

  constructor(message = "当前部署环境无法安全启动浏览器，PDF 导出等浏览器能力已禁用") {
    super(message);
    this.name = "BrowserCapabilityUnavailableError";
  }
}

/** 高危逃生阀刻意只认精确值 1，避免宽松 truthy 解析造成意外关闭 sandbox。 */
export function allowNoSandbox(): boolean {
  return process.env[ALLOW_NO_SANDBOX_ENV]?.trim() === "1";
}

function logSandboxPolicyOnce(): void {
  if (sandboxAuditLogged) return;
  sandboxAuditLogged = true;
  if (allowNoSandbox()) {
    console.warn(
      `[browser][security-audit] ${ALLOW_NO_SANDBOX_ENV}=1：Chromium sandbox 已被显式关闭；` +
        "这会降低浏览器进程隔离，仅应作为受限容器中的临时高危逃生阀",
    );
  }
}

export function getBrowserCapabilityState(): BrowserCapabilityState {
  return { ...browserCapabilityState };
}

function markBrowserUnavailable(error: unknown): BrowserCapabilityUnavailableError {
  const detail = error instanceof Error ? error.message : String(error);
  browserCapabilityState = {
    status: "unavailable",
    sandbox: allowNoSandbox() ? "disabled-by-explicit-override" : "required",
    reason: "浏览器无法在当前环境启动；PDF 导出等浏览器能力已禁用",
  };
  console.error(
    "[browser] 启动能力探测失败，PDF 导出等浏览器能力已禁用",
    detail,
  );
  return error instanceof BrowserCapabilityUnavailableError
    ? error
    : new BrowserCapabilityUnavailableError();
}

/**
 * 服务启动前探测实际浏览器启动策略。失败不拖垮整个服务，而是把依赖浏览器的能力标为禁用；
 * 默认策略带 Chromium sandbox，只有显式 QINGAGENT_ALLOW_NO_SANDBOX=1 才会关闭。
 */
export async function probeBrowserCapability(): Promise<BrowserCapabilityState> {
  logSandboxPolicyOnce();
  try {
    await getBrowser();
    browserCapabilityState = {
      status: "available",
      sandbox: allowNoSandbox() ? "disabled-by-explicit-override" : "required",
      reason: null,
    };
    console.info(
      `[browser] 启动能力探测通过（sandbox=${allowNoSandbox() ? "disabled-explicitly" : "required"}）`,
    );
  } catch {
    // getBrowser 已记录经过脱敏/截断前的启动诊断，并把状态切成 unavailable。
  }
  return getBrowserCapabilityState();
}
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

  // 浏览器代理承担 DNS rebinding 后的最终网络层 ACL，不能继承 NO_PROXY 让目标绕过 ACL。
  // Node/模型请求仍按各自 transport 处理 NO_PROXY；这里只约束 Playwright/Chromium。
  return { server };
}

export const BROWSER_PROXY_ACL_ENV = "QINGAGENT_BROWSER_PROXY_ACL";

/** 代理部署必须显式确认网络层拒绝私网、环回、链路本地与云元数据地址。 */
export function browserProxyAclEnforced(): boolean {
  return process.env[BROWSER_PROXY_ACL_ENV]?.trim().toLowerCase() === "deny-private";
}

export function assertBrowserProxyAclConfigured(): void {
  if (proxyFromEnv() && !browserProxyAclEnforced()) {
    throw new Error(
      `检测到浏览器出站代理，但未设置 ${BROWSER_PROXY_ACL_ENV}=deny-private；` +
        "无法确认代理会拒绝私网/环回/169.254 目标，已停止浏览器网络访问",
    );
  }
}

/** 抓取、导出和自起交互 Chromium 共用的安全启动参数。 */
export function browserLaunchArgs(proxyConfigured = Boolean(proxyFromEnv())): string[] {
  logSandboxPolicyOnce();
  return [
    "--disable-dev-shm-usage",
    // 反检测:去掉 navigator.webdriver / AutomationControlled 标记——headless 默认指纹会被
    // baike/zhihu/smzdm 等识别为爬虫只返回空壳。配合 scrapeWithBrowser 里的 stealth initScript。
    "--disable-blink-features=AutomationControlled",
    "--lang=zh-CN",
    ...(allowNoSandbox() ? ["--no-sandbox"] : []),
    // Chromium 默认可能绕过 loopback；代理 ACL 模式必须让所有 HTTP(S)/WS 出站都经过代理。
    ...(proxyConfigured ? ["--proxy-bypass-list=<-loopback>"] : []),
  ];
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
  const proxy = proxyFromEnv();
  if (proxy) assertBrowserProxyAclConfigured();
  const args = browserLaunchArgs(Boolean(proxy));
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
  if (browserCapabilityState.status === "unavailable") {
    throw new BrowserCapabilityUnavailableError();
  }
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
      throw markBrowserUnavailable(error);
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

/** 仅供测试：隔离启动探测状态，避免用例间共享模块单例。 */
export async function resetBrowserCapabilityForTest(): Promise<void> {
  await closeBrowser();
  browserCapabilityState = {
    status: "unknown",
    sandbox: allowNoSandbox() ? "disabled-by-explicit-override" : "required",
    reason: null,
  };
  sandboxAuditLogged = false;
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
