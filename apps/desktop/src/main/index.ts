import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { configureDesktopRuntimeEnv } from "./desktopRuntimeEnv.js";
import { configureDesktopCredentialKeyProvider } from "./credentialKeyProvider.js";
import { createDesktopClientSecretStore } from "./clientSecretStore.js";
import { persistClientConfigValue } from "./clientConfigPersistence.js";
import {
  createDesktopAppProxyHandler,
  DESKTOP_APP_ORIGIN,
  DESKTOP_APP_SCHEME,
  DESKTOP_APP_URL,
} from "./desktopAppProtocol.js";
import { createNodeHttpProxyFetch } from "./desktopAppProxyFetch.js";
import {
  readPrivateStringMap,
  writePrivateStringMap,
} from "./privateJsonStore.js";
import { buildEditContextMenuTemplate } from "./contextMenu.js";
import { createRollingConsoleTransport } from "./diagnostics/rollingFiles.js";
import { attachRendererDiagnostics } from "./diagnostics/rendererLog.js";
import {
  handleMainWindowWillNavigate,
  isAllowedMainFrameNavigation,
  type MainFrameNavigationEvent,
} from "./navigationPolicy.js";
import {
  getCurrentUpdateStatus,
  RELEASES_URL,
  manualCheckForUpdates,
  quitAndInstallUpdate,
  startDesktopUpdater,
} from "./update/updater.js";
import { acquireSingleInstanceLock } from "./singleInstance.js";
import { assertTrustedRenderer as assertTrustedRendererEvent } from "./ipcTrust.js";
import {
  buildRememberPromptHtml,
  NativeRememberGrantGate,
  REMEMBER_PROMPT_DECISION_CHANNEL,
  TrustedRememberUiGate,
  type RememberGrantKind,
  type RememberPromptCopy,
  type RememberPromptDecision,
} from "./trustedRememberUi.js";
import { computeMainWindowSize } from "./windowSize.js";
import { nextContentLoadRecoveryStep } from "./contentLoadRecovery.js";
import { hasOtherProcessErrorHandler } from "./processErrorPolicy.js";
import { createDesktopQuitCoordinator } from "./quitCoordinator.js";

let mainWindow: BrowserWindow | null = null;
const trustedRememberUiGate = new TrustedRememberUiGate();
const nativeRememberGrantGate = new NativeRememberGrantGate();
let mainWindowRememberGeneration = 0;
let mainWindowRememberScope: string | null = null;
const hasSingleInstanceLock = acquireSingleInstanceLock(app, () => mainWindow);

function assertTrustedRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedRenderer: WebContents | null = mainWindow?.webContents ?? null,
): void {
  assertTrustedRendererEvent(event, expectedRenderer);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = app.getPath("userData");
const desktopLogDir = path.join(userDataDir, "logs");
const shutdownRecoveryMarkerPath = path.join(
  userDataDir,
  ".qingagent-shutdown-recovery.json",
);
try {
  mkdirSync(desktopLogDir, { recursive: true });
} catch {
  // 日志目录创建失败不阻塞开窗，后续日志落盘会静默降级。
}
const consoleFileTransport = createRollingConsoleTransport(desktopLogDir, {
  maxDays: 7,
  maxBytes: 20 * 1024 * 1024,
});

// 日志写失败绝不能崩主进程(必须最早执行,早于任何会 console.log 的代码):
// 打包后的 GUI 客户端没有有效的 stdout/stderr(无控制台 / 启动管道可能断开),内置 Hono
// server 的 per-request 日志中间件 console.log 写入会抛 EPIPE: broken pipe,冒泡成主进程
// uncaughtException → 弹"A JavaScript error occurred in the main process"致命框、整个 app 崩。
// ① 给 stdout/stderr 挂 error 兜底(吞异步 EPIPE);② try/catch 包住 console 各方法(吞同步 EPIPE)。
// 只吞"写日志"这类 IO 写错误,不影响业务异常的正常抛出/上报。
const swallowStreamWriteError = (): void => {};
process.stdout.on("error", swallowStreamWriteError);
process.stderr.on("error", swallowStreamWriteError);
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[method].bind(console) as (...args: unknown[]) => void;
  console[method] = (...args: unknown[]): void => {
    consoleFileTransport.write(method, args);
    try {
      original(...args);
    } catch {
      // stdout/stderr 写失败(EPIPE 等)直接吞掉,绝不让"写日志"崩主进程。
    }
  };
}

// 仅在「从 WSL/UNC 网络路径运行」或「Linux」时禁用硬件加速,走软件渲染(SwiftShader)。
// 这些环境下 electron 的 GPU 子进程会启动失败(error_code=18)→ 反复崩溃 → FATAL
// "GPU process isn't usable" → 整个 app 闪退。本地 Windows 盘运行(正常使用)保留硬件加速、全速体验。
// __dirname 从 \\wsl.localhost\... / \\wsl$\... 这类 UNC 路径运行时以 `\\` 开头。
// 必须在 app ready 之前调用。
const runningFromUncPath = __dirname.startsWith("\\\\");
if (process.platform === "linux" || runningFromUncPath) {
  app.disableHardwareAcceleration();
}

// 打包 renderer 使用固定标准 scheme，保证 Web Storage 的 origin 不随内置服务监听端口变化。
// 必须在 app ready 前登记；实际转发 handler 要等随机监听端口确定后再安装。
protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

// 用户级配置:从 userData/.env 读密钥等(如 DEEPSEEK_API_KEY)。这样打包后的客户端
// 无需重新构建即可配置(把 .env 放进 %APPDATA%/<app>/ 即可)。必须在 import server 之前
// 加载——@qingagent/core 在模块求值期就读这些环境变量。
loadEnvFile({ path: path.join(userDataDir, ".env") });
process.env.QINGAGENT_LOG_DIR = desktopLogDir;

// Set DATABASE_URL before importing server so that @qingagent/core's LibSQL
// storage resolves to the user's app data directory instead of cwd.
// 必须用 pathToFileURL 生成合法 file URL:Windows 路径含盘符+反斜杠
// (C:\Users\...),`file:${dbPath}` 会得到非法 URL 让 libsql 连库即崩(启动闪退);
// pathToFileURL 在 Windows 输出 file:///C:/... 、在 *nix 输出 file:///... ,两端皆可用。
if (!process.env.DATABASE_URL) {
  const dbPath = path.join(userDataDir, "qingagent.db");
  process.env.DATABASE_URL = pathToFileURL(dbPath).href;
}

// 沙箱凭据密钥(.cred-key)与会话工作目录的根:落在 userData,避免打包后写到
// 安装目录/cwd(Windows 下常不可写,会导致凭据/沙箱创建失败)。
// TODO(windows 写墙):Windows 目前没有 seatbelt/bubblewrap 对应的文件隔离层
// (resolveIsolation 在 win32 落到 "none"、命令靠 QINGAGENT_ALLOW_UNISOLATED_COMMANDS 放开),
// 因此凭证共享在 Windows 上是"本来就通"——声明与授权照常记录、安全页照常可收回,
// 但没有一层墙可以据此收紧。补上 Windows 文件隔离层时,再把 credential 例外接进去。
// TODO(P2 feishu-byo-app):决定桌面端 lark-cli 配置目录策略。当前沙箱透传宿主 HOME,
// lark-cli 会写用户真实 ~/.lark-cli;单机交付前需决定保持真实 HOME,还是隔离到 userData 下。
if (!process.env.QINGAGENT_DATA_DIR) {
  process.env.QINGAGENT_DATA_DIR = path.join(userDataDir, "data");
}

// 上传/生成图片(SVG 配图、导出栅格化等)落盘根:打包后 cwd(安装目录)常不可写,
// 必须落 userData。server 写、core 读都解析这个变量(uploadsBaseDir / UPLOAD_DIR)。
// 必须在 import server/core 之前设置——相关模块在求值期 const 取这个目录。
if (!process.env.QINGAGENT_UPLOADS_DIR) {
  process.env.QINGAGENT_UPLOADS_DIR = path.join(userDataDir, "uploads");
}

// 桌面端能力必须在 import server/core 前设好:capabilities、技能导入 gate 都从服务端同进程读取。
configureDesktopRuntimeEnv(process.env, { isPackaged: app.isPackaged });

// 浏览器类能力(fetchArticle 内置渲染降级 / 服务端 mermaid 渲染 / DOCX SVG 栅格化)默认走
// 系统已装浏览器(Edge → Chrome)的 Playwright channel,避免随包 ~170MB Chromium。Windows 预装
// Edge,多数开箱即用,且是真 Chrome 内核,newContext/newPage 全正常(Electron 自带 Chromium 的
// CDP 不支持这两个,不能那样复用)。无系统浏览器时这些能力优雅降级——PDF 导出由 printToPDF
// 独立可用、不受影响。getBrowser() 末尾仍恒附默认 Chromium 兜底(随包则用,没有就报错降级)。
if (!process.env.QINGAGENT_BROWSER_CHANNELS) {
  process.env.QINGAGENT_BROWSER_CHANNELS = "msedge,chrome";
}

// 桌面客户端跑在用户自己机器上,默认走系统直连,不套宿主环境的代理 env。背景:用户机器常带有
// 失效/翻墙代理 env(HTTPS_PROXY 等),被 Playwright(pool.ts proxyFromEnv)与 agent-browser(继承
// process.env)一并喂给 Chromium → ERR_PROXY_CONNECTION_FAILED,qq.com 等正常网页都打不开。
// 清掉后 Chromium 回退用 Windows 系统代理设置(即正常浏览行为),既"不限制网络"又能命中系统代理。
// 确实需要走代理的环境设 QINGAGENT_DESKTOP_KEEP_PROXY=1 保留。NO_PROXY 保留无害。
if (process.env.QINGAGENT_DESKTOP_KEEP_PROXY !== "1") {
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete process.env[k];
  }
}

// 客户端「上来纯空」:彻底不认 env/db 默认 key,只认用户在 app 设置里自带的 key
// (visitor key,存本地 localStorage、随请求 header 透传)。这里删掉从 userData/.env
// 读进来的 DEEPSEEK_API_KEY,使服务端任何兜底读取都拿不到默认 key,强制用户配置自己的 key;
// db 全局 key 客户端从不写入、天然为空。必须在 import server/core 之前执行。
delete process.env.DEEPSEEK_API_KEY;

// —— undici@8 / Electron-Node-20 兼容垫片(必须在引入 server/core 之前执行) ——
// Electron 33 内置 Node 20.18,其 node:worker_threads 没有 markAsUncloneable
// (该 API 是 Node 22 才加、未回移到 20)。undici@8.4.1 的 webidl/index.js 里
// `const { markAsUncloneable } = require('node:worker_threads')` 后直接
// `webidl.util.markAsUncloneable = markAsUncloneable`,无兜底 → 首次 new Headers()/
// CacheStorage 就抛 "markAsUncloneable is not a function" 启动崩溃。
// 这里给 worker_threads 的 module.exports 补一个 no-op(它只是 structuredClone 的
// 不可克隆标记,对我们的用法无副作用),让随后 require 它的 undici 取到合法函数。
{
  const wt = createRequire(import.meta.url)("node:worker_threads") as {
    markAsUncloneable?: (value: unknown) => void;
  };
  if (typeof wt.markAsUncloneable !== "function") {
    wt.markAsUncloneable = () => {};
  }
}

if (app.isPackaged && !process.env.QINGAGENT_SKILLS_DIR) {
  process.env.QINGAGENT_SKILLS_DIR = path.join(process.resourcesPath, "skills");
}

// 用户技能目录不再改写到 userData:打包版曾指向
// ~/Library/Application Support/@qingagent/desktop/skills,与用户/其它 CLI 实际的
// 安装位置(~/.qingagent/skills、~/.agents/skills)全都对不上,于是明明装过却被
// 告知"没安装"(0729 真机 P1)。这里保持 core 默认口径,由 core 统一多来源发现。
// 需要自定义时仍可显式设 QINGAGENT_USER_SKILLS_DIR。
//
// 但历史 userData 目录必须继续被扫到:存量用户此前经打包版装的技能就落在那里,
// 直接摘掉等于在他们身上复发同一个病。按"只增不搬"处理——追加成历史自有来源,
// 发现与管理面视同已安装,但 agent 沙箱仍只读；新技能仍装到现装目录。
// 追加而非覆盖,保留用户自设的值。
if (app.isPackaged) {
  const legacyUserSkillsDir = path.join(userDataDir, "skills");
  const existing = (process.env.QINGAGENT_LEGACY_USER_SKILLS_DIRS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!existing.includes(legacyUserSkillsDir)) {
    process.env.QINGAGENT_LEGACY_USER_SKILLS_DIRS = [...existing, legacyUserSkillsDir]
      .join(path.delimiter);
  }
}

if (app.isPackaged && !process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS) {
  process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS = [
    path.dirname(process.execPath),
    process.resourcesPath,
  ].join(path.delimiter);
}

{
  const {
    ensureNodeRuntimeShim,
    isElectronRuntime,
    pruneLegacyNodeRuntimeShims,
    renderWindowsNodeOptions,
  } = await import("@qingagent/core/workspace/runtime-shims");
  const { ensureLarkCliShim } = await import("@qingagent/core/workspace/runtime-shims");
  // 升级迁移(必须无条件执行,且必须早于任何沙箱 env 装配):老版本把 Electron-as-Node 的
  // `node` shim 直接写进常驻 PATH 最前的产品 CLI 目录,残留文件会继续劫持用户自己的
  // Node CLI——光靠"这次不生成"治不好,得把老文件删掉。
  const prunedLegacyShims = pruneLegacyNodeRuntimeShims();
  if (prunedLegacyShims.length > 0) {
    console.info("[sandbox] 已清除遗留在 PATH 目录里的 node shim", { prunedLegacyShims });
  }
  const electronRuntime = isElectronRuntime();
  // 产品自带运行时只写进独立的 node-runtime 目录:产品 CLI 按绝对路径显式引用它,
  // 宿主 CLI 走宿主 PATH 与宿主 Node(站位见 core 的 resolveNodeRuntimePathPlacement)。
  const nodeShimPath = path.resolve(
    ensureNodeRuntimeShim({ execPath: process.execPath, electron: electronRuntime }),
  );
  const nodeOptions = process.platform === "win32" && electronRuntime
    ? renderWindowsNodeOptions(path.dirname(nodeShimPath))
    : "<unset>";
  console.info("[sandbox] node runtime shim ready", {
    nodeShimPath,
    nodeOptions,
    nodeRuntimeSetting: process.env.QINGAGENT_SANDBOX_NODE_RUNTIME ?? "auto",
  });

  // 飞书 lark-cli:随包带到 Resources/lark-cli(build.mjs 暂存,electron-builder extraResources),
  // 首启往沙箱 PATH 写 `lark-cli` shim——经 node shim(Electron-as-Node)跑其 run.js。HOME/配置走
  // 宿主真实 HOME(沙箱透传),写真实 ~/.lark-cli 与用户已有飞书登录共用。瘦包(无随包 run.js)则跳过。
  if (app.isPackaged) {
    const larkRunJs = path.join(
      process.resourcesPath,
      "lark-cli",
      "node_modules",
      "@larksuite",
      "cli",
      "scripts",
      "run.js",
    );
    if (existsSync(larkRunJs)) {
      try {
        // 连接器 runner 在 Windows 不能 execFile(.cmd)，显式传入随包入口与 Electron Node
        // 运行时，改为 qingagent.exe + run.js 固定 argv。Unix/mac 仍走现有 PATH shim。
        process.env.QINGAGENT_LARK_CLI_RUN_JS = larkRunJs;
        process.env.QINGAGENT_LARK_CLI_NODE_PATH = process.execPath;
        process.env.QINGAGENT_LARK_CLI_ELECTRON_AS_NODE = electronRuntime ? "1" : "0";
        if (process.platform === "win32" && electronRuntime) {
          process.env.QINGAGENT_LARK_CLI_NODE_OPTIONS = renderWindowsNodeOptions(
            path.dirname(nodeShimPath),
          );
        }
        // 随包 lark-cli 一直在用宿主真实 ~/.lark-cli;改成声明式共享后,给它预置一条授权,
        // 老用户升级不会突然被一张确认卡拦住(仍可在 设置 → 安全 里收回)。
        process.env.QINGAGENT_PRESET_CREDENTIAL_PATHS = "~/.lark-cli";
        ensureLarkCliShim({ runJsPath: larkRunJs, nodePath: nodeShimPath });
      } catch (err) {
        console.warn("[lark-cli] shim 写入失败,飞书命令可能不可用:", err);
      }
    }
  }
}

// 桌面端是单用户本地环境,技能插拔(安装/删除)等同装自己的本地软件,默认放开。
if (!process.env.QINGAGENT_ALLOW_SKILL_MUTATION) {
  process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
}
if (!process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION) {
  process.env.QINGAGENT_ALLOW_TEMPLATE_MUTATION = "1";
}

// 桌面端是单用户本地环境,agent 执行命令 = 用户自己在本机跑,凭据注入 = 用本机自己的登录态。
// 安全默认翻转后(决策 4.5),这两项默认关闭;桌面显式补回以维持现状能力。必须在 import server/core 之前设。
if (!process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS) {
  process.env.QINGAGENT_ALLOW_UNISOLATED_COMMANDS = "1";
}
if (!process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS) {
  process.env.QINGAGENT_SANDBOX_INJECT_CREDENTIALS = "1";
}

// Python 能力(run_python):默认随包 Pyodide(build.mjs 默认 ON),运行时默认启用。
// 实际是否注入仍由 pyodideRunner 的资源探测把关——瘦包(无随包资源)即便启用也不会误注入,
// 只记一条 warn。打包态资源从 process.resourcesPath/pyodide 自动解析,无需额外配路径。
if (!process.env.QINGAGENT_PYODIDE_ENABLED) {
  process.env.QINGAGENT_PYODIDE_ENABLED = "1";
}

// Dynamic import after env is configured — server/core reads DATABASE_URL at module-evaluation time.
// TODO(B2 createQingagentRuntime):长期应由显式运行时工厂统一串起迁移、Mastra 与 server app。
const { isReportedServerStartupError, startServer } = await import("./server.js");
// 长 keep-alive 必须经 server 包转导出取 undici(desktop 无直接依赖且 esbuild 整包
// bundle,createRequire 在打包态解析不到),详见 httpDispatcher.ts 注释。
const { installLongKeepAliveDispatcher } = await import("@qingagent/server/httpDispatcher");
installLongKeepAliveDispatcher();
const { installNetProbe, resolveBaseUrl, warmUpModelEndpoint } = await import("@qingagent/core/llm/runtime");
const { telemetry } = await import("./telemetry/index.js");
const { attachRendererTelemetry } = await import("./telemetry/injectRenderer.js");

// PDF 导出复用 Electron 自带 Chromium(printToPDF):打包后没有随包 Playwright Chromium,
// 默认路径会硬失败到 500。注册自定义渲染器后,htmlToPdf 优先走 Electron,零增量体积。
{
  const { setHtmlToPdfRenderer } = await import("@qingagent/doc-render/export");
  const { systemBrowserExecutablePath } = await import("@qingagent/doc-render/browser");
  const { renderPdfViaElectron } = await import("./pdfRenderer.js");
  setHtmlToPdfRenderer(renderPdfViaElectron);

  // agent 浏览器(browser_*)桌面启用:探测到系统已装浏览器(Edge/Chrome)就默认开,并把
  // 可执行路径透传给 @mastra/agent-browser 的 executablePath。没有系统浏览器则不开(避免注入了
  // 又起不来)。用户已设环境变量则尊重不覆盖。pool.ts 的抓取/渲染走 channel(上面已设),此处补
  // browser_* 的 executablePath 通道。
  const sysBrowser = systemBrowserExecutablePath();
  if (sysBrowser && !process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH) {
    process.env.QINGAGENT_BROWSER_EXECUTABLE_PATH = sysBrowser;
  }
  if (sysBrowser && !process.env.QINGAGENT_AGENT_BROWSER) {
    process.env.QINGAGENT_AGENT_BROWSER = "1";
  }
}

let appOpenedCaptured = false;
const appStartedAt = Date.now();
let embeddedServerPort: number | null = null;
let embeddedServerReady: Promise<{ port: number }> | null = null;
let windowStartupInProgress = false;

const STARTUP_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #ece4d3; }
    body { display: grid; place-items: center; color: #2f2a22; font-family: "Songti SC", "STSong", serif; }
    .shell { display: grid; justify-items: center; gap: 14px; }
    .mark { font-size: 22px; letter-spacing: 0.36em; text-indent: 0.36em; }
    .breath { width: 42px; height: 1px; background: #6f6252; animation: breathe 1.8s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: 0.25; transform: scaleX(0.62); } 50% { opacity: 0.9; transform: scaleX(1); } }
    @media (prefers-reduced-motion: reduce) { .breath { animation: none; opacity: 0.65; } }
  </style>
</head>
<body><div class="shell"><div class="mark">青简</div><div class="breath"></div></div></body>
</html>`;
const STARTUP_SHELL_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_SHELL_HTML)}`;
const CHROMIUM_ERR_ABORTED = -3;
const CONTENT_HEALTH_PROBE_TIMEOUT_MS = 2_000;

function waitForContentLoadRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function probeEmbeddedServerHealth(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTENT_HEALTH_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function captureAppOpenedOnce() {
  if (appOpenedCaptured) return;
  appOpenedCaptured = true;
  telemetry.captureAppOpened();
}

function installTelemetryProcessErrorHandlers() {
  process.prependListener("uncaughtException", (err, origin) => {
    telemetry.captureError(err, {
      errorKind: "uncaughtException",
      errorOrigin: origin,
    });

    // 触发时实时判断：若除 telemetry 自身外无人接管，补回堆栈打印并退出，绝不静默吞崩溃。
    if (!hasOtherProcessErrorHandler(process.listenerCount("uncaughtException"))) {
      console.error("[telemetry] uncaughtException:", err);
      void telemetry.shutdown(1000).finally(() => process.exit(1));
    }
  });

  process.prependListener("unhandledRejection", (reason) => {
    telemetry.captureError(reason, {
      errorKind: "unhandledRejection",
    });

    // crashGuard 可能晚于 telemetry 安装，必须在触发时实时判断是否已有其他 handler。
    if (!hasOtherProcessErrorHandler(process.listenerCount("unhandledRejection"))) {
      console.error("[telemetry] unhandledRejection:", reason);
      void telemetry.shutdown(1000).finally(() => process.exit(1));
    }
  });
}

function rememberGrantKind(value: unknown): RememberGrantKind | null {
  return value === "install" || value === "command" ? value : null;
}

function boundedRememberId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function consumeTrustedRememberGesture(event: Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow;
  const senderIsDevtools = Boolean(
    window?.webContents.devToolsWebContents
      && event.sender.id === window.webContents.devToolsWebContents.id,
  );
  const mainFrame = event.sender.mainFrame;
  const isMainFrame = event.senderFrame !== null
    && event.frameId === mainFrame.routingId
    && event.processId === mainFrame.processId;
  return isMainFrame && trustedRememberUiGate.consume({
    senderId: event.sender.id,
    mainWindowSenderId: window && !window.isDestroyed() ? window.webContents.id : null,
    windowFocused: Boolean(window && !window.isDestroyed() && window.isFocused()),
    senderIsDevtools,
  });
}

function showTrustedRememberPrompt(
  owner: BrowserWindow,
  copy: RememberPromptCopy,
): Promise<RememberPromptDecision> {
  const promptWindow = new BrowserWindow({
    width: 480,
    height: 316,
    useContentSize: true,
    parent: owner,
    modal: true,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    title: copy.title,
    backgroundColor: "#10191d",
    webPreferences: {
      preload: path.join(__dirname, "../preload/rememberPrompt.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      spellcheck: false,
    },
  });
  const promptInputGate = new TrustedRememberUiGate();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: RememberPromptDecision) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(REMEMBER_PROMPT_DECISION_CHANNEL, handleDecision);
      if (!promptWindow.isDestroyed()) promptWindow.close();
      resolve(decision);
    };
    const handleDecision = (
      event: Electron.IpcMainEvent,
      decision: unknown,
    ) => {
      try {
        assertTrustedRenderer(event, promptWindow.webContents);
      } catch {
        return;
      }
      if (decision !== "remember" && decision !== "cancel") return;
      if (decision === "remember" && !promptInputGate.consume({
        senderId: event.sender.id,
        mainWindowSenderId: promptWindow.webContents.id,
        windowFocused: promptWindow.isFocused(),
        senderIsDevtools: Boolean(
          promptWindow.webContents.devToolsWebContents &&
          event.sender.id === promptWindow.webContents.devToolsWebContents.id,
        ),
      })) return;
      settle(decision);
    };

    ipcMain.on(REMEMBER_PROMPT_DECISION_CHANNEL, handleDecision);
    promptWindow.webContents.on("before-input-event", (_event, input) => {
      promptInputGate.record(promptWindow.webContents.id, input.type);
    });
    promptWindow.webContents.on("before-mouse-event", (_event, input) => {
      promptInputGate.record(promptWindow.webContents.id, input.type);
    });
    promptWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    promptWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
    promptWindow.webContents.once("render-process-gone", () => settle("cancel"));
    promptWindow.once("closed", () => settle("cancel"));
    promptWindow.once("ready-to-show", () => {
      if (!settled && !promptWindow.isDestroyed()) promptWindow.show();
    });

    const html = buildRememberPromptHtml(copy);
    void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => settle("cancel"));
  });
}

ipcMain.handle("qingagent:confirm-remember-grant", async (event, input: unknown) => {
  assertTrustedRenderer(event);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const sessionId = boundedRememberId(record.sessionId);
  const confirmId = boundedRememberId(record.confirmId);
  const kind = rememberGrantKind(record.kind);
  if (!sessionId || !confirmId || !kind || record.trustedGesture !== true) return null;
  if (!consumeTrustedRememberGesture(event)) return null;
  const owner = mainWindow;
  if (!owner || owner.isDestroyed()) return null;
  const generation = mainWindowRememberGeneration;
  const scope = mainWindowRememberScope;
  if (!scope) return null;
  return nativeRememberGrantGate.request({
    purpose: "confirm",
    kind,
    showPrompt: (copy) => showTrustedRememberPrompt(owner, copy),
    generation,
    register: async () => {
      const { registerConfirmUiGrant } = await import("@qingagent/server/confirmUiGrant");
      return registerConfirmUiGrant({
        purpose: "confirm",
        sessionId,
        confirmId,
        kind,
        ttlMs: 60_000,
        scope,
      });
    },
    revoke: async (nonce) => {
      const { revokeConfirmUiGrant } = await import("@qingagent/server/confirmUiGrant");
      revokeConfirmUiGrant(nonce);
    },
  });
});

ipcMain.handle("qingagent:settings-remember-grant", async (event, input: unknown) => {
  assertTrustedRenderer(event);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = rememberGrantKind(record.kind);
  if (!kind || record.trustedGesture !== true) return null;
  if (!consumeTrustedRememberGesture(event)) return null;
  const owner = mainWindow;
  if (!owner || owner.isDestroyed()) return null;
  const generation = mainWindowRememberGeneration;
  const scope = mainWindowRememberScope;
  if (!scope) return null;
  return nativeRememberGrantGate.request({
    purpose: "settings",
    kind,
    showPrompt: (copy) => showTrustedRememberPrompt(owner, copy),
    generation,
    register: async () => {
      const { registerConfirmUiGrant } = await import("@qingagent/server/confirmUiGrant");
      return registerConfirmUiGrant({ purpose: "settings", kind, ttlMs: 60_000, scope });
    },
    revoke: async (nonce) => {
      const { revokeConfirmUiGrant } = await import("@qingagent/server/confirmUiGrant");
      revokeConfirmUiGrant(nonce);
    },
  });
});

ipcMain.handle("qingagent:select-folder-source", async (event) => {
  assertTrustedRenderer(event);
  const startedAt = Date.now();
  let phase = "folderPicker.opened";
  console.info("[folderPicker]", {
    event: phase,
    webContentsId: event.sender.id,
  });
  try {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) {
      console.info("[folderPicker]", {
        event: "folderPicker.cancelled",
        durationMs: Date.now() - startedAt,
      });
      return null;
    }

    phase = "folderPicker.selected";
    console.info("[folderPicker]", {
      event: phase,
      durationMs: Date.now() - startedAt,
    });
    const selectedPath = result.filePaths[0]!;
    const {
      assertDirectory,
      registerDesktopFolderSelection,
    } = await import("@qingagent/server/desktopFolderSelection");
    const rootPath = await assertDirectory(selectedPath);
    phase = "folderPicker.validated";
    console.info("[folderPicker]", {
      event: phase,
      durationMs: Date.now() - startedAt,
    });

    // 关键路径只注册选择，不同步递归扫描目录。连接成功后由 server 现有的
    // startFolderSourceFileCountRefresh 在挂载后的 Workspace 内有界后台计数。
    const selection = registerDesktopFolderSelection({
      webContentsId: event.sender.id,
      rootPath,
      name: path.basename(rootPath),
      pathLabel: rootPath,
      fileCount: null,
      fileCountCapped: false,
    });
    phase = "folderPicker.tokenRegistered";
    console.info("[folderPicker]", {
      event: phase,
      durationMs: Date.now() - startedAt,
    });
    return {
      selectionToken: selection.selectionToken,
      name: selection.name,
      pathLabel: selection.pathLabel,
      fileCount: selection.fileCount,
      fileCountCapped: selection.fileCountCapped,
    };
  } catch (error) {
    console.warn("[folderPicker]", {
      event: "folderPicker.failed",
      phase,
      durationMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
});

ipcMain.handle("qingagent:update-quit-install", async (event) => {
  assertTrustedRenderer(event);
  return quitAndInstallUpdate();
});

ipcMain.handle("qingagent:update-status-get", (event) => {
  assertTrustedRenderer(event);
  return getCurrentUpdateStatus();
});

ipcMain.handle("qingagent:update-open-download", async (event) => {
  assertTrustedRenderer(event);
  await shell.openExternal(RELEASES_URL);
  return true;
});

// 应用版本号:沿用 client-config-get 的同步 IPC 先例,让 preload 启动期同步注入 window.electron.appVersion。
ipcMain.on("qingagent:app-version", (event) => {
  assertTrustedRenderer(event);
  event.returnValue = app.getVersion();
});

// 手动检查更新(关于页「检查更新」):请求-响应直接返回本次结果(含 error 态),不走推送假象。
ipcMain.handle("qingagent:update-check", async (event) => {
  assertTrustedRenderer(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) return { kind: "none" as const };
  return manualCheckForUpdates({ window: owner });
});

// 第三方开源声明:读打进安装包根部的 THIRD_PARTY_NOTICES.md;读不到返回 null,前端降级跳 GitHub。
ipcMain.handle("qingagent:third-party-notices-get", async (event) => {
  assertTrustedRenderer(event);
  try {
    const noticesPath = path.join(process.resourcesPath, "THIRD_PARTY_NOTICES.md");
    return readFileSync(noticesPath, "utf8");
  } catch {
    return null;
  }
});

// 客户端凭证/模型配置持久化:落 userData/client-config.json,与端口/origin 解耦。
// 背景:桌面打包版内置服务随机端口 → 窗口 origin 每次变 → localStorage 按 origin 隔离
// → 之前 visitor key 等存 localStorage 的配置「每次启动/换版都像丢」。改存 userData 后稳定。
// 渲染层经 clientPersist.ts 读写：preload 只暴露固定用途的具名 getter/setter；主进程内部
// IPC 仍按单项 key 传递，绝不一次解密并下发整份配置。
function clientConfigPath(): string {
  return path.join(app.getPath("userData"), "client-config.json");
}
function cleanupClientConfigTempFiles(): void {
  try {
    for (const entry of readdirSync(app.getPath("userData"), { withFileTypes: true })) {
      // 只回收本应用原子配置写入留下的临时文件，不碰目标文件或可恢复备份。
      if (!/^client-config(?:\.secrets)?\.json(?:\.bak)?\.\d+\.tmp$/.test(entry.name)) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        unlinkSync(path.join(app.getPath("userData"), entry.name));
      } catch {
        // 单个残片删不掉不阻断启动，后续启动会再次尝试。
      }
    }
  } catch {
    // userData 不存在或不可读时保持启动可用。
  }
}

const DESKTOP_CLIENT_CONFIG_KEYS = new Set([
  "qingagent.deepseek_api_key",
  "qingagent.custom_provider",
  "qingagent.vision_provider",
  "qingagent.official_model",
  "qingagent.model_tier",
  // 与 web clientPersist.ts、preload/index.ts 的具名 API 保持同步。
  "qingagent.kimi_api_key",
  "qingagent.kimi_custom_provider",
  "qingagent.kimi_official_model",
  "qingagent.kimi_model_tier",
  "qingagent.model_provider",
]);

// 这些值会直接或嵌套携带桌面模型 API Key。主进程只在单项 IPC 边界解密/加密；
// 磁盘上的普通 client-config.json 永远不保存这些项。
const DESKTOP_MODEL_SECRET_KEYS = new Set([
  "qingagent.deepseek_api_key",
  "qingagent.custom_provider",
  "qingagent.vision_provider",
  "qingagent.kimi_api_key",
  "qingagent.kimi_custom_provider",
]);

const desktopClientSecretStore = createDesktopClientSecretStore({
  filePath: path.join(app.getPath("userData"), "client-config.secrets.json"),
  secretKeys: DESKTOP_MODEL_SECRET_KEYS,
  safeStorage,
});

function isDesktopModelEncryptionAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // 与 credentialKeyProvider 的保护判定保持一致：Linux basic_text 只是明文混淆。
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  } catch {
    return false;
  }
}

function readClientConfig(): Record<string, string> {
  return readPrivateStringMap(clientConfigPath());
}
function writeClientConfig(cfg: Record<string, string>): void {
  writePrivateStringMap(clientConfigPath(), cfg);
}

/**
 * 首次安全读取时迁移旧 client-config.json 中的明文模型 key。
 * 顺序必须是先可靠写入密文、再清除明文；任一步失败都保留源文件，避免凭据丢失。
 */
function migratePlaintextClientSecrets(): void {
  if (!isDesktopModelEncryptionAvailable()) return;
  const cfg = readClientConfig();
  const plaintextEntries = Object.entries(cfg).filter(([key]) => DESKTOP_MODEL_SECRET_KEYS.has(key));
  if (plaintextEntries.length === 0) return;

  desktopClientSecretStore.writeMany(plaintextEntries);

  const sanitized = { ...cfg };
  for (const [key] of plaintextEntries) delete sanitized[key];
  writeClientConfig(sanitized);
}

function isDesktopClientConfigKey(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_CLIENT_CONFIG_KEYS.has(value);
}

function readClientConfigValueForRenderer(key: unknown): string | null {
  if (!isDesktopClientConfigKey(key)) return null;
  if (!DESKTOP_MODEL_SECRET_KEYS.has(key)) {
    try {
      const value = readClientConfig()[key];
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  // fail-closed：加密不可用时既不迁移/删除源明文，也绝不把它注入 renderer。
  if (!isDesktopModelEncryptionAvailable()) return null;
  try {
    migratePlaintextClientSecrets();
    return desktopClientSecretStore.read(key);
  } catch (err) {
    console.warn(`[client-config] ${key} 迁移/解密失败，已按未配置处理:`, err);
    return null;
  }
}

function writeClientConfigValue(key: unknown, value: unknown): boolean {
  if (!isDesktopClientConfigKey(key) || (value !== null && typeof value !== "string")) return false;
  const nextValue = typeof value === "string" && value.length > 0 ? value : null;
  try {
    const isSecret = DESKTOP_MODEL_SECRET_KEYS.has(key);
    const encryptionAvailable = isDesktopModelEncryptionAvailable();
    persistClientConfigValue({
      key,
      nextValue,
      isSecret,
      encryptionAvailable,
      migratePlaintextSecrets: migratePlaintextClientSecrets,
      readConfig: readClientConfig,
      writeConfig: writeClientConfig,
      secretStore: desktopClientSecretStore,
    });
    return true;
  } catch {
    return false;
  }
}

ipcMain.on("qingagent:client-config-value-get", (event, key: unknown) => {
  assertTrustedRenderer(event);
  event.returnValue = readClientConfigValueForRenderer(key);
});
ipcMain.handle("qingagent:client-config-value-set", (event, key: unknown, value: unknown) => {
  assertTrustedRenderer(event);
  return writeClientConfigValue(key, value);
});

ipcMain.handle("qingagent:export-diagnostics", async (event, opts: unknown) => {
  assertTrustedRenderer(event);
  if (!embeddedServerPort) throw new Error("embedded server is not ready");
  const privacyLevel = readPrivacyLevel(opts);
  const report = readReport(opts);
  const sessionIds = readSessionIds(opts);
  const origin = `http://127.0.0.1:${embeddedServerPort}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: origin,
  };
  if (process.env.QINGAGENT_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.QINGAGENT_AUTH_TOKEN}`;
  }
  const res = await fetch(`${origin}/api/v1/diagnostics/export`, {
    method: "POST",
    headers,
    body: JSON.stringify({ privacyLevel, report, sessionIds }),
  });
  if (!res.ok) {
    throw new Error(`diagnostics export failed: HTTP ${res.status}`);
  }

  const filename = filenameFromContentDisposition(res.headers.get("content-disposition")) ??
    `qingagent-diag-v1-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.zip`;
  const owner = BrowserWindow.fromWebContents(event.sender);
  const save = owner
    ? await dialog.showSaveDialog(owner, {
      defaultPath: filename,
      filters: [{ name: "诊断包", extensions: ["zip"] }],
    })
    : await dialog.showSaveDialog({
      defaultPath: filename,
      filters: [{ name: "诊断包", extensions: ["zip"] }],
    });
  if (save.canceled || !save.filePath) return { saved: false };

  writeFileSync(save.filePath, Buffer.from(await res.arrayBuffer()));
  return { saved: true, path: save.filePath };
});

function readPrivacyLevel(opts: unknown): "L1" | "L2" {
  if (opts && typeof opts === "object" && (opts as { privacyLevel?: unknown }).privacyLevel === "L2") {
    return "L2";
  }
  return "L1";
}

function readSessionIds(opts: unknown): string[] | undefined {
  if (!opts || typeof opts !== "object") return undefined;
  const raw = (opts as { sessionIds?: unknown }).sessionIds;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function readReport(opts: unknown): string {
  const value = opts && typeof opts === "object" ? (opts as { report?: unknown }).report : undefined;
  return typeof value === "string" ? value : "";
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return utf8;
    }
  }
  const plain = /filename="([^"]+)"/i.exec(value)?.[1] ?? /filename=([^;]+)/i.exec(value)?.[1];
  return plain ? plain.trim() : null;
}

function addAllowedOrigin(origins: Set<string>, url: string): void {
  try {
    origins.add(new URL(url).origin);
  } catch {
    console.warn("[startup] 忽略非法应用地址:", url);
  }
}

function installPackagedRendererProtocol(port: number): void {
  if (protocol.isProtocolHandled(DESKTOP_APP_SCHEME)) return;
  // 这一跳必须走 Node http 直连而非 net.fetch:后者取消不传播(SSE 连接永久泄漏)且受
  // Chromium 单主机 6 连接上限约束,叠加后会让事件流和随后的所有 API 请求集体静默挂起。
  // 详见 desktopAppProxyFetch.ts 头部注释。
  protocol.handle(
    DESKTOP_APP_SCHEME,
    createDesktopAppProxyHandler(port, createNodeHttpProxyFetch()),
  );
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (windowStartupInProgress) return;

  windowStartupInProgress = true;
  try {
    await createWindowOnce();
  } finally {
    windowStartupInProgress = false;
  }
}

async function createWindowOnce() {
  captureAppOpenedOnce();

  const isDev = !app.isPackaged;
  const devContentUrl = process.env.QINGAGENT_DESKTOP_DEV_URL ?? "http://localhost:6173";
  const allowedAppOrigins = new Set<string>();
  if (isDev) addAllowedOrigin(allowedAppOrigins, devContentUrl);

  // 顶部菜单栏(File / Edit / View / Window / Help)对终端用户无意义,整窗去掉。
  Menu.setApplicationMenu(null);

  // 窗口尺寸按主显示器工作区动态算后居中。
  const { width: waW, height: waH } = screen.getPrimaryDisplay().workAreaSize;
  const { width: winWidth, height: winHeight } = computeMainWindowSize(waW, waH);

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 960,
    minHeight: 600,
    center: true,
    title: "青简",
    autoHideMenuBar: true,
    // 原生底色、启动壳与 Web boot 契约统一为暖纸色，整个导航链路不产生色阶跳变。
    backgroundColor: "#ece4d3",
    show: false,
    webPreferences: {
      // preload 以 CommonJS .cjs 产出(见 build.mjs);ESM 的 .js preload 在 Electron 里
      // 加载不了,会导致 window.electron 缺失、文件夹连接退化成浏览器 FS 路径。
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 窗口失焦时保持完整帧率,动效不被降到 1fps(注意键名是 backgroundThrottling)。
      backgroundThrottling: false,
    },
  });
  const contentWindow = mainWindow;
  const rememberGeneration = nativeRememberGrantGate.reset();
  const rememberScope = `desktop-window:${rememberGeneration}`;
  mainWindowRememberGeneration = rememberGeneration;
  mainWindowRememberScope = rememberScope;

  // 仅主应用窗口开放文本编辑右键菜单；可信确认模态窗和 PDF 离屏窗保持无右键交互面。
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template = buildEditContextMenuTemplate(params);
    // 空模板 = 可编辑区域,由渲染进程自绘宋体菜单;这里再弹就成了双菜单。
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({
      window: contentWindow,
      frame: params.frame ?? undefined,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  });

  contentWindow.once("closed", () => {
    trustedRememberUiGate.clear();
    nativeRememberGrantGate.cancel(rememberGeneration);
    void import("@qingagent/server/confirmUiGrant")
      .then(({ clearConfirmUiGrantsForScope }) => {
        clearConfirmUiGrantsForScope(rememberScope);
      })
      .catch(() => undefined);
    if (mainWindow === contentWindow) {
      mainWindow = null;
      mainWindowRememberScope = null;
    }
  });

  contentWindow.webContents.on("before-input-event", (_event, input) => {
    trustedRememberUiGate.record(contentWindow.webContents.id, input.type);
  });
  contentWindow.webContents.on("before-mouse-event", (_event, input) => {
    trustedRememberUiGate.record(contentWindow.webContents.id, input.type);
  });

  attachRendererDiagnostics(contentWindow.webContents, desktopLogDir);

  // 外部链接走系统默认浏览器，不允许启动壳或内容页把主窗口导航到应用 origin 之外。
  // 监听器必须早于 data: 启动壳加载挂载，避免壳阶段的 http(s) 导航逃逸。
  contentWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  // 整页导航与服务端重定向：显式放行内置服务、开发服务器和当前同源；file:、about:、
  // 跨源及畸形 URL 都不能接管主窗口。用户主动点出的外部 Web 链接交给系统浏览器。
  const guardMainFrameNavigation = (event: MainFrameNavigationEvent, url: string): void => {
    if (
      !isAllowedMainFrameNavigation(
        url,
        contentWindow.webContents.getURL(),
        isDev ? devContentUrl : undefined,
        allowedAppOrigins,
      )
    ) {
      event.preventDefault();
    }
  };
  contentWindow.webContents.on("will-navigate", (event, url) => {
    handleMainWindowWillNavigate(
      event,
      url,
      contentWindow.webContents.getURL(),
      isDev ? devContentUrl : undefined,
      allowedAppOrigins,
      (targetUrl) => shell.openExternal(targetUrl),
    );
  });
  contentWindow.webContents.on("will-redirect", guardMainFrameNavigation);

  // 启动壳不依赖服务端和外部资源：先发起加载并立即显示暖纸窗口，再并行启动服务端。
  const startupShellReady = contentWindow.loadURL(STARTUP_SHELL_URL).catch((error) => {
    console.warn("[startup] 启动壳加载失败:", error);
  });
  contentWindow.show();
  const serverReady = embeddedServerReady ??= startServer({
    desktopLogDir,
    shutdownRecoveryMarkerPath,
  });

  // 迁移失败已由 startServer 报错；其余启动异常也必须明确告知并退出，不能永远停在启动壳。
  let port: number;
  try {
    ({ port } = await serverReady);
  } catch (error) {
    if (!isReportedServerStartupError(error)) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      dialog.showErrorBox(
        "本地服务启动失败",
        "青简无法启动本地服务，应用将退出。\n\n" + detail,
      );
    }
    app.exit(1);
    return;
  }
  embeddedServerPort = port;
  addAllowedOrigin(allowedAppOrigins, `http://localhost:${port}`);
  addAllowedOrigin(allowedAppOrigins, `http://127.0.0.1:${port}`);
  if (!isDev) {
    installPackagedRendererProtocol(port);
    allowedAppOrigins.add(DESKTOP_APP_ORIGIN);
  }
  installNetProbe();
  // 桌面端没有 env key,这里仅预热默认官方 endpoint;访客自定义 endpoint 随请求透传,此处无法提前知道。
  warmUpModelEndpoint(resolveBaseUrl());
  await maybeSeedInitialContent();
  await startupShellReady;
  if (contentWindow.isDestroyed()) return;

  // 启动壳已完成，遥测从此处挂载，确保首个 did-finish-load 对应真正内容页。
  attachRendererTelemetry(contentWindow, telemetry.getRendererBootstrap());

  const startUpdaterAfterContentLoad = (): void => {
    // 恢复过程会重新展示启动壳，不能让壳页的完成事件抢走 updater 的一次性启动机会。
    if (contentWindow.webContents.getURL() === STARTUP_SHELL_URL) return;
    contentWindow.webContents.off("did-finish-load", startUpdaterAfterContentLoad);
    setTimeout(() => {
      void startDesktopUpdater({ window: contentWindow });
    }, 250);
  };
  contentWindow.webContents.on("did-finish-load", startUpdaterAfterContentLoad);

  const contentUrl = isDev
    // 多 worktree 各自端口不同,用 QINGAGENT_DESKTOP_DEV_URL 覆盖;默认主 worktree 的 6173。
    ? devContentUrl
    // 打包态由固定可信 origin 转发到内置 Hono，Web Storage 不再受随机监听端口影响。
    : DESKTOP_APP_URL;

  let contentRecoveryActive = false;
  const recoverContentLoad = async (reason: unknown): Promise<void> => {
    if (contentRecoveryActive || contentWindow.isDestroyed()) return;
    contentRecoveryActive = true;
    console.error("[startup] 内容页加载失败，开始恢复:", reason);
    try {
      while (!contentWindow.isDestroyed()) {
        // 覆盖 Chromium 错误页，恢复期间持续显示与启动阶段一致的暖纸壳。
        await contentWindow.loadURL(STARTUP_SHELL_URL).catch((error) => {
          console.warn("[startup] 恢复启动壳加载失败:", error);
        });

        let completedRetries = 0;
        while (!contentWindow.isDestroyed()) {
          const step = nextContentLoadRecoveryStep(completedRetries);
          if (step.kind === "prompt") break;

          await waitForContentLoadRetry(step.delayMs);
          if (contentWindow.isDestroyed()) return;
          completedRetries = step.attempt;

          if (!(await probeEmbeddedServerHealth(port))) {
            console.warn(`[startup] 内容页第 ${step.attempt} 次恢复前健康探测失败`);
            continue;
          }

          try {
            await contentWindow.loadURL(contentUrl);
            return;
          } catch (error) {
            console.error(`[startup] 内容页第 ${step.attempt} 次恢复失败:`, error);
          }
        }

        if (contentWindow.isDestroyed()) return;
        const { response } = await dialog.showMessageBox(contentWindow, {
          type: "warning",
          title: "内容页加载失败",
          message: "青简当前无法加载内容页。",
          detail: "本地服务不可用或内容页加载失败。你可以重新尝试加载，或退出应用。",
          buttons: ["重试", "退出"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 1) {
          app.exit(1);
          return;
        }
        // 用户选择重试后重新展示启动壳，并获得完整的三次恢复机会。
      }
    } finally {
      contentRecoveryActive = false;
    }
  };

  contentWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === CHROMIUM_ERR_ABORTED) return;
      void recoverContentLoad({ errorCode, errorDescription, validatedURL });
    },
  );

  const contentLoad = contentWindow.loadURL(contentUrl);
  if (isDev || process.env.QINGAGENT_DEVTOOLS === "1") {
    contentWindow.webContents.openDevTools({ mode: "detach" });
  }
  void contentLoad.catch((error) => {
    console.error("[startup] 内容页加载失败:", error);
    void recoverContentLoad(error);
  });
}

// 首启示例内容(分叉骨架):桌面端「一辈子只 seed 一次」。
// once 门 = userData 下的版本化标记文件;seed 写入本身在 @qingagent/core 里(进程内、幂等)。
// 失败只记日志、绝不阻塞开窗。版本号便于将来需要换一套示例时另起 v2。
async function maybeSeedInitialContent() {
  const flagFile = path.join(app.getPath("userData"), ".qingagent-seeded-v1");
  if (existsSync(flagFile)) return;
  try {
    const { seedInitialContent } = await import("@qingagent/core");
    await seedInitialContent();
    writeFileSync(flagFile, new Date().toISOString());
  } catch (err) {
    // 落标记失败 / seed 失败都不影响主流程,下次启动会再试一次。
    console.warn("[seed] initial content seeding skipped:", err);
  }
}

// macOS GPU/渲染实验性开关:**默认关**,仅 QINGAGENT_MAC_GPU_TWEAKS=1 时启用。
// 审查结论:这组 flags 收益未经 Mac 实测证明,且有副作用(SkiaGraphite 在 Apple 多已默认开、
// PlatformVk 在当前 Chrome 版本未必是稳定 feature),故不默认上线、用 env 包住供实测;
// 确认有收益再固化。appendSwitch 必须在 app ready 之前调用。
if (process.platform === "darwin" && process.env.QINGAGENT_MAC_GPU_TWEAKS === "1") {
  app.commandLine.appendSwitch("enable-features", "PlatformVk,SkiaGraphite");
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  cleanupClientConfigTempFiles();
  const { cleanupOrphanedPdfExportDirs } = await import("./pdfRenderer.js");
  cleanupOrphanedPdfExportDirs();
  // safeStorage 仅在 app ready 后可靠；同时必须早于 createWindow() 内 startServer()，保证
  // server/core 业务模块首次读取凭据前 provider 已装配。Linux basic_text 不冒充 keychain。
  const credentialKeyState = await configureDesktopCredentialKeyProvider({
    safeStorage,
    dataDir: process.env.QINGAGENT_DATA_DIR!,
  });
  if (credentialKeyState.reasonCode) {
    console.warn("[credentials] key provider unavailable:", credentialKeyState.reasonCode);
  }
  if (process.env.QINGAGENT_SANDBOX_RUNTIME_PROBE === "1") {
    const { runSandboxRuntimeProbe } = await import("./sandboxRuntimeProbe.js");
    const result = await runSandboxRuntimeProbe();
    app.exit(result.ok ? 0 : 1);
    return;
  }
  await telemetry.init();
  // 仅在埋点启用时才接管进程错误事件:禁用(无 key,默认态)时不改变 Node/Electron 的崩溃行为。
  if (telemetry.enabled) installTelemetryProcessErrorHandlers();
  await createWindow();
});

const quitCoordinator = createDesktopQuitCoordinator({
  telemetryEnabled: () => telemetry.enabled,
  captureAppClosed: () => telemetry.captureAppClosed(Date.now() - appStartedAt),
  shutdownTelemetry: () => telemetry.shutdown(2000),
  drainServer: async (deadlineAtMs) => {
    const { drainDesktopSessionsForShutdown } = await import(
      "@qingagent/server/desktopShutdown"
    );
    await drainDesktopSessionsForShutdown({
      recoveryMarkerPath: shutdownRecoveryMarkerPath,
      deadlineAtMs,
    });
  },
  stopExternalInstance: async () => {
    const { stopExternalInstance } = await import(
      "@qingagent/server/externalInstance"
    );
    await stopExternalInstance();
  },
  quit: () => app.quit(),
});

app.on("before-quit", (event) => {
  void quitCoordinator.handleBeforeQuit(event);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!hasSingleInstanceLock) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
