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
import "./crashGuard.js"; // Install crash/signal handlers + in-process durable log FIRST
import { serve } from "@hono/node-server";
import { assessBindSafety, logStartupSecurityWarnings } from "./lib/debugGate";
// ⚠️ runMigrations 从深路径导入,刻意避开 @qingagent/core barrel:barrel 求值会连带 eval
// core/mastra.ts 的 `new Mastra`(eager-init LibSQLStore、对同一 qingagent.db 建 mastra_* 表),
// 与迁移的 BEGIN IMMEDIATE 并发争同库写锁 → SQLITE_BUSY + mastra 背景 init 崩(unhandledRejection)。
// migrations.ts 的依赖图只有 libsql,不碰 mastra;先跑完迁移,再动态 import 观测/app/回填(那时才
// 让 mastra 存储 init,已无锁竞争)。
import { runMigrations } from "@qingagent/db/migrations";

const port = Number(process.env.PORT ?? 8080);
// 默认只监听本机回环;Docker/局域网部署需要显式设置 QINGAGENT_HOST=0.0.0.0。
const hostname = process.env.QINGAGENT_HOST ?? "127.0.0.1";
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
const { startExternalInstance, stopExternalInstance } = await import("./lib/externalInstance.js");
const {
  installNetProbe,
  migrateThreadMetadataToDocuments,
  resolveBaseUrl,
  warmUpModelEndpoint,
} = await import("@qingagent/core");

// 迁移完成后,后台尽力而为回填 thread metadata → documents(失败不阻断启动)。
void migrateThreadMetadataToDocuments()
  .then((stats) => console.log("[migrations] thread metadata 回填完成", stats))
  .catch((e) => console.error("[migrations] thread metadata 回填失败(non-fatal)", e instanceof Error ? e.message : String(e)));

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Qingagent server listening on http://${hostname}:${info.port}`);
  void startExternalInstance({ port: info.port }).catch((error) => {
    console.error("[external] 写入 instance.json 失败", error instanceof Error ? error.message : String(error));
  });
  installNetProbe();
  warmUpModelEndpoint(resolveBaseUrl());
});

process.once("beforeExit", () => {
  void stopExternalInstance();
});
