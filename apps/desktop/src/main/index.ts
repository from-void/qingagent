import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
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
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadEnvFile } from "dotenv";
import { configureDesktopRuntimeEnv } from "./desktopRuntimeEnv.js";
import { configureDesktopCredentialKeyProvider } from "./credentialKeyProvider.js";
import { createDesktopClientSecretStore } from "./clientSecretStore.js";
import { persistClientConfigValue } from "./clientConfigPersistence.js";
import {
  HARDWARE_ACCELERATION_CONFIG_KEY,
  resolveHardwareAccelerationMode,
} from "./hardwareAcceleration.js";
import {
  DesktopAppDeepLinkDispatcher,
  DESKTOP_APP_ORIGIN,
  DESKTOP_APP_SCHEME,
  DESKTOP_APP_URL,
  resolveDesktopContentUrl,
} from "./desktopAppProtocol.js";
import {
  readPrivateStringMap,
  writePrivateStringMap,
} from "./privateJsonStore.js";
import { buildEditContextMenuTemplate } from "./contextMenu.js";
import { createRollingConsoleTransport } from "./diagnostics/rollingFiles.js";
import { attachRendererDiagnostics } from "./diagnostics/rendererLog.js";
import {
  attachMainWindowProcessMonitor,
  handleChildProcessGone,
  logRenderingMode,
  type MainWindowProcessMonitor,
} from "./diagnostics/processLifecycle.js";
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
  rememberGrantKind,
  TrustedRememberUiGate,
  type RememberPromptCopy,
  type RememberPromptDecision,
} from "./trustedRememberUi.js";
import { createConfirmRememberGrantHandler } from "./confirmRememberGrantHandler.js";
import { computeMainWindowSize } from "./windowSize.js";
import { nextContentLoadRecoveryStep } from "./contentLoadRecovery.js";
import { hasOtherProcessErrorHandler } from "./processErrorPolicy.js";
import { createDesktopQuitCoordinator } from "./quitCoordinator.js";
import { RendererDialogBroker } from "./rendererDialogBroker.js";
import { getLiveWebContents } from "./windowLifecycle.js";
import {
  showNativeContentRecoveryFallback,
  showNativeQuitFallback,
  showNativeRendererRecoveryStopped,
} from "./nativeDialogFallback.js";
import {
  DESKTOP_DIALOG_READY_CHANNEL,
  DESKTOP_DIALOG_RESPONSE_CHANNEL,
  isDesktopDialogKind,
  type DesktopDialogResponse,
  type DesktopDialogResult,
} from "../rendererDialogContract.js";
import {
  ExportDownloadCoordinator,
  EXPORT_DOWNLOAD_REVEAL_CHANNEL,
  EXPORT_DOWNLOAD_SAVE_CHANNEL,
} from "./exportDownloadCoordinator.js";
import { DIAGNOSTICS_EXPORT_CHANNEL } from "../diagnosticsExportContract.js";
import { exportDiagnosticsToDownloads } from "./diagnosticsExport.js";
import {
  QingjianDeepLinkDispatcher,
  registerQingjianProtocolClient,
  type QingjianDeepLinkHandler,
} from "./qingjianDeepLink.js";
import { QINGJIAN_OPEN_SESSION_CHANNEL } from "../qingjianDeepLinkContract.js";
import {
  BACKEND_CONNECTION_CHANGED_CHANNEL,
  BACKEND_CONNECTION_GET_CHANNEL,
  BACKEND_CONNECTION_RETRY_CHANNEL,
  BACKEND_STARTUP_ACTION_CHANNEL,
  BACKEND_STARTUP_PROMPT_CHANNEL,
  isBackendStartupAction,
  type BackendStartupAction,
  type BackendStartupPrompt,
} from "../backendConnectionContract.js";
import { discoverAttachInstances } from "./attachDiscovery.js";
import { decideAttachMode, type AttachModeDecision } from "./attachModeDecision.js";
import { resolveAttachHandshakeFailure } from "./attachStartupDecision.js";
import type { DiscoveredInstance, DiscoveryReport } from "./attachDiscoveryTypes.js";
import {
  AttachConnectionError,
  EmbeddedBackendConnection,
  connectAttachBackend,
  resolveQingjianDeepLink,
  type BackendConnection,
  type EmbeddedBackendInfo,
} from "./backendConnection.js";
import {
  DESKTOP_DATA_ORIGIN,
  DESKTOP_DATA_SCHEME,
  createDesktopDataProtocolHandler,
  createDesktopShellProtocolHandler,
  createPackagedAssetManifest,
} from "./desktopDataProtocol.js";
import type { AttachCapability } from "@qingagent/contract-ts";

let mainWindow: BrowserWindow | null = null;
let mainWindowProcessMonitor: MainWindowProcessMonitor | null = null;
let mainExportDownloadCoordinator: ExportDownloadCoordinator | null = null;
let desktopClientConfigReady = false;
const trustedRememberUiGate = new TrustedRememberUiGate();
const nativeRememberGrantGate = new NativeRememberGrantGate();
let mainWindowRememberGeneration = 0;
let mainWindowRememberScope: string | null = null;
const rendererDialogBroker = new RendererDialogBroker();

function focusAndShowWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const desktopDeepLinks = new DesktopAppDeepLinkDispatcher(process.argv);
const qingjianDeepLinks = new QingjianDeepLinkDispatcher(process.argv);
app.on("open-url", (event, url) => {
  event.preventDefault();
  desktopDeepLinks.offerUrl(url);
  qingjianDeepLinks.offerUrl(url);
});
const hasSingleInstanceLock = acquireSingleInstanceLock(
  app,
  () => mainWindow,
  (commandLine) => {
    desktopDeepLinks.offerCommandLine(commandLine);
    qingjianDeepLinks.offerCommandLine(commandLine);
  },
);

if (hasSingleInstanceLock) {
  const entryScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const registered = registerQingjianProtocolClient(app, {
    defaultApp: process.defaultApp === true,
    execPath: process.execPath,
    entryScript,
  });
  if (!registered) console.warn("[deep-link] qingjian 协议注册失败");
}

function assertTrustedRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  expectedRenderer?: WebContents | null,
): void {
  assertTrustedRendererEvent(
    event,
    expectedRenderer === undefined ? getLiveWebContents(mainWindow) : expectedRenderer,
  );
}

function isDesktopDialogResponse(value: unknown): value is DesktopDialogResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as { id?: unknown; result?: unknown };
  return (
    typeof response.id === "number" &&
    Number.isSafeInteger(response.id) &&
    (response.result === "confirm" || response.result === "cancel")
  );
}

ipcMain.on(DESKTOP_DIALOG_READY_CHANNEL, (event, rawKinds: unknown) => {
  assertTrustedRenderer(event);
  const kinds = Array.isArray(rawKinds)
    ? rawKinds.filter(isDesktopDialogKind)
    : [];
  rendererDialogBroker.markReady(event.sender, kinds);
  event.returnValue = true;
});

ipcMain.on(DESKTOP_DIALOG_RESPONSE_CHANNEL, (event, rawResponse: unknown) => {
  assertTrustedRenderer(event);
  if (!isDesktopDialogResponse(rawResponse)) return;
  rendererDialogBroker.respond(event.sender, rawResponse);
});

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

let embeddedCrashReporterStarted = false;

/** Crashpad 可能捕获进程内存；attach 模式绝不启动它。 */
function startEmbeddedCrashReporter(): void {
  if (embeddedCrashReporterStarted) return;
  embeddedCrashReporterStarted = true;
  const crashDumpsDir = path.join(userDataDir, "Crashpad");
  try {
    mkdirSync(crashDumpsDir, { recursive: true });
    app.setPath("crashDumps", crashDumpsDir);
    crashReporter.start({
      uploadToServer: false,
      globalExtra: {
        appMode: app.isPackaged ? "packaged" : "development",
      },
    });
    console.info("[process-lifecycle] crash-reporter-started", {
      crashDumpsDir,
      uploadToServer: false,
    });
  } catch (error) {
    console.error("[process-lifecycle] crash-reporter-start-failed", {
      crashDumpsDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

app.on("child-process-gone", (_event, details) => {
  handleChildProcessGone(details, {
    recoverGpu: (gpuDetails) => {
      mainWindowProcessMonitor?.requestGpuRecovery(gpuDetails);
    },
  });
});

// 仅在「从 WSL/UNC 网络路径运行」或「Linux」时禁用硬件加速,走软件渲染(SwiftShader)。
// 这些环境下 electron 的 GPU 子进程会启动失败(error_code=18)→ 反复崩溃 → FATAL
// "GPU process isn't usable" → 整个 app 闪退。本地 Windows 盘运行(正常使用)保留硬件加速、全速体验。
// __dirname 从 \\wsl.localhost\... / \\wsl$\... 这类 UNC 路径运行时以 `\\` 开头。
// 必须在 app ready 之前调用。
const runningFromUncPath = __dirname.startsWith("\\\\");
let hardwareAccelerationConfiguredValue: string | undefined;
try {
  hardwareAccelerationConfiguredValue = readPrivateStringMap(
    path.join(userDataDir, "client-config.json"),
  )[HARDWARE_ACCELERATION_CONFIG_KEY];
} catch {
  // 配置损坏不能改变默认行为；后续设置页仍可覆盖并修复该文件。
  console.warn("[client-config] 硬件加速配置读取失败，本次保持默认开启");
}
const renderingMode = resolveHardwareAccelerationMode({
  platform: process.platform,
  runningFromUncPath,
  configuredValue: hardwareAccelerationConfiguredValue,
});
if (process.platform === "linux" || runningFromUncPath) {
  app.disableHardwareAcceleration();
} else if (renderingMode.mode === "software") {
  app.disableHardwareAcceleration();
}
logRenderingMode(renderingMode);

// 标题栏统一玄青深色(用户定案):写作页左栏即玄青,浅色标题栏夹在深栏与宣纸之间反而突兀。
// 钉 dark 让 Windows/mac 一律画深色标题栏/窗控,再由下方 accentColor 把 Win11 caption 精确
// 涂成 --desk-base 玄青;icon 已带宣纸描边,深条上轮廓可辨。
nativeTheme.themeSource = "dark";

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
  {
    scheme: DESKTOP_DATA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const { telemetry } = await import("./telemetry/index.js");
const { attachRendererTelemetry } = await import("./telemetry/injectRenderer.js");

interface EmbeddedRuntime {
  startServer: typeof import("./server.js")["startServer"];
  isReportedServerStartupError: typeof import("./server.js")["isReportedServerStartupError"];
  installNetProbe: typeof import("@qingagent/core/llm/runtime")["installNetProbe"];
  resolveBaseUrl: typeof import("@qingagent/core/llm/runtime")["resolveBaseUrl"];
  warmUpModelEndpoint: typeof import("@qingagent/core/llm/runtime")["warmUpModelEndpoint"];
}
let embeddedRuntimeReady: Promise<EmbeddedRuntime> | null = null;

function prepareEmbeddedStorageEnvironment(): void {
  loadEnvFile({ path: path.join(userDataDir, ".env") });
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = pathToFileURL(path.join(userDataDir, "qingagent.db")).href;
  }
  if (!process.env.QINGAGENT_DATA_DIR) {
    process.env.QINGAGENT_DATA_DIR = path.join(userDataDir, "data");
  }
}

function initializeEmbeddedRuntime(): Promise<EmbeddedRuntime> {
  return embeddedRuntimeReady ??= initializeEmbeddedRuntimeOnce();
}

/** attach 决策完成前绝不能调用；此函数包含全部 server/core/DB 与本机库副作用。 */
async function initializeEmbeddedRuntimeOnce(): Promise<EmbeddedRuntime> {
prepareEmbeddedStorageEnvironment();
// 用户级配置:从 userData/.env 读密钥等(如 DEEPSEEK_API_KEY)。这样打包后的客户端
// 无需重新构建即可配置(把 .env 放进 %APPDATA%/<app>/ 即可)。必须在 import server 之前
// 加载——@qingagent/core 在模块求值期就读这些环境变量。
process.env.QINGAGENT_LOG_DIR = desktopLogDir;

// agent browser 的 storageState(JSON cookie/localStorage)与完整 profile 都是敏感凭据。
// desktop 只负责把 Electron userData 通过现有环境变量注入 doc-render，不让后者依赖 electron。
if (!process.env.QINGAGENT_BROWSER_STORAGE_STATE?.trim()) {
  process.env.QINGAGENT_BROWSER_STORAGE_STATE = path.join(
    userDataDir,
    ".qingagent-browser-state.json",
  );
}
if (!process.env.QINGAGENT_BROWSER_PROFILE_DIR?.trim()) {
  process.env.QINGAGENT_BROWSER_PROFILE_DIR = path.join(
    userDataDir,
    ".qingagent-browser-profile",
  );
}
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
// Windows 仍没有 seatbelt/bubblewrap 对应的 OS 文件隔离层(resolveIsolation 落到 none),
// 但 execute_command 已在 subprocess 创建前硬拒系统/青简凭据路径与工作区外写入。
// 后续若接入 Windows 原生隔离层，
// credential 例外仍需按声明+授权精确开口，不能回退成宿主 HOME 全通。
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

  cleanupClientConfigTempFiles();
  const credentialKeyState = await configureDesktopCredentialKeyProvider({
    safeStorage,
    dataDir: process.env.QINGAGENT_DATA_DIR!,
  });
  if (credentialKeyState.reasonCode) {
    console.warn("[credentials] key provider unavailable:", credentialKeyState.reasonCode);
  }
  desktopClientConfigReady = true;

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
    renderWindowsNodeOptions,
  } = await import("@qingagent/core/workspace/runtime-shims");
  const { ensureLarkCliShim } = await import("@qingagent/core/workspace/runtime-shims");
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

  // qa CLI:随包带到 Resources/qa-cli(build.mjs 打单文件,extraResources 拷入),
  // 首启写**用户终端**的 qa 命令(~/.qingagent/bin/qa,区别于沙箱 PATH 的 lark shim):
  // ELECTRON_RUN_AS_NODE 借应用自带运行时,用户机器不需要 Node。mac/linux 尽力
  // symlink /usr/local/bin/qa;两处都不在 PATH 时打印补 PATH 提示,不弹窗打扰。
  if (app.isPackaged) {
    const qaCliJs = path.join(process.resourcesPath, "qa-cli", "cli.mjs");
    if (existsSync(qaCliJs)) {
      try {
        const { ensureQaCliUserShim } = await import("@qingagent/core/workspace/runtime-shims");
        const qaShim = ensureQaCliUserShim({
          execPath: process.execPath,
          cliJsPath: qaCliJs,
        });
        if (qaShim.onPath) {
          console.info("[qa-cli] 终端 qa 命令已就绪", qaShim);
        } else {
          console.info(
            `[qa-cli] shim 已写入 ${qaShim.shimPath},但其目录不在 PATH;` +
              `终端使用前请执行:export PATH="$HOME/.qingagent/bin:$PATH"`,
          );
        }
      } catch (err) {
        console.warn("[qa-cli] 终端 shim 写入失败,qa 命令可能不可用:", err);
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

// 桌面端需要本地命令与受信技能凭据能力；这两项默认关闭，桌面显式补回。
// Windows 即使是 none 隔离也仍受 execute_command 硬路径 gate 约束。
// 必须在 import server/core 之前设。
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
const { isReportedServerStartupError, startServer } = await import("./server.js");
// 长 keep-alive 必须经 server 包转导出取 undici(desktop 无直接依赖且 esbuild 整包
// bundle,createRequire 在打包态解析不到),详见 httpDispatcher.ts 注释。
const { installLongKeepAliveDispatcher } = await import("@qingagent/server/httpDispatcher");
installLongKeepAliveDispatcher();
const { installNetProbe, resolveBaseUrl, warmUpModelEndpoint } = await import("@qingagent/core/llm/runtime");

// PDF 导出复用 Electron 自带 Chromium(printToPDF):打包后没有随包 Playwright Chromium,
// 默认路径会硬失败到 500。注册自定义渲染器后,htmlToPdf 优先走 Electron,零增量体积。
{
  const { setHtmlToPdfRenderer } = await import("@qingagent/doc-render/export");
  const { systemBrowserExecutablePath } = await import("@qingagent/doc-render/browser");
  const { renderPdfViaElectron } = await import("./pdfRenderer.js");
  const { cleanupOrphanedPdfExportDirs } = await import("./pdfRenderer.js");
  cleanupOrphanedPdfExportDirs();
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
  return {
    startServer,
    isReportedServerStartupError,
    installNetProbe,
    resolveBaseUrl,
    warmUpModelEndpoint,
  };
}

let appOpenedCaptured = false;
const appStartedAt = Date.now();
let embeddedServerPort: number | null = null;
let embeddedServerReady: Promise<EmbeddedBackendInfo> | null = null;
let activeBackend: BackendConnection | null = null;
let embeddedRediscoveryTimer: ReturnType<typeof setInterval> | null = null;
let windowStartupInProgress = false;

function backendCapability(name: AttachCapability): boolean {
  return activeBackend?.snapshot().effectiveCapabilities[name] === true;
}

function isEmbeddedBackendActive(): boolean {
  return activeBackend?.mode === "embedded";
}

// data: 启动壳不能依赖 Web CSS chunk；下列色值逐字镜像 UIKit tokens.css 的暖纸/金/墨，
// 类名与 ConfirmProvider 的 ws-folder-modal-* 保持同族，不另造一套产品视觉语言。
const STARTUP_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #ece4d3; }
    body { display: grid; place-items: center; color: #2f2a22; font-family: "Songti SC", "STSong", serif; }
    .shell { display: grid; justify-items: center; gap: 14px; }
    .product-icon { display: block; width: 52px; height: 52px; }
    .mark { font-size: 22px; letter-spacing: 0.36em; text-indent: 0.36em; }
    .breath { width: 42px; height: 1px; background: #5c5346; animation: breathe 1.8s ease-in-out infinite; }
    .ws-folder-modal-overlay { position: fixed; inset: 0; display: grid; place-items: center; padding: 26px; background: rgba(47, 42, 34, 0.34); }
    .ws-folder-modal-overlay[hidden], .shell[hidden] { display: none; }
    .ws-folder-confirm-modal { box-sizing: border-box; width: min(378px, 92vw); padding: 24px; color: #2f2a22; background: #efe7d6; border: 1px solid rgba(120, 90, 50, 0.28); box-shadow: 0 24px 60px rgba(50, 38, 18, 0.2), 0 4px 12px rgba(50, 38, 18, 0.08); }
    .ws-folder-confirm-modal h3 { margin: 0 0 10px; font-size: 16px; }
    .ws-folder-confirm-modal p { margin: 0 0 16px; color: #5c5346; font-size: 13px; line-height: 1.85; }
    .ws-folder-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
    .ws-folder-modal-affirm, .ws-folder-modal-secondary { border-radius: 0; padding: 8px 16px; font: 13px/1.2 "Songti SC", "STSong", serif; cursor: pointer; }
    .ws-folder-modal-affirm { color: #2f2a22; font-weight: 700; background: #a8823f; border: 1px solid #a8823f; }
    .ws-folder-modal-secondary { color: #5c5346; background: transparent; border: 1px solid rgba(120, 90, 50, 0.28); }
    .ws-folder-modal-affirm:disabled, .ws-folder-modal-secondary:disabled { cursor: wait; opacity: 0.58; }
    @keyframes breathe { 0%, 100% { opacity: 0.25; transform: scaleX(0.62); } 50% { opacity: 0.9; transform: scaleX(1); } }
    @media (prefers-reduced-motion: reduce) { .breath { animation: none; opacity: 0.65; } }
  </style>
</head>
<body>
  <div class="shell" id="startup-loading">
    <svg class="product-icon" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
      <defs><clipPath id="startup-icon-squircle"><rect width="400" height="400" rx="91" ry="91"/></clipPath></defs>
      <rect width="400" height="400" rx="91" ry="91" fill="#16212c"/>
      <g clip-path="url(#startup-icon-squircle)">
        <g transform="translate(-24 -24) scale(1.12)">
          <rect x="88" y="111" width="223" height="290" fill="#faf6ec"/>
          <rect x="120" y="143" width="71" height="13" fill="#e8dcb4"/>
          <rect x="209" y="143" width="71" height="13" fill="#e8dcb4"/>
          <rect x="120" y="174" width="71" height="13" fill="#e8dcb4"/>
          <rect x="209" y="174" width="71" height="13" fill="#e8dcb4"/>
          <rect x="120" y="205" width="71" height="13" fill="#e8dcb4"/>
          <rect x="209" y="205" width="71" height="13" fill="#e8dcb4"/>
          <rect x="120" y="246" width="160" height="13" fill="#e8dcb4"/>
          <rect x="120" y="277" width="160" height="13" fill="#e8dcb4"/>
          <rect x="120" y="308" width="160" height="13" fill="#e8dcb4"/>
        </g>
      </g>
      <rect width="400" height="400" rx="91" ry="91" fill="none" stroke="#faf6ec" stroke-opacity="0.55" stroke-width="12" clip-path="url(#startup-icon-squircle)"/>
    </svg>
    <div class="mark">青简</div>
    <div class="breath"></div>
  </div>
  <div class="ws-folder-modal-overlay" id="content-recovery" hidden>
    <section class="ws-folder-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="content-recovery-title">
      <h3 id="content-recovery-title">内容页加载失败</h3>
      <p>青简当前无法加载内容页。你可以重新尝试加载，或退出应用。</p>
      <div class="ws-folder-confirm-actions">
        <button class="ws-folder-modal-affirm" id="content-retry" type="button">重试</button>
        <button class="ws-folder-modal-secondary" id="content-exit" type="button">退出</button>
      </div>
    </section>
  </div>
  <div class="ws-folder-modal-overlay" id="backend-startup" hidden>
    <section class="ws-folder-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="backend-startup-title" aria-describedby="backend-startup-message">
      <h3 id="backend-startup-title">正在连接文库</h3>
      <p id="backend-startup-message"></p>
      <div id="backend-startup-errors" role="status" aria-live="polite"></div>
      <div id="backend-startup-candidates"></div>
      <div class="ws-folder-confirm-actions" id="backend-startup-actions">
        <button class="ws-folder-modal-affirm" id="backend-retry" type="button">重试</button>
        <button class="ws-folder-modal-secondary" id="backend-unbind" type="button" hidden>解绑并重新选择</button>
      </div>
    </section>
  </div>
  <script>
    (() => {
      const bridge = window.electron;
      if (!bridge || !bridge.onDesktopDialogRequest || !bridge.markDesktopDialogReady || !bridge.respondToDesktopDialog) return;
      const loading = document.getElementById("startup-loading");
      const recovery = document.getElementById("content-recovery");
      const retry = document.getElementById("content-retry");
      const exit = document.getElementById("content-exit");
      const backendStartup = document.getElementById("backend-startup");
      const backendTitle = document.getElementById("backend-startup-title");
      const backendMessage = document.getElementById("backend-startup-message");
      const backendErrors = document.getElementById("backend-startup-errors");
      const backendCandidates = document.getElementById("backend-startup-candidates");
      const backendRetry = document.getElementById("backend-retry");
      const backendUnbind = document.getElementById("backend-unbind");
      const detach = bridge.onDesktopDialogRequest((request) => {
        if (request.kind !== "content-load-failed") return;
        loading.hidden = true;
        recovery.hidden = false;
        retry.disabled = false;
        exit.disabled = false;
        const respond = (result) => {
          retry.disabled = true;
          exit.disabled = true;
          bridge.respondToDesktopDialog(request.id, result);
        };
        retry.onclick = () => respond("confirm");
        exit.onclick = () => respond("cancel");
        retry.focus();
      });
      bridge.markDesktopDialogReady(["content-load-failed"]);
      const detachBackend = bridge.onBackendStartupPrompt?.((prompt) => {
        loading.hidden = true;
        recovery.hidden = true;
        backendStartup.hidden = false;
        backendTitle.textContent = prompt.title;
        backendMessage.textContent = prompt.message;
        backendErrors.textContent = prompt.kind === "blocked" && prompt.errorCodes.length
          ? "错误码：" + prompt.errorCodes.join("、")
          : "";
        backendCandidates.replaceChildren();
        backendRetry.hidden = prompt.kind !== "blocked";
        backendUnbind.hidden = prompt.kind !== "blocked" || !prompt.allowUnbind;
        const respond = (action) => {
          backendRetry.disabled = true;
          backendUnbind.disabled = true;
          void bridge.respondToBackendStartupPrompt({ promptId: prompt.id, ...action });
        };
        backendRetry.onclick = () => respond({ kind: "retry" });
        backendUnbind.onclick = () => respond({ kind: "unbind" });
        if (prompt.kind === "select") {
          for (const candidate of prompt.candidates) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ws-folder-modal-secondary";
            button.style.display = "block";
            button.style.width = "100%";
            button.style.margin = "8px 0";
            button.textContent = "端口 " + candidate.port + " · " + candidate.startedAt + " · " + candidate.version;
            button.onclick = () => respond({ kind: "select", candidateId: candidate.id });
            backendCandidates.append(button);
          }
          backendCandidates.querySelector("button")?.focus();
        } else {
          backendRetry.disabled = false;
          backendUnbind.disabled = false;
          backendRetry.focus();
        }
      });
      window.addEventListener("unload", detach, { once: true });
      if (detachBackend) window.addEventListener("unload", detachBackend, { once: true });
    })();
  </script>
</body>
</html>`;
const STARTUP_SHELL_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_SHELL_HTML)}`;
const CHROMIUM_ERR_ABORTED = -3;

function waitForContentLoadRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

function consumeTrustedRememberGesture(event: Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow;
  const contents = getLiveWebContents(window);
  const devToolsContents = contents?.devToolsWebContents;
  const senderIsDevtools = Boolean(
    devToolsContents
      && !devToolsContents.isDestroyed()
      && event.sender.id === devToolsContents.id,
  );
  const mainFrame = event.sender.mainFrame;
  const isMainFrame = event.senderFrame !== null
    && event.frameId === mainFrame.routingId
    && event.processId === mainFrame.processId;
  return isMainFrame && trustedRememberUiGate.consume({
    senderId: event.sender.id,
    mainWindowSenderId: contents?.id ?? null,
    windowFocused: Boolean(contents && window?.isFocused()),
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
  const promptWebContents = promptWindow.webContents;
  const promptWebContentsId = promptWebContents.id;
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
      if (getLiveWebContents(promptWindow) !== promptWebContents) return;
      try {
        assertTrustedRenderer(event, promptWebContents);
      } catch {
        return;
      }
      if (decision !== "remember" && decision !== "cancel") return;
      const devToolsContents = promptWebContents.devToolsWebContents;
      if (decision === "remember" && !promptInputGate.consume({
        senderId: event.sender.id,
        mainWindowSenderId: promptWebContentsId,
        windowFocused: promptWindow.isFocused(),
        senderIsDevtools: Boolean(
          devToolsContents &&
          !devToolsContents.isDestroyed() &&
          event.sender.id === devToolsContents.id,
        ),
      })) return;
      settle(decision);
    };

    ipcMain.on(REMEMBER_PROMPT_DECISION_CHANNEL, handleDecision);
    promptWebContents.on("before-input-event", (_event, input) => {
      promptInputGate.record(promptWebContentsId, input.type);
    });
    promptWebContents.on("before-mouse-event", (_event, input) => {
      promptInputGate.record(promptWebContentsId, input.type);
    });
    promptWebContents.setWindowOpenHandler(() => ({ action: "deny" }));
    promptWebContents.on("will-attach-webview", (event) => event.preventDefault());
    promptWebContents.once("render-process-gone", () => settle("cancel"));
    promptWindow.once("closed", () => settle("cancel"));
    promptWindow.once("ready-to-show", () => {
      if (!settled && !promptWindow.isDestroyed()) promptWindow.show();
    });

    const html = buildRememberPromptHtml(copy);
    void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => settle("cancel"));
  });
}

const confirmRememberGrantHandler = createConfirmRememberGrantHandler({
  consumeTrustedRememberGesture,
  getContext: () => {
    const owner = mainWindow;
    const scope = mainWindowRememberScope;
    if (!owner || !getLiveWebContents(owner) || !scope) return null;
    return {
      generation: mainWindowRememberGeneration,
      scope,
      showPrompt: (copy) => showTrustedRememberPrompt(owner, copy),
    };
  },
  gate: nativeRememberGrantGate,
  register: async ({ sessionId, confirmId, kind, scope }) => {
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
ipcMain.handle("qingagent:confirm-remember-grant", async (event, input: unknown) => {
  assertTrustedRenderer(event);
  if (!backendCapability("confirmGrant")) return null;
  return confirmRememberGrantHandler(event, input);
});

ipcMain.handle("qingagent:settings-remember-grant", async (event, input: unknown) => {
  assertTrustedRenderer(event);
  if (!backendCapability("confirmGrant")) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = rememberGrantKind(record.kind);
  if (!kind || record.trustedGesture !== true) return null;
  if (!consumeTrustedRememberGesture(event)) return null;
  const owner = mainWindow;
  if (!owner || !getLiveWebContents(owner)) return null;
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
  if (!backendCapability("folderSelection")) return null;
  const startedAt = Date.now();
  let phase = "folderPicker.opened";
  const webContentsId = event.sender.id;
  console.info("[folderPicker]", {
    event: phase,
    webContentsId,
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
      webContentsId,
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

ipcMain.handle(EXPORT_DOWNLOAD_SAVE_CHANNEL, (event, input: unknown) => {
  assertTrustedRenderer(event);
  if (!backendCapability("documentExport")) {
    return { saved: false, filename: "qingagent-export", reason: "not-supported" };
  }
  return mainExportDownloadCoordinator?.save(event.sender, input) ?? {
    saved: false,
    filename: "qingagent-export",
    reason: "not-started",
  };
});

ipcMain.handle(EXPORT_DOWNLOAD_REVEAL_CHANNEL, (event, token: unknown) => {
  assertTrustedRenderer(event);
  if (!backendCapability("documentExport")) return false;
  const filePath = mainExportDownloadCoordinator?.resolveRevealPath(event.sender, token);
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle("qingagent:update-quit-install", async (event) => {
  assertTrustedRenderer(event);
  if (!backendCapability("updates")) return false;
  return quitAndInstallUpdate();
});

ipcMain.handle("qingagent:update-status-get", (event) => {
  assertTrustedRenderer(event);
  if (!backendCapability("updates")) return { kind: "none" as const };
  return getCurrentUpdateStatus();
});

ipcMain.handle("qingagent:update-open-download", async (event) => {
  assertTrustedRenderer(event);
  if (!backendCapability("updates")) return false;
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
  if (!backendCapability("updates")) return { kind: "none" as const };
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || !getLiveWebContents(owner)) return { kind: "none" as const };
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
  "qingagent.hardware_acceleration",
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

type DesktopClientConfigReadResult =
  | { ok: true; value: string | null }
  | { ok: false };

function readClientConfigValueForRenderer(key: unknown): DesktopClientConfigReadResult {
  if (!desktopClientConfigReady || !isDesktopClientConfigKey(key)) return { ok: false };
  if (key !== HARDWARE_ACCELERATION_CONFIG_KEY && !backendCapability("modelKeys")) {
    return { ok: false };
  }
  if (!DESKTOP_MODEL_SECRET_KEYS.has(key)) {
    try {
      const value = readClientConfig()[key];
      return {
        ok: true,
        value: typeof value === "string" && value.length > 0 ? value : null,
      };
    } catch {
      return { ok: false };
    }
  }

  // fail-closed：加密不可用时既不迁移/删除源明文，也绝不把它注入 renderer。
  if (!isDesktopModelEncryptionAvailable()) return { ok: false };
  try {
    migratePlaintextClientSecrets();
    return { ok: true, value: desktopClientSecretStore.read(key) };
  } catch (err) {
    console.warn(`[client-config] ${key} 迁移/解密失败，暂不发布配置状态:`, err);
    return { ok: false };
  }
}

function writeClientConfigValue(key: unknown, value: unknown): boolean {
  if (!isDesktopClientConfigKey(key) || (value !== null && typeof value !== "string")) return false;
  if (key !== HARDWARE_ACCELERATION_CONFIG_KEY && !backendCapability("modelKeys")) return false;
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
ipcMain.on("qingagent:client-config-ready-get", (event) => {
  assertTrustedRenderer(event);
  event.returnValue = desktopClientConfigReady;
});
ipcMain.handle("qingagent:client-config-value-set", (event, key: unknown, value: unknown) => {
  assertTrustedRenderer(event);
  return writeClientConfigValue(key, value);
});

ipcMain.handle(DIAGNOSTICS_EXPORT_CHANNEL, async (event, opts: unknown) => {
  assertTrustedRenderer(event);
  if (!backendCapability("diagnosticsExport")) {
    return { saved: false, reason: "not-supported" as const };
  }
  const coordinator = mainExportDownloadCoordinator;
  if (!embeddedServerPort || !coordinator) {
    return { saved: false, reason: "not-started" as const };
  }
  const origin = `http://127.0.0.1:${embeddedServerPort}`;
  return exportDiagnosticsToDownloads(opts, {
    serverOrigin: origin,
    downloadsDirectory: app.getPath("downloads"),
    authToken: process.env.QINGAGENT_AUTH_TOKEN,
    save: (input) => coordinator.save(event.sender, input),
  });
});

function addAllowedOrigin(origins: Set<string>, url: string): void {
  try {
    origins.add(new URL(url).origin);
  } catch {
    console.warn("[startup] 忽略非法应用地址:", url);
  }
}

async function installRendererProtocols(
  contents: WebContents,
  backend: BackendConnection,
  isDev: boolean,
  rendererOrigin: string,
): Promise<void> {
  const rendererSession = contents.session;
  await rendererSession.clearCache();
  if (!rendererSession.protocol.isProtocolHandled(DESKTOP_DATA_SCHEME)) {
    rendererSession.protocol.handle(
      DESKTOP_DATA_SCHEME,
      createDesktopDataProtocolHandler(backend, rendererOrigin),
    );
  }
  if (!isDev && !rendererSession.protocol.isProtocolHandled(DESKTOP_APP_SCHEME)) {
    const manifest = await createPackagedAssetManifest(path.join(process.resourcesPath, "web"));
    rendererSession.protocol.handle(
      DESKTOP_APP_SCHEME,
      createDesktopShellProtocolHandler(manifest),
    );
  }
  const dataResourceFilter = { urls: [`${DESKTOP_DATA_ORIGIN}/*`] };
  rendererSession.webRequest.onBeforeRequest(dataResourceFilter, (details, callback) => {
    const executableTypes = new Set([
      "mainFrame", "subFrame", "script", "stylesheet", "worker", "sharedWorker", "object", "media",
    ]);
    callback({ cancel: executableTypes.has(details.resourceType) });
  });
}

const BOUND_LIBRARY_CONFIG_KEY = "boundLibraryId";

function attachBindingPath(): string {
  return path.join(app.getPath("userData"), "attach-binding.json");
}

function readBoundLibraryId(): string | null {
  try {
    const value = readPrivateStringMap(attachBindingPath())[BOUND_LIBRARY_CONFIG_KEY];
    return typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function persistBoundLibraryId(libraryId: string | null): void {
  const current = readPrivateStringMap(attachBindingPath());
  if (libraryId) current[BOUND_LIBRARY_CONFIG_KEY] = libraryId;
  else delete current[BOUND_LIBRARY_CONFIG_KEY];
  writePrivateStringMap(attachBindingPath(), current);
}

function discoveryWorkerPath(): { workerPath: string; developmentWorker: boolean } {
  return app.isPackaged
    ? { workerPath: path.join(__dirname, "attach-discovery-worker.js"), developmentWorker: false }
    : { workerPath: path.join(__dirname, "attachDiscoveryWorker.ts"), developmentWorker: true };
}

function runAttachDiscovery(): Promise<DiscoveryReport> {
  return discoverAttachInstances({
    home: os.homedir(),
    platform: process.platform,
    execPath: process.execPath,
    ...discoveryWorkerPath(),
  });
}

function startEmbeddedRediscovery(backend: EmbeddedBackendConnection): void {
  if (embeddedRediscoveryTimer) return;
  const inspect = async (): Promise<void> => {
    if (activeBackend !== backend) return;
    const current = backend.snapshot();
    const report = await runAttachDiscovery();
    const conflicting = report.observations.some((observation) => (
      observation.state === "valid"
      && (
        observation.instance.instanceId !== current.instanceId
        || observation.instance.libraryId !== current.libraryId
      )
    ));
    const pending = !conflicting && report.observations.some((observation) => (
      observation.state === "indeterminate"
      && observation.errorCode === "STARTING_LEASE"
    ));
    backend.reportForeignDiscovery({ pending, conflicting });
  };
  embeddedRediscoveryTimer = setInterval(() => void inspect(), 60_000);
  embeddedRediscoveryTimer.unref?.();
}

let startupPromptSequence = 0;
const pendingStartupPrompts = new Map<number, (action: BackendStartupAction) => void>();

type BackendStartupPromptInput =
  | Omit<Extract<BackendStartupPrompt, { kind: "blocked" }>, "id">
  | Omit<Extract<BackendStartupPrompt, { kind: "select" }>, "id">;

ipcMain.handle(BACKEND_STARTUP_ACTION_CHANNEL, (event, rawAction: unknown) => {
  assertTrustedRenderer(event);
  if (!isBackendStartupAction(rawAction)) return false;
  const resolve = pendingStartupPrompts.get(rawAction.promptId);
  if (!resolve) return false;
  pendingStartupPrompts.delete(rawAction.promptId);
  resolve(rawAction);
  return true;
});

function requestBackendStartupAction(
  contents: WebContents,
  prompt: BackendStartupPromptInput,
): Promise<BackendStartupAction> {
  const id = ++startupPromptSequence;
  return new Promise((resolve) => {
    pendingStartupPrompts.set(id, resolve);
    contents.send(BACKEND_STARTUP_PROMPT_CHANNEL, { ...prompt, id });
  });
}

function blockedPrompt(
  decision: Extract<AttachModeDecision, { kind: "blocked" }>,
): Omit<Extract<BackendStartupPrompt, { kind: "blocked" }>, "id"> {
  const copy = decision.reason === "bound-missing-other"
    ? ["已绑定文库缺失", "发现了其他文库。为防止写入错误文库，请显式解绑后重新选择。"]
    : decision.reason === "bound-missing"
      ? ["找不到既有文库", "青简没有找到已绑定文库。请确认后台已启动后重试，或显式解绑。"]
      : ["暂时无法确定文库", "实例发现未能安全完成。青简不会在状态不明时创建第二个文库。"];
  return {
    kind: "blocked",
    title: copy[0]!,
    message: copy[1]!,
    errorCodes: decision.errorCodes,
    allowUnbind: decision.allowUnbind,
  };
}

async function selectStartupInstance(
  contents: WebContents,
  candidates: DiscoveredInstance[],
): Promise<DiscoveredInstance> {
  const choices = candidates.map((instance, index) => ({
    id: `choice-${index + 1}`,
    instance,
  }));
  while (true) {
    const action = await requestBackendStartupAction(contents, {
      kind: "select",
      title: "选择要连接的文库",
      message: "检测到多个可用后台。请选择本次要使用的实例；青简不会自动合并文库。",
      candidates: choices.map(({ id, instance }) => ({
        id,
        port: instance.port,
        startedAt: instance.startedAt,
        version: instance.version,
      })),
    });
    const selected = action.kind === "select"
      ? choices.find((choice) => choice.id === action.candidateId)
      : null;
    if (selected) return selected.instance;
  }
}

const STARTUP_AUTO_RETRY_DELAYS_MS = [100, 250, 500] as const;

function startupFailureCode(prefix: string, error: unknown): string {
  const detail = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return detail && /^[A-Z0-9_]+$/.test(detail) ? `${prefix}_${detail}` : prefix;
}

async function handleAutomaticStartupFailure(
  contents: WebContents,
  previousFailures: number,
  errorCode: string,
  message: string,
): Promise<number> {
  const nextFailures = previousFailures + 1;
  const delayMs = STARTUP_AUTO_RETRY_DELAYS_MS[nextFailures - 1];
  if (delayMs !== undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return nextFailures;
  }
  await requestBackendStartupAction(contents, {
    kind: "blocked",
    title: "后台启动受阻",
    message,
    errorCodes: [errorCode],
    allowUnbind: false,
  });
  return 0;
}

async function connectSelectedAttach(
  instance: DiscoveredInstance,
): Promise<BackendConnection> {
  return connectAttachBackend(instance, {
    rediscover: async (libraryId) => {
      const report = await runAttachDiscovery();
      const decision = decideAttachMode(report, libraryId);
      if (decision.kind === "attach") return decision.instance;
      return report.observations.some((observation) => (
        observation.state === "indeterminate"
        && observation.errorCode === "STARTING_LEASE"
      ))
        ? { errorCode: "STARTING_LEASE" as const }
        : null;
    },
  });
}

async function resolveStartupBackend(contents: WebContents): Promise<BackendConnection> {
  let boundLibraryId = readBoundLibraryId();
  let automaticStartupFailures = 0;
  while (true) {
    const report = await runAttachDiscovery();
    let decision = decideAttachMode(report, boundLibraryId);
    if (decision.kind === "select") {
      decision = { kind: "attach", instance: await selectStartupInstance(contents, decision.candidates) };
    }
    if (decision.kind === "blocked") {
      automaticStartupFailures = 0;
      const action = await requestBackendStartupAction(contents, blockedPrompt(decision));
      if (action.kind === "unbind" && decision.allowUnbind) {
        persistBoundLibraryId(null);
        boundLibraryId = null;
      }
      continue;
    }
    if (decision.kind === "embedded") {
      prepareEmbeddedStorageEnvironment();
      const { acquireStartingLease, dataDirDigest } = await import(
        "@qingagent/server/externalInstance"
      );
      let claim: Awaited<ReturnType<typeof acquireStartingLease>>;
      try {
        claim = await acquireStartingLease({
          dataDirDigest: dataDirDigest(process.env.DATABASE_URL!),
        });
      } catch (error) {
        automaticStartupFailures = await handleAutomaticStartupFailure(
          contents,
          automaticStartupFailures,
          startupFailureCode("STARTING_LEASE_ACQUIRE_FAILED", error),
          "青简无法取得本地文库启动租约。已停止自动重试，请检查数据目录权限或磁盘状态后重试。",
        );
        continue;
      }
      if (claim.kind === "existing") {
        const racedInstance: DiscoveredInstance = {
          ...claim.instance,
          endpoint: `http://127.0.0.1:${claim.instance.port}`,
          source: "local",
        };
        try {
          const backend = await connectSelectedAttach(racedInstance);
          persistBoundLibraryId(racedInstance.libraryId);
          return backend;
        } catch (error) {
          automaticStartupFailures = await handleAutomaticStartupFailure(
            contents,
            automaticStartupFailures,
            startupFailureCode("RACED_INSTANCE_HANDSHAKE_FAILED", error),
            "新发现的后台未能完成认证。已停止自动重试，请确认后台状态后重试。",
          );
          continue;
        }
      }

      startEmbeddedCrashReporter();
      let runtime: EmbeddedRuntime;
      try {
        runtime = await initializeEmbeddedRuntime();
      } catch (error) {
        await claim.lease.release().catch(() => undefined);
        throw error;
      }
      if (process.env.QINGAGENT_SANDBOX_RUNTIME_PROBE === "1") {
        const { runSandboxRuntimeProbe } = await import("./sandboxRuntimeProbe.js");
        const result = await runSandboxRuntimeProbe();
        await claim.lease.release().catch(() => undefined);
        app.exit(result.ok ? 0 : 1);
        throw new Error("sandbox runtime probe completed");
      }
      const serverInfo = await (embeddedServerReady ??= runtime.startServer({
        desktopLogDir,
        shutdownRecoveryMarkerPath,
        startingLease: claim.lease,
      }));
      embeddedServerPort = serverInfo.port;
      return new EmbeddedBackendConnection(serverInfo);
    }

    try {
      const backend = await connectSelectedAttach(decision.instance);
      persistBoundLibraryId(decision.instance.libraryId);
      return backend;
    } catch (error) {
      // health 与 handshake 之间实例若恰好退出，再发现为确定 absent 时才允许回到 embedded。
      const retryReport = await runAttachDiscovery();
      const fallback = resolveAttachHandshakeFailure(retryReport, boundLibraryId);
      const code = error instanceof AttachConnectionError ? error.code : "UNREACHABLE";
      if (fallback.kind === "embedded") {
        automaticStartupFailures = await handleAutomaticStartupFailure(
          contents,
          automaticStartupFailures,
          `ATTACH_DISAPPEARED_${code}`,
          "发现到的后台在认证前退出。已停止自动重试，请确认后台状态后重试。",
        );
        continue;
      }
      automaticStartupFailures = 0;
      const action = await requestBackendStartupAction(contents, {
        kind: "blocked",
        title: code === "INCOMPATIBLE" ? "后台版本不兼容" : "连接后台失败",
        message: "青简未取得可用的 attach 会话，不会改为写入另一个文库。请检查后台后重试。",
        errorCodes: [code],
        allowUnbind: false,
      });
      if (action.kind === "retry") continue;
    }
  }
}

let detachBackendSnapshotListener: (() => void) | null = null;

function installActiveBackend(backend: BackendConnection): void {
  if (activeBackend === backend) return;
  detachBackendSnapshotListener?.();
  activeBackend?.dispose();
  activeBackend = backend;
  detachBackendSnapshotListener = backend.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = getLiveWebContents(window);
      if (contents) contents.send(BACKEND_CONNECTION_CHANGED_CHANNEL, snapshot);
    }
  });
}

ipcMain.on(BACKEND_CONNECTION_GET_CHANNEL, (event) => {
  assertTrustedRenderer(event);
  event.returnValue = activeBackend?.snapshot() ?? null;
});

ipcMain.handle(BACKEND_CONNECTION_RETRY_CHANNEL, async (event) => {
  assertTrustedRenderer(event);
  if (!activeBackend) return false;
  await activeBackend.retry();
  return activeBackend.snapshot().status === "attached";
});

async function createWindow() {
  if (mainWindow && getLiveWebContents(mainWindow)) {
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

  // win/linux 的窗口与任务栏图标取运行时 png(mac 走 icns,不需要 BrowserWindow icon;
  // exe 内嵌图标被 signAndEditExecutable:false 跳过,任务栏观感靠这里)。
  const windowIcon =
    process.platform === "darwin"
      ? undefined
      : app.isPackaged
        ? path.join(process.resourcesPath, "icon.png")
        : path.join(__dirname, "../../resources/icon-256.png");

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 960,
    minHeight: 600,
    center: true,
    title: "青简",
    ...(windowIcon ? { icon: windowIcon } : {}),
    autoHideMenuBar: true,
    // 原生底色、启动壳与 Web boot 契约统一为暖纸色，整个导航链路不产生色阶跳变。
    backgroundColor: "#ece4d3",
    // Windows 11 把激活窗口的标题栏/边框涂成玄青(--desk-base),与写作页左栏一体;
    // Win10 及其他平台忽略此项,由上面 themeSource:"dark" 兜底保证深色标题栏。
    accentColor: "#16212c",
    show: false,
    webPreferences: {
      // preload 以 CommonJS .cjs 产出(见 build.mjs);ESM 的 .js preload 在 Electron 里
      // 加载不了,会导致 window.electron 缺失、文件夹连接退化成浏览器 FS 路径。
      preload: path.join(__dirname, "../preload/index.cjs"),
      // 壳与数据 origin 共用唯一专用、非持久 partition；不与其他窗口共享 cookie/cache。
      partition: "qingagent-main-window",
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 窗口失焦时保持完整帧率,动效不被降到 1fps(注意键名是 backgroundThrottling)。
      backgroundThrottling: false,
    },
  });
  const contentWindow = mainWindow;
  const contentWebContents = contentWindow.webContents;
  const contentWebContentsId = contentWebContents.id;
  let updaterStartTimer: ReturnType<typeof setTimeout> | null = null;
  const exportDownloadCoordinator = new ExportDownloadCoordinator({
    downloadsDirectory: app.getPath("downloads"),
  });
  mainExportDownloadCoordinator = exportDownloadCoordinator;
  const rememberGeneration = nativeRememberGrantGate.reset();
  const rememberScope = `desktop-window:${rememberGeneration}`;
  mainWindowRememberGeneration = rememberGeneration;
  mainWindowRememberScope = rememberScope;

  // 仅主应用窗口开放文本编辑右键菜单；可信确认模态窗和 PDF 离屏窗保持无右键交互面。
  contentWebContents.on("context-menu", (_event, params) => {
    if (getLiveWebContents(contentWindow) !== contentWebContents) return;
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

  // renderer 可用性跟随 WebContents 自身；destroyed 回调只使用预先缓存的纯数字 id，
  // 绝不在 BrowserWindow.closed 后重新读取 window.webContents。
  contentWebContents.once("destroyed", () => {
    rendererDialogBroker.markUnavailable(contentWebContentsId);
  });
  contentWindow.once("closed", () => {
    if (updaterStartTimer) {
      clearTimeout(updaterStartTimer);
      updaterStartTimer = null;
    }
    exportDownloadCoordinator.dispose();
    if (mainExportDownloadCoordinator === exportDownloadCoordinator) {
      mainExportDownloadCoordinator = null;
    }
    trustedRememberUiGate.clear();
    nativeRememberGrantGate.cancel(rememberGeneration);
    if (isEmbeddedBackendActive()) {
      void import("@qingagent/server/confirmUiGrant")
        .then(({ clearConfirmUiGrantsForScope }) => {
          clearConfirmUiGrantsForScope(rememberScope);
        })
        .catch(() => undefined);
    }
    if (mainWindow === contentWindow) {
      mainWindow = null;
      mainWindowRememberScope = null;
    }
  });
  contentWindow.on("close", (event) => {
    if (process.platform !== "darwin") {
      quitCoordinator.handleWindowClose(event);
    }
  });

  contentWebContents.on("before-input-event", (_event, input) => {
    trustedRememberUiGate.record(contentWebContentsId, input.type);
  });
  contentWebContents.on("before-mouse-event", (_event, input) => {
    trustedRememberUiGate.record(contentWebContentsId, input.type);
  });

  attachRendererDiagnostics(contentWebContents, desktopLogDir);
  const processMonitor = attachMainWindowProcessMonitor(contentWebContents, {
    isQuitting: () => quitCoordinator.isQuitting(),
    showRecoveryStopped: () => showNativeRendererRecoveryStopped(contentWindow),
  });
  mainWindowProcessMonitor = processMonitor;
  contentWindow.once("closed", () => {
    if (mainWindowProcessMonitor === processMonitor) {
      mainWindowProcessMonitor = null;
    }
  });

  contentWebContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        rendererDialogBroker.markUnavailable(contentWebContentsId);
      }
    },
  );
  contentWebContents.on("render-process-gone", () => {
    rendererDialogBroker.markUnavailable(contentWebContentsId);
  });

  // 外部链接走系统默认浏览器，不允许启动壳或内容页把主窗口导航到应用 origin 之外。
  // 监听器必须早于 data: 启动壳加载挂载，避免壳阶段的 http(s) 导航逃逸。
  contentWebContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  // 整页导航与服务端重定向：显式放行内置服务、开发服务器和当前同源；file:、about:、
  // 跨源及畸形 URL 都不能接管主窗口。用户主动点出的外部 Web 链接交给系统浏览器。
  const guardMainFrameNavigation = (event: MainFrameNavigationEvent, url: string): void => {
    if (contentWebContents.isDestroyed()) {
      event.preventDefault();
      return;
    }
    if (
      !isAllowedMainFrameNavigation(
        url,
        contentWebContents.getURL(),
        isDev ? devContentUrl : undefined,
        allowedAppOrigins,
      )
    ) {
      event.preventDefault();
    }
  };
  contentWebContents.on("will-navigate", (event, url) => {
    if (contentWebContents.isDestroyed()) {
      event.preventDefault();
      return;
    }
    handleMainWindowWillNavigate(
      event,
      url,
      contentWebContents.getURL(),
      isDev ? devContentUrl : undefined,
      allowedAppOrigins,
      (targetUrl) => shell.openExternal(targetUrl),
    );
  });
  contentWebContents.on("will-redirect", guardMainFrameNavigation);

  // 启动壳不依赖服务端和外部资源；必须先完成发现与模式决策，
  // 只有 embedded 结果才允许初始化 server/core/DB。
  const startupShellReady = contentWindow.loadURL(STARTUP_SHELL_URL).catch((error) => {
    console.warn("[startup] 启动壳加载失败:", error);
  });
  contentWindow.show();
  await startupShellReady;
  if (getLiveWebContents(contentWindow) !== contentWebContents) return;

  let backend: BackendConnection;
  try {
    backend = activeBackend ?? await resolveStartupBackend(contentWebContents);
    installActiveBackend(backend);
    await installRendererProtocols(
      contentWebContents,
      backend,
      isDev,
      isDev ? new URL(devContentUrl).origin : DESKTOP_APP_ORIGIN,
    );
    if (!isDev) allowedAppOrigins.add(DESKTOP_APP_ORIGIN);
    if (backend.mode === "embedded") {
      const runtime = await initializeEmbeddedRuntime();
      runtime.installNetProbe();
      // 桌面端没有 env key，这里仅预热默认官方 endpoint。
      runtime.warmUpModelEndpoint(runtime.resolveBaseUrl());
      await maybeSeedInitialContent();
      if (backend instanceof EmbeddedBackendConnection) startEmbeddedRediscovery(backend);
    }
    desktopClientConfigReady = true;
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = getLiveWebContents(window);
      if (contents) contents.send("qingagent:client-config-ready");
    }
  } catch (error) {
    const runtime = embeddedRuntimeReady ? await embeddedRuntimeReady.catch(() => null) : null;
    if (!runtime?.isReportedServerStartupError(error)) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[startup] 后台连接初始化失败:", detail);
      dialog.showErrorBox(
        "后台连接失败",
        "青简暂时无法启动，应用将退出。请重新打开应用；若仍失败，请查看应用日志或联系支持。",
      );
    }
    app.exit(1);
    return;
  }
  // 启动壳已完成，遥测从此处挂载，确保首个 did-finish-load 对应真正内容页。
  attachRendererTelemetry(contentWindow, telemetry.getRendererBootstrap());

  const startUpdaterAfterContentLoad = (): void => {
    if (getLiveWebContents(contentWindow) !== contentWebContents) return;
    // 恢复过程会重新展示启动壳，不能让壳页的完成事件抢走 updater 的一次性启动机会。
    if (contentWebContents.getURL() === STARTUP_SHELL_URL) return;
    contentWebContents.off("did-finish-load", startUpdaterAfterContentLoad);
    if (!backend.snapshot().effectiveCapabilities.updates) return;
    updaterStartTimer = setTimeout(() => {
      updaterStartTimer = null;
      if (getLiveWebContents(contentWindow) !== contentWebContents) return;
      void startDesktopUpdater({ window: contentWindow }).catch((error) => {
        console.warn("[update] 启动检查未完成:", error);
      });
    }, 250);
  };
  contentWebContents.on("did-finish-load", startUpdaterAfterContentLoad);

  const baseContentUrl = isDev
    // 多 worktree 各自端口不同,用 QINGAGENT_DESKTOP_DEV_URL 覆盖;默认主 worktree 的 6173。
    ? devContentUrl
    // 打包态由固定可信 origin 转发到内置 Hono，Web Storage 不再受随机监听端口影响。
    : DESKTOP_APP_URL;

  let desiredContentUrl = baseContentUrl;
  let contentLoadGeneration = 0;
  let contentRecoveryActive = false;
  let recoveryReloadRequested = false;
  const recoverContentLoad = async (reason: unknown): Promise<void> => {
    if (
      contentRecoveryActive ||
      getLiveWebContents(contentWindow) !== contentWebContents
    ) return;
    contentRecoveryActive = true;
    console.error("[startup] 内容页加载失败，开始恢复:", reason);
    try {
      while (getLiveWebContents(contentWindow) === contentWebContents) {
        // 覆盖 Chromium 错误页，恢复期间持续显示与启动阶段一致的暖纸壳。
        await contentWindow.loadURL(STARTUP_SHELL_URL).catch((error) => {
          console.warn("[startup] 恢复启动壳加载失败:", error);
        });

        let completedRetries = 0;
        while (getLiveWebContents(contentWindow) === contentWebContents) {
          const step = nextContentLoadRecoveryStep(completedRetries);
          if (step.kind === "prompt") break;

          await waitForContentLoadRetry(step.delayMs);
          if (getLiveWebContents(contentWindow) !== contentWebContents) return;
          completedRetries = step.attempt;

          if (!(await backend.probe())) {
            console.warn(`[startup] 内容页第 ${step.attempt} 次恢复前健康探测失败`);
            continue;
          }

          try {
            recoveryReloadRequested = false;
            const attemptedUrl = desiredContentUrl;
            await contentWindow.loadURL(desiredContentUrl);
            // 恢复导航进行中又收到更新的深链时，旧页面即使加载成功也不是最终目标；
            // 不显示失败壳，直接重新进入自动恢复并加载 latest-wins 目标。
            if (recoveryReloadRequested || attemptedUrl !== desiredContentUrl) continue;
            return;
          } catch (error) {
            console.error(`[startup] 内容页第 ${step.attempt} 次恢复失败:`, error);
          }
        }

        if (getLiveWebContents(contentWindow) !== contentWebContents) return;
        if (recoveryReloadRequested) continue;
        // 最后一次失败会让 Chromium 错误页接管主 frame；询问前必须重新挂回自绘启动壳，
        // 否则 renderer 能力已随导航失效，正常的内容恢复也会误降级成系统弹框。
        await contentWindow.loadURL(STARTUP_SHELL_URL).catch((error) => {
          console.warn("[startup] 恢复询问壳加载失败:", error);
        });
        if (getLiveWebContents(contentWindow) !== contentWebContents) return;
        let response = await rendererDialogBroker.request(
          contentWebContents,
          "content-load-failed",
        );
        if (getLiveWebContents(contentWindow) !== contentWebContents) return;
        if (response === null) {
          response = await showNativeContentRecoveryFallback(contentWindow);
        }
        if (response === "cancel") {
          app.exit(1);
          return;
        }
        // 用户选择重试后重新展示启动壳，并获得完整的三次恢复机会。
      }
    } finally {
      contentRecoveryActive = false;
    }
  };

  const loadDesiredContent = (): void => {
    const generation = ++contentLoadGeneration;
    const targetUrl = desiredContentUrl;
    void contentWindow.loadURL(targetUrl).catch((error) => {
      // 新深链替换旧导航时 Chromium 会 reject 被中止的 loadURL；旧 promise 不得反过来
      // 把最新页面拉进恢复壳。did-fail-load 的 ERR_ABORTED 过滤与这里的 generation 成对。
      if (generation !== contentLoadGeneration) return;
      console.error("[startup] 内容页加载失败:", error);
      void recoverContentLoad(error);
    });
  };

  contentWebContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === CHROMIUM_ERR_ABORTED) return;
      void recoverContentLoad({ errorCode, errorDescription, validatedURL });
    },
  );

  const navigateToDesktopDeepLink = (deepLinkUrl: string): void => {
    desiredContentUrl = resolveDesktopContentUrl(baseContentUrl, deepLinkUrl);
    if (contentRecoveryActive) {
      recoveryReloadRequested = true;
      return;
    }
    loadDesiredContent();
  };

  const deliverQingjianDeepLink: QingjianDeepLinkHandler = (intent): void => {
    if (getLiveWebContents(contentWindow) !== contentWebContents) return;
    focusAndShowWindow(contentWindow);
    void resolveQingjianDeepLink(backend, intent.engineSessionId).then((result) => {
      if (getLiveWebContents(contentWindow) !== contentWebContents) return;
      contentWebContents.send(QINGJIAN_OPEN_SESSION_CHANNEL, {
        ...intent,
        result: result.result,
      });
    });
  };
  const bindQingjianDeepLinkHandler = (): void => {
    if (
      getLiveWebContents(contentWindow) !== contentWebContents
      || contentWebContents.getURL() === STARTUP_SHELL_URL
    ) return;
    qingjianDeepLinks.setHandler(deliverQingjianDeepLink);
  };
  contentWebContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      qingjianDeepLinks.clearHandler(deliverQingjianDeepLink);
    }
  });
  contentWebContents.on("did-finish-load", bindQingjianDeepLinkHandler);
  // 绑定点刻意晚于模式决策、attach 握手与双 origin 协议安装：
  // 冷启动 URL、macOS open-url、second-instance 在此之前都只排队。
  const loadedQueuedDeepLink = desktopDeepLinks.setNavigator(navigateToDesktopDeepLink);
  contentWindow.once("closed", () => {
    desktopDeepLinks.clearNavigator(navigateToDesktopDeepLink);
    qingjianDeepLinks.clearHandler(deliverQingjianDeepLink);
  });
  if (!loadedQueuedDeepLink) loadDesiredContent();
  if (isDev || process.env.QINGAGENT_DEVTOOLS === "1") {
    if (!contentWebContents.isDestroyed()) {
      contentWebContents.openDevTools({ mode: "detach" });
    }
  }
}

// 首启示例内容(分叉骨架):桌面端「一辈子只 seed 一次」。
// once 门 = userData 下的版本化标记文件;seed 写入本身在 @qingagent/core 里(进程内、幂等)。
// 失败只记日志、绝不阻塞开窗。v2 让已有 v1 标记的老用户也补跑一次真实会话 fixture。
async function maybeSeedInitialContent() {
  const flagFile = path.join(app.getPath("userData"), ".qingagent-seeded-v2");
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
  await telemetry.init();
  // 仅在埋点启用时才接管进程错误事件:禁用(无 key,默认态)时不改变 Node/Electron 的崩溃行为。
  if (telemetry.enabled) installTelemetryProcessErrorHandlers();
  await createWindow();
});

const quitCoordinator = createDesktopQuitCoordinator({
  hasActiveGeneration: async () => {
    if (!isEmbeddedBackendActive()) return false;
    try {
      const { hasActiveDesktopGeneration } = await import(
        "@qingagent/server/desktopShutdown"
      );
      return await hasActiveDesktopGeneration();
    } catch (error) {
      console.warn("[desktop] 退出前读取生成状态失败，按生成中保护", {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  },
  confirmQuitDuringGeneration: async () => {
    const candidate = mainWindow;
    const ownerContents = getLiveWebContents(candidate);
    const owner = candidate && ownerContents ? candidate : null;
    let response: DesktopDialogResult | null = null;
    if (owner && ownerContents) {
      if (owner.isMinimized()) owner.restore();
      owner.show();
      owner.focus();
      response = await rendererDialogBroker.request(
        ownerContents,
        "quit-during-generation",
      );
    }
    if (response === null) {
      response = await showNativeQuitFallback(owner);
    }
    return response === "confirm";
  },
  telemetryEnabled: () => telemetry.enabled,
  captureAppClosed: () => telemetry.captureAppClosed(Date.now() - appStartedAt),
  shutdownTelemetry: () => telemetry.shutdown(2000),
  drainServer: async (deadlineAtMs) => {
    if (!isEmbeddedBackendActive()) return;
    const { drainDesktopSessionsForShutdown } = await import(
      "@qingagent/server/desktopShutdown"
    );
    await drainDesktopSessionsForShutdown({
      recoveryMarkerPath: shutdownRecoveryMarkerPath,
      deadlineAtMs,
    });
  },
  stopExternalInstance: async () => {
    if (!isEmbeddedBackendActive()) return;
    const { stopExternalInstance } = await import(
      "@qingagent/server/externalInstance"
    );
    await stopExternalInstance();
  },
  quit: () => {
    if (embeddedRediscoveryTimer) clearInterval(embeddedRediscoveryTimer);
    embeddedRediscoveryTimer = null;
    app.quit();
  },
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
