import "dotenv/config";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { installLongKeepAliveDispatcher } from "./lib/httpDispatcher.js";

// WSL/受限网络:宿主透明代理形态变化时 Node 直连外网(api.deepseek.com 等)会整体不通。
// 设了 HTTP(S)_PROXY 即让全部出网走代理(EnvHttpProxyAgent 尊重 NO_PROXY,本地回环不受影响);
// 生产 VPS 不设 env 则零影响、保持直连。
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 }));
} else {
  installLongKeepAliveDispatcher();
}
import { claimShutdownSignalOwnership } from "./crashGuard.js"; // Install crash/signal handlers + in-process durable log FIRST
import { serve } from "@hono/node-server";
import { assessBindSafety, logStartupSecurityWarnings, normalizeHost } from "./lib/debugGate";
// ⚠️ runMigrations 从深路径导入,刻意避开 @qingagent/core barrel:barrel 求值会连带 eval
// core/mastra.ts 的 `new Mastra`(eager-init LibSQLStore、对同一 qingagent.db 建 mastra_* 表),
// 与迁移的 BEGIN IMMEDIATE 并发争同库写锁 → SQLITE_BUSY + mastra 背景 init 崩(unhandledRejection)。
// migrations.ts 的依赖图只有 libsql,不碰 mastra;先跑完迁移,再动态 import 观测/app/回填(那时才
// 让 mastra 存储 init,已无锁竞争)。
import { runMigrations } from "@qingagent/db/migrations";
import { repairStoredDocumentRows } from "@qingagent/db";

const port = Number(process.env.PORT ?? 8080);
// 默认只监听本机回环;Docker/局域网部署需要显式设置 QINGAGENT_HOST=0.0.0.0。
const hostname = normalizeHost(process.env.QINGAGENT_HOST ?? "127.0.0.1");
const bindSafety = assessBindSafety(hostname);
if (!bindSafety.allowed) {
  console.error(bindSafety.error);
  process.exit(1);
}
if (bindSafety.auditWarning) console.warn(bindSafety.auditWarning);
logStartupSecurityWarnings({ suppressUnauthenticatedWarning: Boolean(bindSafety.auditWarning) });

try {
  const result = await runMigrations();
  if (result.appliedIds.length > 0) {
    console.log(
      `[migrations] 已应用迁移: ${result.appliedIds.join(", ")}` +
        (result.backupPath ? ` (迁移前备份: ${result.backupPath})` : ""),
    );
  }
} catch (err) {
  console.error("[migrations] 数据库迁移失败,进程退出以避免带病启动。");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  console.error("修复指引:还原最近的 qingagent.db.bak-pre-v* 备份文件后回退代码版本,或排查上面的迁移错误。");
  process.exit(1);
}

// 迁移完成后再接观测(Wire DuckDB + observability into mastra),再取 app;顺序等价于原来的
// import "./observability.js" 先于 import "./app",只是推迟到迁移之后以错开 DB 写锁。
await import("./observability.js");
const { app } = await import("./app");
const { sessionManager } = await import("./gateway/bridgeHandler");
const { startExternalInstance, stopExternalInstance } = await import("./lib/externalInstance.js");
const {
  installNetProbe,
  loadBypassMode,
  migrateThreadMetadataToDocuments,
  resolveBaseUrl,
  warmUpModelEndpoint,
} = await import("@qingagent/core");

// 开放端口前预热「以后不用再问我」的全局开关:沙箱装配、工具门禁、系统提示词都同步读
// 这个缓存,未预热时一律按默认形态(照常弹卡 + 照常隔离)。读失败也保持默认形态。
await loadBypassMode().catch(() => undefined);
const { probeBrowserCapability } = await import("@qingagent/doc-render/browser");

// 在开放监听端口前完成浏览器启动能力探测。受限容器无法创建 Chromium sandbox 时，
// 服务主体仍可启动，但健康状态会标明浏览器/PDF 能力禁用，导出路由直接返回 503。
// probeBrowserCapability() 会同步进入 getBrowser() 并在首建池时登记清理钩子；先启动
// probe promise，随即移除竞争 handler，再等待探测完成，确保 crashGuard 独占宿主退出权。
const browserCapabilityProbe = probeBrowserCapability();
claimShutdownSignalOwnership();
await browserCapabilityProbe;

// 先恢复并续跑持久化删除墓碑，再启动任何可能写 documents 的后台任务。
await sessionManager.resumePendingDeletions();

const externalInstanceFile = process.env.QINGAGENT_INSTANCE_FILE;

// 随包命令行工具的预置授权:老用户升级后不该被一张新确认卡拦住。
// 只对"已启用技能确实声明了"的路径生效,失败不阻断启动。
void (async () => {
  const { seedPresetCredentialGrants } = await import("@qingagent/core");
  const { createCredentialGrant } = await import("@qingagent/db");
  const { homedir } = await import("node:os");
  const result = await seedPresetCredentialGrants({
    home: process.env.HOME?.trim() || homedir(),
    createGrant: (input) => createCredentialGrant(input),
  });
  if (result.seeded.length > 0 || result.skipped.length > 0) {
    // 路径含宿主用户名,只报条数。
    console.log("[credential-share] 预置授权完成", {
      seeded: result.seeded.length,
      skipped: result.skipped.length,
    });
  }
})().catch((e) => console.error(
  "[credential-share] 预置授权失败(non-fatal)",
  e instanceof Error ? e.message : String(e),
));

// 迁移完成后,后台尽力而为回填 thread metadata → documents(失败不阻断启动)。
void migrateThreadMetadataToDocuments()
  .then((stats) => console.log("[migrations] thread metadata 回填完成", stats))
  .catch((e) => console.error("[migrations] thread metadata 回填失败(non-fatal)", e instanceof Error ? e.message : String(e)));

// 存量 documents 的版本指针/PM 镜像仅在启动后后台巡检修复；读取接口保持纯读，
// 避免 list/load 与用户提交竞争写锁。
void repairStoredDocumentRows()
  .then((stats) => console.log("[migrations] documents 巡检完成", stats))
  .catch((e) => console.error("[migrations] documents 巡检失败(non-fatal)", e instanceof Error ? e.message : String(e)));

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Qingagent server listening on http://${hostname}:${info.port}`);
  void startExternalInstance({
    port: info.port,
    ...(externalInstanceFile ? { filePath: externalInstanceFile } : {}),
  }).catch((error) => {
    console.error("[external] 写入 instance.json 失败", error instanceof Error ? error.message : String(error));
  });
  installNetProbe();
  warmUpModelEndpoint(resolveBaseUrl());
});

process.once("beforeExit", () => {
  void stopExternalInstance(externalInstanceFile);
});
