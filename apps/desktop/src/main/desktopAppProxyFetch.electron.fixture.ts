import { app, BrowserWindow, protocol } from "electron";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createDesktopAppProxyHandler,
  DESKTOP_APP_SCHEME,
  DESKTOP_APP_URL,
} from "./desktopAppProtocol.js";
import { createNodeHttpProxyFetch } from "./desktopAppProxyFetch.js";

const RESULT_PREFIX = "QINGAGENT_SSE_EOF_ELECTRON_RESULT=";

app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

void app.whenReady().then(async () => {
  let eventResponse: ServerResponse | null = null;
  let upstreamClosedAt = 0;
  let eventRequests = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/events") {
      eventRequests += 1;
      eventResponse = response;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write("event: ready\ndata: {}\n\n");
      return;
    }
    if (pathname === "/close") {
      upstreamClosedAt = Date.now();
      eventResponse?.end();
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const proxy = createDesktopAppProxyHandler(
    port,
    createNodeHttpProxyFetch(),
    "fixture-command-token",
  );
  protocol.handle(DESKTOP_APP_SCHEME, (request) => {
    if (new URL(request.url).pathname === "/") {
      return new Response("<!doctype html><title>SSE EOF fixture</title>", {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    return proxy(request);
  });

  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL(DESKTOP_APP_URL);
    const renderer = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const source = new EventSource('/events');
        let readyAt = 0;
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          source.close();
          resolve(value);
        };
        source.addEventListener('ready', () => {
          readyAt = Date.now();
          void fetch('/close', { method: 'POST' }).catch((error) => {
            finish({ timedOut: false, fetchError: String(error), readyAt, errorAt: 0 });
          });
        });
        source.onerror = () => {
          finish({ timedOut: false, fetchError: '', readyAt, errorAt: Date.now() });
        };
        setTimeout(() => {
          finish({ timedOut: true, fetchError: '', readyAt, errorAt: 0 });
        }, 5000);
      })
    `) as {
      timedOut: boolean;
      fetchError: string;
      readyAt: number;
      errorAt: number;
    };
    console.log(RESULT_PREFIX + JSON.stringify({
      ...renderer,
      upstreamClosedAt,
      eventRequests,
      eofDelayMs: renderer.errorAt > 0 && upstreamClosedAt > 0
        ? renderer.errorAt - upstreamClosedAt
        : null,
    }));
  } finally {
    window.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
