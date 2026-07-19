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
  const startServerLine = findLine(lines, "await startServer(");

  assert.notEqual(firstCoreBarrelLine, -1, "需要保留一个迁移后的 @qingagent/core barrel 导入作为回归哨兵");
  assert.notEqual(startServerLine, -1, "未找到 server 启动调用");
  assert.ok(
    firstCoreBarrelLine > startServerLine,
    `@qingagent/core barrel 首次导入必须晚于 server 启动: barrel=${firstCoreBarrelLine + 1}, startServer=${startServerLine + 1}`,
  );
});

test("desktop 在 embedded server 启动前且 app ready 后装配凭据 key provider", () => {
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const readyLine = source.indexOf("app.whenReady().then(async () => {");
  const providerLine = source.indexOf("await configureDesktopCredentialKeyProvider(");
  const createWindowLine = source.indexOf("await createWindow();", providerLine);

  assert.ok(readyLine >= 0 && providerLine > readyLine, "safeStorage provider 必须在 app ready 后装配");
  assert.ok(
    createWindowLine > providerLine,
    "key provider 必须早于 createWindow（startServer 在 createWindow 内执行）",
  );
});

test("desktop PDF 导出使用私有临时目录、随机文件名和最小文件权限并整目录清理", () => {
  const source = readFileSync(path.join(__dirname, "pdfRenderer.ts"), "utf8");

  assert.match(source, /mkdtempSync\(path\.join\(app\.getPath\("temp"\), "qingagent-export-"\)\)/);
  assert.match(source, /chmodSync\(tmpDir, 0o700\)/);
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /flag: "wx"/);
  assert.match(source, /rmSync\(tmpDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /qingagent-export-\$\{process\.pid\}/);
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
  assert.match(source, /secretPatch\.length > 0 && !isDesktopModelEncryptionAvailable\(\)\) return false/);
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

function findLine(lines: string[], marker: string): number {
  return lines.findIndex((line) => line.includes(marker));
}
