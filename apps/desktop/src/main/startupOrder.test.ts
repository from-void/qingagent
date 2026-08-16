import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false;
}

function resolveRelativeModule(importer: string, specifier: string): string {
  const base = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(base);
  const candidates = [
    base,
    ...(extension === ".js" ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
    ...(extension === ".mjs" ? [`${base.slice(0, -4)}.mts`] : []),
    ...(extension === ".cjs" ? [`${base.slice(0, -4)}.cts`] : []),
    ...(!extension ? [
      `${base}.ts`, `${base}.tsx`, `${base}.js`,
      path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js"),
    ] : []),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `无法解析 ${path.relative(__dirname, importer)} -> ${specifier}`);
  return resolved;
}

function inspectRuntimeImportGraph(entry: string): {
  visited: Set<string>;
  forbidden: Array<{ importer: string; specifier: string }>;
} {
  const visited = new Set<string>();
  const forbidden: Array<{ importer: string; specifier: string }> = [];
  const visit = (filePath: string): void => {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    const source = ts.createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      let specifier: string | null = null;
      let hasRuntimeValue = false;
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text;
        hasRuntimeValue = importClauseHasRuntimeValue(statement.importClause);
      } else if (
        ts.isExportDeclaration(statement)
        && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
        hasRuntimeValue = !statement.isTypeOnly
          && (!statement.exportClause
            || ts.isNamespaceExport(statement.exportClause)
            || statement.exportClause.elements.some((element) => !element.isTypeOnly));
      }
      if (!specifier || !hasRuntimeValue) continue;
      if (specifier.startsWith(".")) {
        visit(resolveRelativeModule(filePath, specifier));
      } else if (/^@qingagent\/(?:server|core|db)(?:\/|$)/.test(specifier)) {
        forbidden.push({ importer: filePath, specifier });
      }
    }
  };
  visit(entry);
  return { visited, forbidden };
}

test("desktop 先完成发现/模式决策，只在 embedded 分支初始化 server/core/DB", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const resolver = source.slice(
    source.indexOf("async function resolveStartupBackend"),
    source.indexOf("let detachBackendSnapshotListener"),
  );
  const discovery = resolver.indexOf("await runAttachDiscovery()");
  const decision = resolver.indexOf("decideAttachMode(report, boundLibraryId)");
  const embedded = resolver.indexOf('decision.kind === "embedded"');
  const lease = resolver.indexOf("acquireStartingLease", embedded);
  const runtime = resolver.indexOf("initializeEmbeddedRuntime()", lease);
  const server = resolver.indexOf("runtime.startServer({", runtime);

  assert.ok(0 <= discovery && discovery < decision && decision < embedded);
  assert.ok(embedded < lease && lease < runtime && runtime < server);
  const moduleGraph = inspectRuntimeImportGraph(path.join(__dirname, "index.ts"));
  assert.ok(moduleGraph.visited.size >= 40, "门禁必须遍历 index.ts 的真实相对 runtime import 闭包");
  assert.deepEqual(moduleGraph.forbidden, [], "attach 可达模块禁止顶层求值 server/core/DB");
  assert.match(resolver, /connectSelectedAttach\(decision\.instance\)/);
});

test("desktop 暖纸启动壳常显，模式/协议就绪后才同窗导航内容页", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const browserWindowLine = source.indexOf("mainWindow = new BrowserWindow(");
  const shellLoadLine = source.indexOf("contentWindow.loadURL(STARTUP_SHELL_URL)", browserWindowLine);
  const shellShowLine = source.indexOf("contentWindow.show();", shellLoadLine);
  const shellReadyLine = source.indexOf("await startupShellReady;", shellShowLine);
  const backendLine = source.indexOf("await resolveStartupBackend(contentWebContents)", shellReadyLine);
  const protocolLine = source.indexOf("await installRendererProtocols", backendLine);
  const seedLine = source.indexOf("await maybeSeedInitialContent();", protocolLine);
  const telemetryLine = source.indexOf("attachRendererTelemetry(contentWindow", protocolLine);
  const finishLoadLine = source.indexOf('contentWebContents.on("did-finish-load"', telemetryLine);
  const contentLoadLine = source.indexOf("desktopDeepLinks.setNavigator", finishLoadLine);
  const createWindowSource = source.slice(source.indexOf("async function createWindow()"), source.indexOf("// 首启示例内容"));

  assert.ok(browserWindowLine >= 0, "未创建主窗口");
  assert.ok(
    browserWindowLine < shellLoadLine && shellLoadLine < shellShowLine && shellShowLine < shellReadyLine,
    "主窗口必须先加载并显示启动壳",
  );
  assert.ok(
    shellReadyLine < backendLine && backendLine < protocolLine && protocolLine < contentLoadLine,
    "内容页导航必须晚于最终 BackendConnection 与双 origin 协议就绪",
  );
  assert.ok(
    protocolLine < seedLine && seedLine < telemetryLine && telemetryLine < contentLoadLine,
    "embedded seed 与 renderer telemetry 必须跳过启动壳",
  );
  assert.ok(
    telemetryLine < finishLoadLine && finishLoadLine < contentLoadLine,
    "内容页 did-finish-load 必须继续覆盖 updater 启动",
  );
  assert.doesNotMatch(createWindowSource, /contentWindow\.hide\(\)|ready-to-show|revealContent/);
  assert.equal(createWindowSource.match(/contentWindow\.show\(\)/g)?.length, 1, "窗口只能在启动壳阶段 show 一次");
  assert.match(source.slice(browserWindowLine, shellLoadLine), /backgroundColor:\s*"#ece4d3"/);
  assert.match(readStartupShellHtml(source), /background:\s*#ece4d3/);
  assert.match(readStartupShellHtml(source), /color:\s*#2f2a22/);
  assert.doesNotMatch(readStartupShellHtml(source), /https?:\/\//i, "启动壳不得引用外部资源");
});

test("启动决策自动重试有界退避，超限后进入阻断 UI", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const helper = source.slice(
    source.indexOf("const STARTUP_AUTO_RETRY_DELAYS_MS"),
    source.indexOf("async function connectSelectedAttach"),
  );
  const resolver = source.slice(
    source.indexOf("async function resolveStartupBackend"),
    source.indexOf("let detachBackendSnapshotListener"),
  );
  assert.match(helper, /STARTUP_AUTO_RETRY_DELAYS_MS = \[100, 250, 500\]/);
  assert.match(helper, /await new Promise<void>\(\(resolve\) => setTimeout\(resolve, delayMs\)\)/);
  assert.match(helper, /requestBackendStartupAction\([\s\S]*kind: "blocked"/);
  assert.match(helper, /errorCodes: \[errorCode\]/);
  assert.equal(
    resolver.match(/handleAutomaticStartupFailure\(/g)?.length,
    3,
    "租约失败、竞态握手失败、attach 消失三条自动 continue 都必须受同一预算约束",
  );
});

test("data origin 可执行装载黑名单覆盖 object 与 media", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const filterSource = source.slice(
    source.indexOf("const dataResourceFilter"),
    source.indexOf("const BOUND_LIBRARY_CONFIG_KEY"),
  );
  for (const resourceType of [
    "mainFrame", "subFrame", "script", "stylesheet", "worker", "sharedWorker", "object", "media",
  ]) {
    assert.match(filterSource, new RegExp(`"${resourceType}"`), resourceType);
  }
});

test("首启真实会话使用 v2 once 门，失败时不落标记以便下次重试", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const seedStart = source.indexOf("async function maybeSeedInitialContent() {");
  const seedEnd = source.indexOf("// macOS GPU/渲染实验性开关", seedStart);
  const seedSource = source.slice(seedStart, seedEnd);

  assert.match(seedSource, /\.qingagent-seeded-v2/);
  assert.doesNotMatch(seedSource, /\.qingagent-seeded-v1/);
  assert.ok(
    seedSource.indexOf("await seedInitialContent()") < seedSource.indexOf("writeFileSync(flagFile"),
    "只有 seed 成功后才能写 v2 标记",
  );
  assert.match(seedSource, /catch \(err\)/, "seed 失败必须被捕获，不能阻塞开窗");
});

test("Crashpad 只在 embedded 争锁成功后启用，attach 分支不创建 dump", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const mkdirLine = source.indexOf("mkdirSync(crashDumpsDir, { recursive: true })");
  const setPathLine = source.indexOf('app.setPath("crashDumps", crashDumpsDir)');
  const startLine = source.indexOf("crashReporter.start({");
  const crashReporterSource = source.slice(
    source.indexOf("function startEmbeddedCrashReporter"),
    source.indexOf('app.on("child-process-gone"'),
  );
  const resolver = source.slice(
    source.indexOf("async function resolveStartupBackend"),
    source.indexOf("let detachBackendSnapshotListener"),
  );
  const leaseAcquired = resolver.indexOf('claim.kind === "existing"');
  const startCall = resolver.indexOf("startEmbeddedCrashReporter()", leaseAcquired);
  const runtimeCall = resolver.indexOf("initializeEmbeddedRuntime()", startCall);

  assert.ok(
    mkdirLine >= 0 && mkdirLine < setPathLine && setPathLine < startLine,
    "Crashpad 目录必须先创建，再覆盖 crashDumps 并启动 reporter",
  );
  assert.match(crashReporterSource, /uploadToServer:\s*false/);
  assert.ok(leaseAcquired >= 0 && leaseAcquired < startCall && startCall < runtimeCall);
  assert.equal(source.match(/startEmbeddedCrashReporter\(\)/g)?.length, 2);
  assert.match(source, /app\.on\("child-process-gone"/);
});

test("硬件加速配置在 app ready 前读取并应用", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const preferenceLine = source.indexOf("resolveHardwareAccelerationMode({");
  const disableLine = source.indexOf("app.disableHardwareAcceleration()", preferenceLine);
  const logLine = source.indexOf("logRenderingMode(renderingMode)", disableLine);
  const readyLine = source.indexOf("app.whenReady().then(async () => {");

  assert.ok(preferenceLine >= 0, "启动期必须解析硬件加速配置");
  assert.ok(
    preferenceLine < disableLine && disableLine < logLine && logLine < readyLine,
    "硬件加速配置必须在 app ready 前应用并记录渲染模式",
  );
});

test("冷启动与二次实例深链均排队到 BackendConnection/protocol 就绪后", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const backendReadyLine = source.indexOf("await resolveStartupBackend(contentWebContents)");
  const protocolReadyLine = source.indexOf("await installRendererProtocols", backendReadyLine);
  const navigatorReadyLine = source.indexOf("desktopDeepLinks.setNavigator", protocolReadyLine);
  const initialLoadLine = source.indexOf("loadDesiredContent()", navigatorReadyLine);
  const recoveryStart = source.indexOf("const recoverContentLoad = async");
  const recoveryEnd = source.indexOf('contentWebContents.on(\n    "did-fail-load"', recoveryStart);
  const recoverySource = source.slice(recoveryStart, recoveryEnd);

  assert.match(source, /new DesktopAppDeepLinkDispatcher\(process\.argv\)/);
  assert.match(source, /offerCommandLine\(commandLine\)/, "second-instance 必须转交完整启动参数");
  assert.match(source, /app\.on\("open-url", \(event, url\) =>/);
  assert.ok(
    backendReadyLine >= 0
      && protocolReadyLine > backendReadyLine
      && navigatorReadyLine > protocolReadyLine
      && initialLoadLine > navigatorReadyLine,
    "深链导航器与首次内容加载必须晚于最终后台及协议 handler 就绪",
  );
  assert.match(source, /resolveQingjianDeepLink\(backend, intent\.engineSessionId\)/);
  assert.match(recoverySource, /contentWindow\.loadURL\(desiredContentUrl\)/);
  assert.doesNotMatch(recoverySource, /contentWindow\.loadURL\(contentUrl\)/);
});

test("内容页主 frame 加载失败注册恢复流程并过滤子 frame 与 ERR_ABORTED", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const recoveryLine = source.indexOf("const recoverContentLoad = async");
  const rejectionLine = source.indexOf("const loadDesiredContent = (): void =>", recoveryLine);
  const failLoadLine = source.indexOf('contentWebContents.on(\n    "did-fail-load"', recoveryLine);
  const contentLoadLine = source.indexOf("desktopDeepLinks.setNavigator", failLoadLine);
  const recoverySource = source.slice(recoveryLine, rejectionLine);
  const rejectionSource = source.slice(rejectionLine, failLoadLine);
  const failLoadSource = source.slice(failLoadLine, contentLoadLine);

  assert.ok(recoveryLine >= 0, "必须定义内容页恢复流程");
  assert.ok(failLoadLine > recoveryLine && failLoadLine < contentLoadLine, "did-fail-load 必须在首次内容页导航前注册");
  assert.match(failLoadSource, /!isMainFrame \|\| errorCode === CHROMIUM_ERR_ABORTED/);
  assert.match(failLoadSource, /recoverContentLoad\(\{ errorCode, errorDescription, validatedURL \}\)/);
  assert.match(recoverySource, /await backend\.probe\(\)/);
  assert.match(recoverySource, /contentWindow\.loadURL\(STARTUP_SHELL_URL\)/);
  assert.match(recoverySource, /rendererDialogBroker\.request\([\s\S]*"content-load-failed"/);
  assert.match(recoverySource, /showNativeContentRecoveryFallback\(contentWindow\)/);
  assert.doesNotMatch(recoverySource, /dialog\.showMessageBox/);
  const finalPromptIndex = recoverySource.indexOf("rendererDialogBroker.request");
  const finalShellIndex = recoverySource.lastIndexOf(
    "contentWindow.loadURL(STARTUP_SHELL_URL)",
    finalPromptIndex,
  );
  assert.ok(finalShellIndex >= 0 && finalShellIndex < finalPromptIndex);
  const startupShell = readStartupShellHtml(source);
  assert.match(startupShell, /class="ws-folder-confirm-modal"/);
  assert.match(startupShell, />重试<\/button>/);
  assert.match(startupShell, />退出<\/button>/);
  assert.match(startupShell, /markDesktopDialogReady\(\["content-load-failed"\]\)/);
  assert.match(recoverySource, /app\.exit\(1\)/);
  assert.match(rejectionSource, /generation !== contentLoadGeneration/, "被新深链中止的旧导航不得误触发恢复");
  assert.match(rejectionSource, /recoverContentLoad\(error\)/, "loadURL rejection 也必须进入同一恢复流程");
});

test("data 启动壳加载前即挂载目标 origin 白名单外链守卫", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const guardLine = source.indexOf('contentWebContents.on("will-navigate"');
  const shellLoadLine = source.indexOf("contentWindow.loadURL(STARTUP_SHELL_URL)");
  const guardSource = source.slice(guardLine, shellLoadLine);

  assert.ok(guardLine >= 0 && guardLine < shellLoadLine, "will-navigate 必须在 data: 启动壳加载前挂载");
  assert.match(guardSource, /handleMainWindowWillNavigate\(/);
  assert.match(guardSource, /allowedAppOrigins,/);
  assert.match(guardSource, /shell\.openExternal\(targetUrl\)/);
  assert.doesNotMatch(guardSource, /currentIsWeb|current\.protocol/);
  assert.match(source, /allowedAppOrigins\.add\(DESKTOP_APP_ORIGIN\)/);
  assert.doesNotMatch(source, /addAllowedOrigin\(allowedAppOrigins, `http:\/\/(?:localhost|127\.0\.0\.1):\$\{port\}`\)/);
});

test("后台初始化失败会弹框并退出，不会停在启动壳", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const awaitLine = source.indexOf("backend = activeBackend ?? await resolveStartupBackend");
  const catchLine = source.indexOf("} catch (error) {", awaitLine);
  const exitLine = source.indexOf("app.exit(1);", catchLine);
  const catchSource = source.slice(catchLine, source.indexOf("attachRendererTelemetry", catchLine));

  assert.ok(awaitLine >= 0 && catchLine > awaitLine && exitLine > catchLine, "BackendConnection reject 必须被收口");
  assert.match(catchSource, /runtime\?\.isReportedServerStartupError\(error\)/);
  assert.match(catchSource, /dialog\.showErrorBox\(/);
  assert.match(catchSource, /"后台连接失败"/);
  assert.match(catchSource, /app\.exit\(1\)/);

  const serverSource = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.match(serverSource, /throw markServerStartupErrorReported\(err\)/, "迁移失败需标记为已报错，避免重复弹框");
});

test("createWindow 复用现有窗口并复用最终 BackendConnection", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const wrapperStart = source.indexOf("async function createWindow() {");
  const workerStart = source.indexOf("async function createWindowOnce()", wrapperStart);
  const wrapperSource = source.slice(wrapperStart, workerStart);

  assert.match(wrapperSource, /mainWindow && getLiveWebContents\(mainWindow\)/);
  assert.match(wrapperSource, /if \(windowStartupInProgress\) return/);
  assert.match(wrapperSource, /windowStartupInProgress = true/);
  assert.match(wrapperSource, /finally \{\s*windowStartupInProgress = false/s);
  assert.match(source, /activeBackend \?\? await resolveStartupBackend/);
  assert.match(source, /embeddedServerReady \?\?= runtime\.startServer\(/, "embedded 重开窗口必须复用同一 server promise");
});

test("desktop 仅在 embedded 决策后、server/core 求值前装配凭据 provider", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const runtimeSource = source.slice(
    source.indexOf("async function initializeEmbeddedRuntimeOnce"),
    source.indexOf("let appOpenedCaptured"),
  );
  const envLine = runtimeSource.indexOf("configureDesktopRuntimeEnv");
  const providerLine = runtimeSource.indexOf("await configureDesktopCredentialKeyProvider(");
  const serverImportLine = runtimeSource.indexOf('await import("./server.js")');
  assert.ok(envLine >= 0 && envLine < providerLine && providerLine < serverImportLine);
  const readySource = source.slice(
    source.indexOf("app.whenReady().then(async () => {"),
    source.indexOf("const quitCoordinator"),
  );
  assert.doesNotMatch(readySource, /configureDesktopCredentialKeyProvider|pdfRenderer|@qingagent\/(?:server|core|db)/);
});

test("attach/第二实例不提前注入浏览器写入路径", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const storagePathLine = source.indexOf("process.env.QINGAGENT_BROWSER_STORAGE_STATE = path.join(");
  const profilePathLine = source.indexOf("process.env.QINGAGENT_BROWSER_PROFILE_DIR = path.join(");
  const runtimeStart = source.indexOf("async function initializeEmbeddedRuntimeOnce");
  const runtimeEnd = source.indexOf("let appOpenedCaptured", runtimeStart);

  assert.ok(storagePathLine >= 0 && profilePathLine >= 0, "必须注入两类浏览器凭据的新写入位置");
  assert.ok(
    runtimeStart < storagePathLine && storagePathLine < runtimeEnd
      && runtimeStart < profilePathLine && profilePathLine < runtimeEnd,
    "浏览器凭据路径只能在 embedded runtime 内注入",
  );
  assert.match(source.slice(storagePathLine, runtimeEnd), /userDataDir/);
  assert.doesNotMatch(source.slice(runtimeStart, runtimeEnd), /process\.cwd\(\)/);
});

test("QINGAGENT_DEVTOOLS=1 在打包态也以独立窗口打开主窗口 DevTools", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  assert.match(source, /isDev \|\| process\.env\.QINGAGENT_DEVTOOLS === "1"/);
  assert.match(source, /contentWebContents\.openDevTools\(\{ mode: "detach" \}\)/);
});

test("desktop PDF 导出使用私有临时目录、随机文件名和最小文件权限并整目录清理", () => {
  const source = readFileSync(path.join(__dirname, "pdfRenderer.ts"), "utf8");
  const mainSource = readFileSync(path.join(__dirname, "index.ts"), "utf8");

  assert.match(source, /mkdtempSync\(path\.join\(app\.getPath\("temp"\), "qingagent-export-"\)\)/);
  assert.match(source, /chmodSync\(tmpDir, 0o700\)/);
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /flag: "wx"/);
  assert.match(source, /rmSync\(tmpDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /qingagent-export-\$\{process\.pid\}/);
  assert.match(source, /EXPORT_ORPHAN_MAX_AGE_MS = 60 \* 60 \* 1000/);
  assert.match(source, /entry\.isDirectory\(\).*entry\.name\.startsWith\(EXPORT_TEMP_PREFIX\)/);
  assert.match(source, /stat\.mtimeMs > cutoffMs/);
  assert.match(source, /withExportSlot\(async \(\{ signal \}\) =>/);
  assert.match(source, /session:\s*exportSession\(tmpDir\)/);
  assert.match(source, /signal\.addEventListener\("abort", destroyOnAbort/);
  assert.match(source, /const destroyOnAbort = \(\) => destroyWindowIfAlive\(win\)/);
  assert.match(source, /finally \{[\s\S]{0,180}?destroyWindowIfAlive\(win\)/);
  assert.doesNotMatch(source, /win\?\.destroy\(\)/);
  assert.match(mainSource, /cleanupOrphanedPdfExportDirs\(\)/);
});

test("desktop 延迟窗口操作在执行前复查生命周期，关窗时取消 updater 定时器", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const timerStart = source.indexOf("updaterStartTimer = setTimeout(");
  const timerSource = source.slice(timerStart, source.indexOf("}, 250);", timerStart) + 8);
  const closedStart = source.indexOf('contentWindow.once("closed"');
  const closedSource = source.slice(closedStart, source.indexOf('contentWindow.on("close"', closedStart));

  assert.ok(timerStart >= 0, "缺少 updater 延迟启动定时器");
  assert.match(timerSource, /getLiveWebContents\(contentWindow\) !== contentWebContents/);
  assert.match(closedSource, /clearTimeout\(updaterStartTimer\)/);
  assert.doesNotMatch(closedSource, /contentWindow\.webContents|contentWebContents\./);
});

test("desktop 模型 key 由 safeStorage 加密，迁移先写密文再清明文且不可用时 fail-closed", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const secretStoreSource = readFileSync(path.join(__dirname, "clientSecretStore.ts"), "utf8");
  const persistenceSource = readFileSync(path.join(__dirname, "clientConfigPersistence.ts"), "utf8");

  for (const key of [
    "qingagent.deepseek_api_key",
    "qingagent.custom_provider",
    "qingagent.vision_provider",
  ]) {
    assert.ok(source.includes(`"${key}"`), `缺少桌面模型敏感配置项：${key}`);
  }
  assert.match(secretStoreSource, /options\.safeStorage\.encryptString\(value\)/);
  assert.match(
    secretStoreSource,
    /options\.safeStorage\.decryptString\(Buffer\.from\(ciphertext, "base64"\)\)/,
  );
  assert.match(source, /getSelectedStorageBackend\(\) !== "basic_text"/);

  const migrationStart = source.indexOf("function migratePlaintextClientSecrets()");
  const encryptedWrite = source.indexOf("desktopClientSecretStore.writeMany(plaintextEntries);", migrationStart);
  const plaintextClear = source.indexOf("writeClientConfig(sanitized);", migrationStart);
  assert.ok(encryptedWrite > migrationStart && plaintextClear > encryptedWrite, "迁移必须先落密文再清明文");

  const rendererReadStart = source.indexOf("function readClientConfigValueForRenderer(");
  const unavailableReturn = source.indexOf(
    "if (!isDesktopModelEncryptionAvailable()) return { ok: false };",
    rendererReadStart,
  );
  const singleSecretRead = source.indexOf("desktopClientSecretStore.read(key)", rendererReadStart);
  assert.ok(
    unavailableReturn > rendererReadStart && singleSecretRead > unavailableReturn,
    "加密不可用时必须 fail-closed，且 renderer 只能按单项 key 解密",
  );
  assert.doesNotMatch(
    source.slice(rendererReadStart, source.indexOf("function writeClientConfigValue", rendererReadStart)),
    /return cfg/,
    "不得向 renderer 返回整份配置",
  );
  assert.match(persistenceSource, /isSecret && options\.nextValue !== null && !options\.encryptionAvailable/);
  assert.match(persistenceSource, /options\.secretStore\.write\(options\.key, options\.nextValue\)/);
  assert.match(persistenceSource, /delete config\[options\.key\]/);
  assert.match(persistenceSource, /options\.secretStore\.writeWithRollback/);
  assert.match(secretStoreSource, /delete ciphertexts\[key\]/);
  assert.match(source, /\^client-config\(\?:\\\.secrets\)\?\\\.json/);
  assert.match(source, /cleanupClientConfigTempFiles\(\)/);
});

test("desktop 配置读取保留 unknown 并在就绪后发无秘密信号", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const preload = readFileSync(path.join(__dirname, "../preload/index.ts"), "utf8");

  assert.match(source, /type DesktopClientConfigReadResult[\s\S]*\{ ok: false \}/);
  assert.match(source, /if \(!desktopClientConfigReady \|\| !isDesktopClientConfigKey\(key\)\) return \{ ok: false \}/);
  assert.match(source, /desktopClientConfigReady = true/);
  assert.match(source, /contents\.send\("qingagent:client-config-ready"\)/);
  assert.match(preload, /if \(!clientConfigReady\) throw new Error/);
  assert.match(preload, /if \(result\.ok !== true\) throw new Error/);
  assert.match(preload, /onClientConfigReady:/);
});

test("旧 DB 经 desktop startServer 启动迁移后 usage 观测列可用且旧行保真", async () => {
  const source = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.ok(
    source.indexOf("await runMigrations()") < source.indexOf('await import("@qingagent/server/app")'),
    "desktop 必须先跑迁移再加载 server app",
  );
  const tempDir = mkdtempSync(path.join(tmpdir(), "qingagent-desktop-usage-upgrade-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${path.join(tempDir, "documents.db")}`;
  const clients = await import("@qingagent/db/client");
  const migrations = await import("@qingagent/db/migrations");
  const registry = await import("@qingagent/db/migrations/registry");
  clients.__resetDocumentsClientForTest();
  migrations.__resetMigrationsForTest();
  try {
    await migrations.runMigrations(registry.MIGRATIONS.slice(0, 2));
    const client = clients.getDocumentsClient();
    await client.execute(
      `INSERT INTO llm_usage_events
       (id, session_id, call_site, model_id, key_origin, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, created_at)
       VALUES ('desktop-old', 'session-old', 'agent', 'deepseek-v4-flash', 'env', 11, 2, 7, 4, '2026-01-01T00:00:00.000Z')`,
    );
    migrations.__resetMigrationsForTest();
    const pendingMigrationIds = registry.MIGRATIONS.slice(2).map((migration) => migration.id);
    assert.deepEqual((await migrations.runMigrations()).appliedIds, pendingMigrationIds);
    const row = (await client.execute("SELECT * FROM llm_usage_events WHERE id = 'desktop-old'")).rows[0];
    assert.equal(Number(row?.input_tokens), 11);
    assert.equal(String(row?.usage_state), "recorded");
    assert.equal(row?.lane, null);
    assert.equal(row?.attempt, null);
    assert.equal(row?.cache_accounting_state, "unknown");
  } finally {
    clients.__resetDocumentsClientForTest();
    migrations.__resetMigrationsForTest();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("desktop 在 server app 求值后接管关闭信号并使用 Electron 退出动作", () => {
  const source = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  const appImportLine = source.indexOf('await import("@qingagent/server/app")');
  const guardImportLine = source.indexOf('await import("@qingagent/server/crashGuard")');
  const claimLine = source.indexOf("claimShutdownSignalOwnership({", guardImportLine);
  const electronExitLine = source.indexOf("electronApp.exit(code ?? 0)", claimLine);

  assert.ok(appImportLine >= 0 && guardImportLine > appImportLine, "信号接管模块必须在 server app 求值后加载");
  assert.ok(claimLine > guardImportLine, "desktop server 启动路径必须调用信号所有权接管");
  assert.ok(electronExitLine > claimLine, "desktop 必须把最终退出动作交给 Electron app.exit");
});

test("desktop 仅在退出应用时对生成中任务给出明确中断提示", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const hostSource = readFileSync(
    path.join(__dirname, "../../../web/src/system/DesktopDialogHost.tsx"),
    "utf8",
  );
  const preloadSource = readFileSync(path.join(__dirname, "../preload/index.ts"), "utf8");

  assert.match(source, /hasActiveDesktopGeneration/);
  assert.match(source, /rendererDialogBroker\.request\([\s\S]*"quit-during-generation"/);
  assert.match(source, /showNativeQuitFallback\(owner\)/);
  assert.doesNotMatch(source, /dialog\.showMessageBox/);
  assert.match(hostSource, /title:\s*"正在生成，退出将中断"/);
  assert.match(hostSource, /confirmLabel:\s*"退出应用"/);
  assert.match(hostSource, /cancelLabel:\s*"继续生成"/);
  assert.match(preloadSource, /onDesktopDialogRequest/);
  assert.match(preloadSource, /respondToDesktopDialog/);
  assert.match(source, /quitCoordinator\.handleWindowClose\(event\)/);
});

function findLine(lines: string[], marker: string): number {
  return lines.findIndex((line) => line.includes(marker));
}

function readStartupShellHtml(source: string): string {
  return source.match(/const STARTUP_SHELL_HTML = `([\s\S]*?)`;/)?.[1] ?? "";
}
