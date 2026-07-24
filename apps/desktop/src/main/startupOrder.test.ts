import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("desktop main only touches @qingagent/core barrel after server startup", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const lines = source.split(/\r?\n/);

  const firstCoreBarrelLine = findLine(lines, 'import("@qingagent/core")');
  const startServerLine = findLine(lines, "const serverReady = embeddedServerReady ??= startServer(");
  const serverReadyLine = findLine(lines, "({ port } = await serverReady)");

  assert.notEqual(firstCoreBarrelLine, -1, "需要保留一个迁移后的 @qingagent/core barrel 导入作为回归哨兵");
  assert.notEqual(startServerLine, -1, "未找到 server 启动调用");
  assert.notEqual(serverReadyLine, -1, "未找到 server 就绪等待");
  assert.ok(
    firstCoreBarrelLine > serverReadyLine,
    `@qingagent/core barrel 首次导入必须晚于 server 就绪: barrel=${firstCoreBarrelLine + 1}, serverReady=${serverReadyLine + 1}`,
  );
});

test("desktop 暖纸启动壳常显，再等待 server 和 seed 后同窗导航内容页", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const browserWindowLine = source.indexOf("mainWindow = new BrowserWindow(");
  const shellLoadLine = source.indexOf("contentWindow.loadURL(STARTUP_SHELL_URL)", browserWindowLine);
  const shellShowLine = source.indexOf("contentWindow.show();", shellLoadLine);
  const startServerLine = source.indexOf("const serverReady = embeddedServerReady ??= startServer(", shellShowLine);
  const serverReadyLine = source.indexOf("({ port } = await serverReady)", startServerLine);
  const seedLine = source.indexOf("await maybeSeedInitialContent();", serverReadyLine);
  const telemetryLine = source.indexOf("attachRendererTelemetry(contentWindow", seedLine);
  const finishLoadLine = source.indexOf('contentWindow.webContents.once("did-finish-load"', telemetryLine);
  const contentLoadLine = source.indexOf("contentWindow.loadURL(contentUrl)", finishLoadLine);
  const createWindowSource = source.slice(source.indexOf("async function createWindow()"), source.indexOf("// 首启示例内容"));

  assert.ok(browserWindowLine >= 0, "未创建主窗口");
  assert.ok(
    browserWindowLine < shellLoadLine && shellLoadLine < shellShowLine && shellShowLine < startServerLine,
    "主窗口必须先加载并显示启动壳，再并行发起 server 启动",
  );
  assert.ok(
    startServerLine < serverReadyLine && serverReadyLine < seedLine && seedLine < contentLoadLine,
    "内容页导航必须晚于 server 就绪与首启 seed",
  );
  assert.ok(
    seedLine < telemetryLine && telemetryLine < contentLoadLine,
    "renderer telemetry 必须跳过启动壳并覆盖内容页",
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

test("data 启动壳加载前即挂载目标 origin 白名单外链守卫", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const guardLine = source.indexOf('contentWindow.webContents.on("will-navigate"');
  const shellLoadLine = source.indexOf("contentWindow.loadURL(STARTUP_SHELL_URL)");
  const guardSource = source.slice(guardLine, shellLoadLine);

  assert.ok(guardLine >= 0 && guardLine < shellLoadLine, "will-navigate 必须在 data: 启动壳加载前挂载");
  assert.match(guardSource, /shouldOpenMainWindowNavigationExternally\(url, allowedAppOrigins\)/);
  assert.match(guardSource, /event\.preventDefault\(\)/);
  assert.match(guardSource, /shell\.openExternal\(url\)/);
  assert.doesNotMatch(guardSource, /currentIsWeb|current\.protocol/);
  assert.match(source, /addAllowedOrigin\(allowedAppOrigins, `http:\/\/localhost:\$\{port\}`\)/);
  assert.match(source, /addAllowedOrigin\(allowedAppOrigins, `http:\/\/127\.0\.0\.1:\$\{port\}`\)/);
});

test("非迁移类 startServer 失败会弹框并退出，不会停在启动壳", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const awaitLine = source.indexOf("({ port } = await serverReady)");
  const catchLine = source.indexOf("} catch (error) {", awaitLine);
  const exitLine = source.indexOf("app.exit(1);", catchLine);
  const successLine = source.indexOf("embeddedServerPort = port;", exitLine);
  const catchSource = source.slice(catchLine, successLine);

  assert.ok(awaitLine >= 0 && catchLine > awaitLine && exitLine > catchLine, "serverReady reject 必须被收口");
  assert.match(catchSource, /!isReportedServerStartupError\(error\)/);
  assert.match(catchSource, /dialog\.showErrorBox\(/);
  assert.match(catchSource, /"本地服务启动失败"/);
  assert.match(catchSource, /app\.exit\(1\)/);

  const serverSource = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  assert.match(serverSource, /throw markServerStartupErrorReported\(err\)/, "迁移失败需标记为已报错，避免重复弹框");
});

test("createWindow 复用现有窗口并以启动标志阻止并发 server", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const wrapperStart = source.indexOf("async function createWindow() {");
  const workerStart = source.indexOf("async function createWindowOnce()", wrapperStart);
  const wrapperSource = source.slice(wrapperStart, workerStart);

  assert.match(wrapperSource, /mainWindow && !mainWindow\.isDestroyed\(\)/);
  assert.match(wrapperSource, /if \(windowStartupInProgress\) return/);
  assert.match(wrapperSource, /windowStartupInProgress = true/);
  assert.match(wrapperSource, /finally \{\s*windowStartupInProgress = false/s);
  assert.match(source, /embeddedServerReady \?\?= startServer\(/, "macOS 重开窗口必须复用同一 server promise");
});

test("desktop 在 embedded server 启动前且 app ready 后装配凭据 key provider", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const readyLine = source.indexOf("app.whenReady().then(async () => {");
  const providerLine = source.indexOf("await configureDesktopCredentialKeyProvider(");
  const probeLine = source.indexOf('process.env.QINGAGENT_SANDBOX_RUNTIME_PROBE === "1"', providerLine);
  const createWindowLine = source.indexOf("await createWindow();", providerLine);

  assert.ok(readyLine >= 0 && providerLine > readyLine, "safeStorage provider 必须在 app ready 后装配");
  assert.ok(
    createWindowLine > providerLine,
    "key provider 必须早于 createWindow（startServer 在 createWindow 内执行）",
  );
  assert.ok(probeLine > providerLine && createWindowLine > probeLine, "沙箱探针必须继续在 createWindow 前短路");
});

test("QINGAGENT_DEVTOOLS=1 在打包态也以独立窗口打开主窗口 DevTools", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  assert.match(source, /isDev \|\| process\.env\.QINGAGENT_DEVTOOLS === "1"/);
  assert.match(source, /contentWindow\.webContents\.openDevTools\(\{ mode: "detach" \}\)/);
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
  assert.match(mainSource, /cleanupOrphanedPdfExportDirs\(\)/);
});

test("desktop 模型 key 由 safeStorage 加密，迁移先写密文再清明文且不可用时 fail-closed", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");

  for (const key of [
    "qingagent.deepseek_api_key",
    "qingagent.custom_provider",
    "qingagent.vision_provider",
  ]) {
    assert.ok(source.includes(`"${key}"`), `缺少桌面模型敏感配置项：${key}`);
  }
  assert.match(source, /safeStorage\.encryptString\(value\)/);
  assert.match(source, /safeStorage\.decryptString\(Buffer\.from\(value, "base64"\)\)/);
  assert.match(source, /getSelectedStorageBackend\(\) !== "basic_text"/);

  const migrationStart = source.indexOf("function migratePlaintextClientSecrets()");
  const encryptedWrite = source.indexOf("writeEncryptedClientSecrets(encrypted);", migrationStart);
  const plaintextClear = source.indexOf("writeClientConfig(sanitized);", migrationStart);
  assert.ok(encryptedWrite > migrationStart && plaintextClear > encryptedWrite, "迁移必须先落密文再清明文");

  const rendererReadStart = source.indexOf("function readClientConfigForRenderer()");
  const stripPlaintext = source.indexOf("delete cfg[key]", rendererReadStart);
  const unavailableReturn = source.indexOf("if (!isDesktopModelEncryptionAvailable()) return cfg;", rendererReadStart);
  assert.ok(
    stripPlaintext > rendererReadStart && unavailableReturn > stripPlaintext,
    "加密不可用前必须先从 renderer 快照剥离明文 key",
  );
  assert.match(source, /secretPatch\.length > 0 && !encryptionAvailable\) return false/);
  assert.match(source, /secretEntries\.filter\(\(\[, value\]\) => typeof value === "string" && value !== ""\)/);
  assert.match(source, /if \(secretEntries\.length > 0\) writeEncryptedClientSecrets\(encrypted\)/);
  assert.match(source, /delete cfg\[k\]/);
  assert.match(source, /delete encrypted\[k\]/);
  assert.match(source, /\^client-config\\\.json\\\.\\d\+\\\.tmp\$/);
  assert.match(source, /cleanupClientConfigTempFiles\(\)/);
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

test("desktop 在迁移及 server app 求值后非阻断挂载 documents 巡检", () => {
  const source = readFileSync(path.join(__dirname, "server.ts"), "utf8");
  const migrationsLine = source.indexOf("await runMigrations()");
  const appImportLine = source.indexOf('await import("@qingagent/server/app")');
  const repairImportLine = source.indexOf('void import("@qingagent/db")');
  const repairCallLine = source.indexOf("repairStoredDocumentRows()", repairImportLine);

  assert.ok(migrationsLine >= 0 && repairImportLine > migrationsLine, "documents 巡检必须晚于迁移启动");
  assert.ok(appImportLine >= 0 && repairImportLine > appImportLine, "DB 聚合入口必须在 server app 求值后加载");
  assert.ok(repairCallLine > repairImportLine, "documents 巡检必须由后台动态导入触发");
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

function findLine(lines: string[], marker: string): number {
  return lines.findIndex((line) => line.includes(marker));
}

function readStartupShellHtml(source: string): string {
  return source.match(/const STARTUP_SHELL_HTML = `([\s\S]*?)`;/)?.[1] ?? "";
}
