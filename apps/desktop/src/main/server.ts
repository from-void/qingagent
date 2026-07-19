import "dotenv/config";
import { serve } from "@hono/node-server";
import { app as electronApp, dialog } from "electron";
import path from "node:path";
import { telemetry } from "./telemetry/index.js";
import { createSingleFlightStarter } from "./serverSingleton.js";
import { ToolCallStreamScanner } from "./toolCallStreamScanner.js";

const toolCallStreamScanner = new ToolCallStreamScanner((name) => telemetry.trackToolUsed(name));

export interface StartServerOptions {
  desktopLogDir: string;
}

async function startServerOnce(options: StartServerOptions): Promise<{ port: number }> {
  // ⚠️ 迁移必须先于 @qingagent/core barrel / @qingagent/server/app 求值。
  // barrel 会连带 eval core/mastra.ts 的 new Mastra,其 LibSQLStore 可能抢同库写锁。
  // TODO(B2 createQingagentRuntime):长期应由显式运行时工厂统一管理这段启动顺序。
  const { runMigrations } = await import("@qingagent/db/migrations");
  try {
    await runMigrations();
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    dialog.showErrorBox(
      "数据库迁移失败",
      "青简无法完成数据库升级,已停止启动以保护你的数据。\n" +
        "最近一次迁移前的自动备份位于数据目录下的 qingagent.db.bak-pre-v* 文件。\n\n" +
        detail,
    );
    electronApp.exit(1);
    throw err;
  }

  const { installDesktopObservability } = await import("./diagnostics/observability.js");
  installDesktopObservability(options.desktopLogDir);

  const { app: honoApp } = await import("@qingagent/server/app");
  const { claimShutdownSignalOwnership } = await import("@qingagent/server/crashGuard");
  // app/core/doc-render 已完成求值：移除模块级竞争信号处理器。最终用 Electron 的退出动作，
  // 但仍由 crashGuard 先完成 active turn、会话持久化、浏览器及观测数据的收尾。
  claimShutdownSignalOwnership({
    exit: (code) => electronApp.exit(code ?? 0),
  });
  const { serveStatic } = await import("@hono/node-server/serve-static");

  // 存量 documents 的版本指针/PM 镜像仅在启动后后台巡检修复；读取接口保持纯读。
  // 放在 app 完成求值后再动态加载 DB 聚合入口，维持上方“迁移先于 core/server barrel”的锁顺序。
  void import("@qingagent/db")
    .then(({ repairStoredDocumentRows }) => repairStoredDocumentRows())
    .then((stats) => console.log("[migrations] documents 巡检完成", stats))
    .catch((e) => console.error("[migrations] documents 巡检失败(non-fatal)", e instanceof Error ? e.message : String(e)));

  // 桌面端专有:渲染端埋点同源中继。渲染端 POST 到本 localhost 服务器(同源,无 CORS、
  // 不经系统代理),由主进程转发到 Umami。必须注册在静态服务之前。
  honoApp.post("/__telemetry/send", async (c) => {
    try {
      const body = await c.req.text();
      if (!body || body.length > 16384) return c.json({ ok: false }, 413);
      telemetry.forwardRendererEvent(body);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 400);
    }
  });

  // In production, serve the built web app as static files
  if (electronApp.isPackaged) {
    const webRoot = path.join(process.resourcesPath, "web");
    honoApp.use(
      "/*",
      serveStatic({
        root: webRoot,
      }),
    );
  }

  // API 观察钩子:包一层 fetch,从既有 API 流量里提取语义埋点(发消息/应用编辑/导出/配key)。
  // 这样比前端 DOM 埋稳得多且零侵入 web;只观察不拦截,任何异常都吞掉。
  const baseFetch = honoApp.fetch.bind(honoApp);
  const observedFetch: typeof honoApp.fetch = async (req, ...rest) => {
    let bodyClone: Request | null = null;
    try {
      // body 必须在被处理器消费之前 clone;只对需要看 body 的两条路径 clone。
      const p = new URL(req.url).pathname;
      if ((req.method === "POST" && p === "/api/v1/stream") || (req.method === "PUT" && p === "/api/v1/settings/model")) {
        bodyClone = req.clone();
      }
    } catch {
      /* 观察失败不影响请求 */
    }
    const res = await baseFetch(req, ...rest);
    try {
      observeApiForTelemetry(req, res.status, bodyClone);
    } catch {
      /* 观察失败不影响请求 */
    }
    // agent 生成流:tee 一份 SSE 响应,后台扫 toolCallUpdated 帧提工具名(tool_used)。
    try {
      const p = new URL(req.url).pathname;
      if (
        req.method === "POST" &&
        p === "/api/v1/stream" &&
        res.status < 400 &&
        res.body &&
        (res.headers.get("content-type") || "").includes("event-stream")
      ) {
        const [pass, tap] = res.body.tee();
        void toolCallStreamScanner.scan(tap);
        return new Response(pass, res);
      }
    } catch {
      /* tee 失败原样返回 */
    }
    return res;
  };

  return new Promise((resolve) => {
    // 桌面渲染端只加载本机 localhost 服务,固定回环监听可减少局域网暴露面。
    const server = serve({ fetch: observedFetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      console.log(`Embedded server started on port ${info.port}`);
      void import("@qingagent/server/externalInstance").then(({ startExternalInstance }) =>
        startExternalInstance({ port: info.port }),
      ).catch((error) => {
        console.error("[external] 写入 instance.json 失败", error instanceof Error ? error.message : String(error));
      });
      resolve({ port: info.port });
    });
  });
}

export const startServer = createSingleFlightStarter(startServerOnce);

/** 从成功的 API 请求提取语义埋点;fire-and-forget,绝不抛。 */
function observeApiForTelemetry(req: Request, status: number, bodyClone: Request | null): void {
  if (status >= 400) return;
  const url = new URL(req.url);
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/v1/stream" && bodyClone) {
    void bodyClone
      .json()
      .then((cmd: { kind?: string } | null) => {
        const kind = cmd?.kind;
        if (kind === "sendMessage") telemetry.trackMessageSent();
        else if (kind === "acceptPatch" || kind === "commitPatches") telemetry.trackPatchApplied(kind);
      })
      .catch(() => {});
  } else if (req.method === "POST" && p === "/api/v1/commit") {
    telemetry.trackPatchApplied("commitPatches");
  } else if (req.method === "GET" && p.startsWith("/api/v1/export/")) {
    telemetry.trackExportDone(url.searchParams.get("format") || "unknown");
  } else if (req.method === "PUT" && p === "/api/v1/settings/model" && bodyClone) {
    void bodyClone
      .json()
      .then((b: { apiKey?: unknown } | null) => {
        if (typeof b?.apiKey === "string" && b.apiKey.trim().length > 0) telemetry.trackKeyConfigured();
      })
      .catch(() => {});
  }
}
