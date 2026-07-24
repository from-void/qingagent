import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { AgentBrowser, type BrowserToolName } from "@mastra/agent-browser";
import { validateFetchUrl } from "./extractor.js";
import {
  assertBrowserProxyAclConfigured,
  browserLaunchArgs,
  browserProxyAclEnforced,
  proxyFromEnv,
} from "./pool.js";
import { systemBrowserExecutablePath } from "./systemBrowser.js";
import { browserUnavailableToolResult } from "./browserErrors.js";
import { isTruthyFlag } from "./envFlag.js";
import { installBrowserRequestPolicy } from "./browserSecurity.js";

/**
 * 0603 — 浏览器自主操作(browser_*)能力接入点。
 *
 * 这是交互式浏览器能力入口,只在需要真实页面操作时启用:
 *   1) fetchArticle      静态抓取,必要时内部自动渲染降级
 *   2) browser_*         浏览器自主操作(登录 / 付费墙 / 交互翻页,最重)  ← 本模块
 *
 * 两种部署形态:
 *   - 客户端 agent:可走 cdpUrl(接本机已登录的真 Chrome),也可用内置 AgentBrowser。
 *   - web agent(本服务):只能用 AgentBrowser,由 agent 自己 browser_* 一步步登录,
 *     登录态用 exportStorageState 持久化在"agent 浏览器"里(storageState JSON),下次自动加载复用。
 *
 * 默认关闭(避免平白给主 agent 增加十几个工具的上下文)。通过环境变量启用:
 *   - QINGAGENT_AGENT_BROWSER=1          启用(自启 Chromium,复用仓库已装 Playwright)
 *   - QINGAGENT_BROWSER_CDP_URL=ws://…   客户端形态:连已运行的持久登录 Chrome(强制 scope:'shared')
 *   - QINGAGENT_BROWSER_STORAGE_STATE=…  登录态 JSON 路径(留空则默认 <cwd>/.qingagent-browser-state.json)
 *   - QINGAGENT_BROWSER_HEADFUL=1        有头模式(首次扫码/人工登录时用,登录后可改回无头复用 storageState)
 *   - QINGAGENT_BROWSER_ALLOW_DOMAINS=…  逗号分隔的入口/首站域名白名单(留空=不额外限制)。
 *                                         这不是全程导航隔离；后续点击/重定向出名单后，
 *                                         仍由逐请求私网/scheme 守卫兜底。
 */

// 关闭高风险/对本场景无用的工具:
// screenshot(模型无视觉)、evaluate(任意页面 JS,安全风险)、drag/tabs(抓取登录用不上)。
const EXCLUDED_TOOLS: BrowserToolName[] = [
  "browser_screenshot",
  "browser_evaluate",
  "browser_drag",
  "browser_tabs",
];

const GOTO_TOOL = "browser_goto";
const PERSIST_DEBOUNCE_MS = 1500;

type BrowserToolset = ReturnType<AgentBrowser["getTools"]>;

/** 是否启用浏览器自主操作(显式开关,或配置了持久 Chrome 的 cdpUrl)。 */
export function isAgentBrowserEnabled(): boolean {
  return (
    isTruthyFlag(process.env.QINGAGENT_AGENT_BROWSER) ||
    Boolean(process.env.QINGAGENT_BROWSER_CDP_URL?.trim())
  );
}

/** 登录态 JSON 路径:显式配置优先;否则启用时给默认路径,让"在 agent 浏览器里存登录态"开箱即用。 */
function storageStatePath(): string | undefined {
  const explicit = process.env.QINGAGENT_BROWSER_STORAGE_STATE?.trim();
  if (explicit) return explicit;
  if (!isAgentBrowserEnabled()) return undefined;
  return join(process.cwd(), ".qingagent-browser-state.json");
}

/** 入口/首站域名白名单；只约束 browser_goto，不把后续点击/重定向锁在名单内。 */
function allowedDomains(): string[] {
  return (process.env.QINGAGENT_BROWSER_ALLOW_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(host: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  const h = host.toLowerCase();
  return allow.some((d) => h === d || h.endsWith(`.${d}`));
}

let cached: AgentBrowser | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const PROXIED_CDP_PORT = 9333;
let proxiedProc: ChildProcess | null = null;
let proxiedCdpUrl: string | null = null;
let processExitHooksInstalled = false;

/** 在 context 创建后的首个真实导航前安装全请求策略；同一 context 并发调用只安装一次。 */
export async function installAgentBrowserRequestPolicy(
  context: BrowserContext,
  options: { outboundProxyAcl?: boolean } = {},
): Promise<void> {
  const outboundProxyAcl =
    options.outboundProxyAcl ?? Boolean(proxyFromEnv());
  if (outboundProxyAcl) assertBrowserProxyAclConfigured();
  // 交互式浏览器不能用 Node 回填固定 IP，否则会破坏登录、下载、流媒体和 WebSocket 语义。
  // 有代理时，HTTP(S)/WS 的 DNS rebinding 最终由 deny-private 出站 ACL 阻断；无代理时只能在
  // route/routeWebSocket 每次加载前拒绝当下解析到的私网地址，Chromium 二次解析仍有残留窗口。
  await installBrowserRequestPolicy(context, {
    outboundProxyAcl: outboundProxyAcl && browserProxyAclEnforced(),
  });
}

/**
 * AgentBrowser 0.4 的 ensureReady 在任一工具真实操作前完成 context 创建；在这里装 route，
 * 可覆盖 goto、重定向、脚本导航、iframe、子资源以及之后新开的 page。
 */
class SecuredAgentBrowser extends AgentBrowser {
  constructor(
    config: ConstructorParameters<typeof AgentBrowser>[0],
    private readonly outboundProxyAcl: boolean,
  ) {
    super(config);
  }

  override async ensureReady(): Promise<void> {
    await super.ensureReady();
    const manager = await this.getManagerForThread();
    const contexts = new Set<BrowserContext>();
    const primaryContext = manager.getContext();
    if (primaryContext) contexts.add(primaryContext);
    for (const page of manager.getPages()) contexts.add(page.context());
    if (contexts.size === 0) {
      throw new Error("AgentBrowser context 未就绪，无法安装网络安全策略");
    }
    // 上游 BrowserConfig 不透传 serviceWorkers 选项；共用 helper 会用注册拦截、注销已有 SW
    // 与 CDP Network.setBypassServiceWorker，为它跟踪页面所属的全部 context 补上等价防线。
    for (const context of contexts) {
      await installAgentBrowserRequestPolicy(context, {
        outboundProxyAcl: this.outboundProxyAcl,
      });
    }
  }
}

/** 终止本模块自己拉起的代理 Chromium；复用端口或显式 CDP 从不写 proxiedProc，不会被误关。 */
export function stopProxiedChromium(): boolean {
  const owned = proxiedProc;
  proxiedProc = null;
  proxiedCdpUrl = null;
  if (!owned || owned.exitCode !== null || owned.killed) return false;
  try {
    return owned.kill("SIGTERM");
  } catch {
    return false;
  }
}

function installProxiedChromiumExitHooks(): void {
  if (processExitHooksInstalled) return;
  processExitHooksInstalled = true;
  process.once("beforeExit", stopProxiedChromium);
  process.once("exit", stopProxiedChromium);
}

/** 读 chromium 的 CDP /json/version,取 webSocketDebuggerUrl(localhost,绕代理)。 */
async function probeCdpWs(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!r.ok) return null;
    const j = (await r.json()) as { webSocketDebuggerUrl?: string };
    return j.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * 本机只能经代理上网时,@mastra/agent-browser 的 BrowserConfig 不支持 proxy/args,
 * 所以裸 spawn 一个 chromium(复用仓库 Playwright 的可执行文件),带:
 *   --proxy-server(走代理,能到飞书等)+ --remote-debugging-port(供 CDP 连接)
 *   + 固定 --user-data-dir(profile 持久化登录态,跨重启复用)。
 * 用 spawn 而非 Playwright launch:后者 connectOverCDP 时无初始 page("No page found");
 * 裸 chromium 有原生 about:blank tab,CDP 可直接连。已有 9333 上的实例则复用。
 */
async function ensureProxiedChromiumCdpUrl(): Promise<string> {
  if (proxiedCdpUrl) {
    const alive = await probeCdpWs(PROXIED_CDP_PORT);
    if (alive) return proxiedCdpUrl;
    proxiedCdpUrl = null;
  }
  const reuse = await probeCdpWs(PROXIED_CDP_PORT);
  if (reuse) {
    proxiedCdpUrl = reuse;
    return reuse;
  }
  const proxy = proxyFromEnv();
  const profileDir =
    process.env.QINGAGENT_BROWSER_PROFILE_DIR?.trim() ||
    join(process.cwd(), ".qingagent-browser-profile");
  const headful = isTruthyFlag(process.env.QINGAGENT_BROWSER_HEADFUL);
  const args = [
    ...(headful ? [] : ["--headless=new"]),
    `--remote-debugging-port=${PROXIED_CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    ...browserLaunchArgs(true),
    "--disable-gpu",
    `--user-data-dir=${profileDir}`,
    ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
    "about:blank",
  ];
  // 桌面端没有随包 Playwright Chromium,优先用系统已装浏览器(Edge/Chrome);否则回退 Playwright 自带。
  const chromiumBin = systemBrowserExecutablePath() ?? chromium.executablePath();
  const spawnedProc = spawn(chromiumBin, args, { stdio: "ignore" });
  proxiedProc = spawnedProc;
  installProxiedChromiumExitHooks();
  let spawnFailure: Error | null = null;
  const spawnFailurePromise = new Promise<never>((_, reject) => {
    spawnedProc.once("error", (error) => {
      spawnFailure = error;
      if (proxiedProc === spawnedProc) {
        proxiedProc = null;
        proxiedCdpUrl = null;
      }
      reject(error);
    });
    spawnedProc.once("exit", (code, signal) => {
      const exitedBeforeReady = proxiedCdpUrl === null;
      if (proxiedProc === spawnedProc) {
        proxiedProc = null;
        proxiedCdpUrl = null;
      }
      if (!exitedBeforeReady) return;
      const error = new Error(
        `代理 chromium 进程提前退出(code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      spawnFailure = error;
      reject(error);
    });
  });
  // error/exit 可能先于轮询被 await；先挂 catch，避免自身变成 unhandledRejection。
  void spawnFailurePromise.catch(() => {});
  spawnedProc.unref();
  for (let i = 0; i < 60; i++) {
    if (spawnFailure) throw spawnFailure;
    const ws = await Promise.race([probeCdpWs(PROXIED_CDP_PORT), spawnFailurePromise]);
    if (ws) {
      proxiedCdpUrl = ws;
      return ws;
    }
    await Promise.race([
      new Promise((res) => setTimeout(res, 250)),
      spawnFailurePromise,
    ]);
  }
  stopProxiedChromium();
  throw new Error("代理 chromium 的 CDP 端点未就绪");
}

/** 惰性创建单例 AgentBrowser(构造与 getTools 都不会启动浏览器,首次调用工具时才连/启)。 */
export function getAgentBrowser(): AgentBrowser {
  if (cached) return cached;
  const explicitCdp = process.env.QINGAGENT_BROWSER_CDP_URL?.trim();
  const proxy = proxyFromEnv();
  const savePath = storageStatePath();
  const base = {
    headless: !isTruthyFlag(process.env.QINGAGENT_BROWSER_HEADFUL),
    viewport: { width: 1280, height: 800 },
    timeout: 30_000,
    excludeTools: EXCLUDED_TOOLS,
    // 登录态:文件已存在才加载(load);不存在时不传 storageState(避免"加载不存在文件"报错),
    // 首次登录后由 exportStorageState 写出该文件,下次即被加载。
    ...(savePath && existsSync(savePath) ? { storageState: savePath } : {}),
  };
  // 桌面端没有随包 Playwright Chromium → 自启时用系统已装浏览器(Edge/Chrome)的 executablePath。
  // 关键:executablePath 只能用于「自启」分支,不能和 cdpUrl 同时给(库会校验冲突、整轮不注入
  // browser_*)。所以 cdpUrl 的两个分支(显式/代理)绝不带 executablePath;cdpUrl 连接已有/自 spawn
  // 的浏览器(spawn 路径已自行用 systemBrowserExecutablePath 选二进制)。
  const sysBrowser = systemBrowserExecutablePath();
  const launchExec = sysBrowser ? { executablePath: sysBrowser } : {};
  // cdpUrl 决策(均强制 scope:'shared' —— cdpUrl 与 thread 编译期互斥,且共享一份登录态):
  // 1) 显式 cdpUrl(客户端形态/用户自管 Chrome)→ 直接连(不带 executablePath)
  // 2) 有代理 env(本机只能经代理上网)→ 自起带 --proxy-server 的 chromium,经 CDP 连它(不带 executablePath)
  // 3) 否则自启(无代理环境;持久化时 shared,否则库默认 thread 隔离)→ 带 executablePath
  if (explicitCdp) {
    cached = new SecuredAgentBrowser(
      { ...base, cdpUrl: explicitCdp, scope: "shared" },
      false,
    );
  } else if (proxy) {
    assertBrowserProxyAclConfigured();
    cached = new SecuredAgentBrowser(
      { ...base, cdpUrl: () => ensureProxiedChromiumCdpUrl(), scope: "shared" },
      true,
    );
  } else if (savePath) {
    cached = new SecuredAgentBrowser(
      { ...base, ...launchExec, scope: "shared" },
      false,
    );
  } else {
    cached = new SecuredAgentBrowser({ ...base, ...launchExec }, false);
  }
  return cached;
}

/** 任意 browser_* 成功操作后,debounce 把登录态回写到 storageState(把登录"存"进 agent 浏览器)。 */
function schedulePersist(browser: AgentBrowser, savePath: string | undefined): void {
  if (!savePath) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    browser
      .exportStorageState(savePath)
      .catch((e) =>
        console.warn(`[agentBrowser] 持久化登录态失败: ${e instanceof Error ? e.message : String(e)}`),
      );
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * 给工具集打两层包裹:
 *  - browser_goto 入口 URL 安全校验(SSRF):validateFetchUrl 拒私网/元数据/非 http(s) + 可选首站白名单。
 *    白名单只约束显式 goto，不是全程导航隔离；后续出名单仍由真实 context 的逐请求/逐 WebSocket
 *    私网与 scheme 守卫兜底。
 *  - 所有工具成功后 debounce 回写 storageState(web agent 把登录态存进 agent 浏览器,持久复用)。
 */
function instrument(tools: BrowserToolset, browser: AgentBrowser, savePath: string | undefined): BrowserToolset {
  const allow = allowedDomains();
  const bag = tools as Record<string, { execute?: (...args: unknown[]) => unknown }>;
  for (const name of Object.keys(bag)) {
    const orig = bag[name];
    if (!orig || typeof orig.execute !== "function") continue;
    const origExecute = orig.execute.bind(orig);
    const isGoto = name === GOTO_TOOL;
    bag[name] = {
      ...orig,
      execute: async (input: unknown, ...rest: unknown[]) => {
        if (isGoto) {
          const url =
            input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string"
              ? (input as { url: string }).url
              : undefined;
          if (url) {
            let parsed: URL;
            try {
              parsed = await validateFetchUrl(url);
            } catch (e) {
              throw new Error(
                `browser_goto 被安全策略拒绝:${e instanceof Error ? e.message : String(e)}`,
              );
            }
            if (!hostAllowed(parsed.hostname, allow)) {
              throw new Error(
                `browser_goto 入口目标域 ${parsed.hostname} 不在首站白名单内(QINGAGENT_BROWSER_ALLOW_DOMAINS)`,
              );
            }
          }
        }
        try {
          const result = await origExecute(input, ...rest);
          schedulePersist(browser, savePath); // 成功操作后回写登录态(debounced)
          return result;
        } catch (error) {
          console.warn(
            `[agentBrowser] ${name} 执行失败: ${error instanceof Error ? error.message : String(error)}`,
          );
          return browserUnavailableToolResult(error);
        }
      },
    };
  }
  return tools;
}

/**
 * 返回 browser_* 工具集(供 buildCapabilityTools 按需注入)。
 * 未启用 → 返回空对象(主 agent 不增加任何浏览器工具)。
 */
export function getAgentBrowserTools(): BrowserToolset {
  if (!isAgentBrowserEnabled()) return {} as BrowserToolset;
  try {
    const browser = getAgentBrowser();
    return instrument(browser.getTools(), browser, storageStatePath());
  } catch (e) {
    // 包/类型异常不应让整轮 agent 失败,降级为"无浏览器工具";但要留日志便于"开了开关却没工具"定位。
    console.warn(
      `[agentBrowser] getTools 失败,本轮不注入 browser_*: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {} as BrowserToolset;
  }
}

/** 仅供测试:重置单例。 */
export function resetAgentBrowserForTest(): void {
  cached = null;
  stopProxiedChromium();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
