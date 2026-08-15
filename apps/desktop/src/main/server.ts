import "dotenv/config";
import { serve } from "@hono/node-server";
import { app as electronApp, dialog } from "electron";
import path from "node:path";
import { listenWithDesktopPortFallback, resolveDesktopPort } from "./desktopPort.js";
import { telemetry } from "./telemetry/index.js";
import { createSingleFlightStarter } from "./serverSingleton.js";
const reportedServerStartupErrors = new WeakSet<object>();

export function isReportedServerStartupError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && reportedServerStartupErrors.has(error));
}

function markServerStartupErrorReported(error: unknown): Error {
  const reportedError = error instanceof Error ? error : new Error(String(error));
  reportedServerStartupErrors.add(reportedError);
  return reportedError;
}

export interface StartServerOptions {
  desktopLogDir: string;
  shutdownRecoveryMarkerPath?: string;
}

export interface EmbeddedServerInfo {
  port: number;
  commandAuthToken: string;
  /** external 子树专用:恒为本实例 instance token(不随 QINGAGENT_AUTH_TOKEN 变),深链探测等同应用请求靠它过 external 鉴权。 */
  externalAuthToken: string;
}

async function startServerOnce(options: StartServerOptions): Promise<EmbeddedServerInfo> {
  // ⚠️ 迁移必须先于 @qingagent/core barrel / @qingagent/server/app 求值。
  // barrel 会连带 eval core/mastra.ts 的 new Mastra,其 LibSQLStore 可能抢同库写锁。
  const { runMigrations } = await import("@qingagent/db/migrations");
  try {
    await runMigrations();
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("[startup] 数据库迁移失败:", detail);
    dialog.showErrorBox(
      "数据库迁移失败",
      "青简已停止启动，以免影响你的数据。升级前的备份仍保留在数据目录中。" +
        "请查看应用日志或联系支持后重试。",
    );
    electronApp.exit(1);
    throw markServerStartupErrorReported(err);
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
  if (options.shutdownRecoveryMarkerPath) {
    const { resumeInterruptedDesktopShutdown } = await import("@qingagent/server/desktopShutdown");
    await resumeInterruptedDesktopShutdown({
      recoveryMarkerPath: options.shutdownRecoveryMarkerPath,
    });
  }
  const { serveStatic } = await import("@hono/node-server/serve-static");

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
      if ((req.method === "POST" && p === "/api/v1/commands") || (req.method === "PUT" && p === "/api/v1/settings/model")) {
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
    return res;
  };

  const preferredPort = resolveDesktopPort(process.env.QINGAGENT_DESKTOP_PORT);
  const result = await listenWithDesktopPortFallback(
    preferredPort,
    (port) => listenEmbeddedServer(observedFetch, port),
  );
  if (result.fellBack) {
    console.warn(`[desktop] 端口 ${preferredPort} 已被占用，已回退到随机端口 ${result.port}`);
  }
  console.log(`Embedded server started on port ${result.port}`);
  // command 鉴权必须在 renderer 发出首个请求前就绪；不能沿用旧 fire-and-forget，
  // 否则冷启动窗口存在 token 尚未装配的竞态。写 instance 失败时由桌面启动路径 fail-closed。
  const { startExternalInstance } = await import("@qingagent/server/externalInstance");
  const { issueDesktopGlobalToken } = await import("@qingagent/server/authCredentials");
  const { getOrCreateLibraryId } = await import("@qingagent/server/libraryIdentity");
  const libraryId = await getOrCreateLibraryId();
  const instance = await startExternalInstance({ port: result.port, libraryId });
  return {
    port: result.port,
    commandAuthToken: process.env.QINGAGENT_AUTH_TOKEN || issueDesktopGlobalToken(),
    externalAuthToken: instance.token,
  };
}

function listenEmbeddedServer(fetch: Parameters<typeof serve>[0]["fetch"], port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // 桌面渲染端只加载本机 localhost 服务，固定回环监听可减少局域网暴露面。
    const onError = (error: Error) => reject(error);
    const server = serve({ fetch, port, hostname: "127.0.0.1" }, (info) => {
      server.off("error", onError);
      resolve(info.port);
    });
    server.once("error", onError);
  });
}

export const startServer = createSingleFlightStarter(startServerOnce);

/** 从成功的 API 请求提取语义埋点;fire-and-forget,绝不抛。 */
function observeApiForTelemetry(req: Request, status: number, bodyClone: Request | null): void {
  if (status >= 400) return;
  const url = new URL(req.url);
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/v1/commands" && bodyClone) {
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
