import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ATTACH_CORS_ALLOWED_REQUEST_HEADERS,
  ATTACH_DATA_ROUTE_TEMPLATES,
  ATTACH_MODEL_OVERRIDE_HEADERS,
} from "@qingagent/contract-ts";
import type { BackendConnection } from "./backendConnection.js";
import {
  DESKTOP_APP_HOST,
  DESKTOP_APP_ORIGIN,
  DESKTOP_APP_SCHEME,
} from "./desktopAppProtocol.js";

export const DESKTOP_DATA_SCHEME = "qingagent-data";
export const DESKTOP_DATA_HOST = "library";
export const DESKTOP_DATA_ORIGIN = `${DESKTOP_DATA_SCHEME}://${DESKTOP_DATA_HOST}`;
export const DESKTOP_DATA_URL = `${DESKTOP_DATA_ORIGIN}/`;

const RESPONSE_HEADER_LIMIT = 32 * 1024;
const RESPONSE_BODY_LIMIT = 512 * 1024 * 1024;
const ATTACH_ALLOWED_HEADERS = new Set<string>(ATTACH_CORS_ALLOWED_REQUEST_HEADERS);
const EMBEDDED_ALLOWED_HEADERS = new Set<string>([
  ...ATTACH_CORS_ALLOWED_REQUEST_HEADERS,
  ...ATTACH_MODEL_OVERRIDE_HEADERS,
  "authorization",
]);
const ACTIVE_CONTENT_TYPES = ["text/html", "image/svg+xml", "application/pdf"];

export interface PackagedAssetEntry {
  filePath: string;
  sha256: string;
  contentType: string;
}

export type PackagedAssetManifest = ReadonlyMap<string, PackagedAssetEntry>;

function contentTypeForFile(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}

/** 创建后每次响应仍复核 hash，打包静态 origin 不会退化成任意文件服务器。 */
export async function createPackagedAssetManifest(root: string): Promise<PackagedAssetManifest> {
  const entries = new Map<string, PackagedAssetEntry>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(filePath);
      const relative = `/${path.relative(root, filePath).split(path.sep).join("/")}`;
      entries.set(relative, {
        filePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: contentTypeForFile(filePath),
      });
    }
  };
  await visit(root);
  return entries;
}

export function createDesktopShellProtocolHandler(
  manifest: PackagedAssetManifest,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let url: URL;
    try { url = new URL(request.url); } catch { return new Response("Not found", { status: 404 }); }
    if (
      url.protocol !== `${DESKTOP_APP_SCHEME}:`
      || url.host !== DESKTOP_APP_HOST
      || (request.method !== "GET" && request.method !== "HEAD")
      || url.search !== ""
    ) return new Response("Not found", { status: 404 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Not found", { status: 404 }); }
    if (pathname.includes("..") || pathname.includes("\\")) return new Response("Not found", { status: 404 });
    const key = pathname === "/" ? "/index.html" : pathname;
    const asset = manifest.get(key);
    if (!asset) return new Response("Not found", { status: 404 });
    try {
      const stats = await lstat(asset.filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) return new Response("Not found", { status: 404 });
      const bytes = await readFile(asset.filePath);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Type": asset.contentType,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": key === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

function matchesTemplate(pathname: string, template: string): boolean {
  const actual = pathname.split("/");
  const expected = template.split("/");
  if (actual.length !== expected.length) return false;
  return expected.every((part, index) => {
    if (!part.startsWith(":")) return part === actual[index];
    let decoded: string;
    try { decoded = decodeURIComponent(actual[index]!); } catch { return false; }
    return decoded.length > 0
      && decoded.length <= 256
      && !decoded.includes("..")
      && !decoded.includes("/")
      && !decoded.includes("\\");
  });
}

export function isAttachDataRoute(method: string, pathname: string): boolean {
  return ATTACH_DATA_ROUTE_TEMPLATES.some(([allowedMethod, template]) =>
    allowedMethod === method.toUpperCase() && matchesTemplate(pathname, template));
}

function corsHeaders(
  allowedRendererOrigin: string,
  extra: HeadersInit = {},
  preflight = false,
  allowCredentials = false,
): Headers {
  const headers = new Headers(extra);
  headers.set("Access-Control-Allow-Origin", allowedRendererOrigin);
  headers.set(
    "Vary",
    preflight
      ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      : "Origin",
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "Content-Disposition, X-Qingagent-Export-Degradations, X-Qingagent-Export-Notice",
  );
  if (allowCredentials) headers.set("Access-Control-Allow-Credentials", "true");
  else headers.delete("Access-Control-Allow-Credentials");
  return headers;
}

function forbidden(
  code: string,
  status = 403,
  allowedRendererOrigin = DESKTOP_APP_ORIGIN,
  allowCredentials = false,
): Response {
  return Response.json({ error: { code, message: "数据请求被拒绝" } }, {
    status,
    headers: corsHeaders(
      allowedRendererOrigin,
      { "Cache-Control": "no-store" },
      false,
      allowCredentials,
    ),
  });
}

function preflightResponse(
  request: Request,
  backend: BackendConnection,
  pathname: string,
  allowedRendererOrigin: string,
): Response {
  const allowCredentials = backend.mode === "embedded";
  if (request.headers.get("origin") !== allowedRendererOrigin) {
    return forbidden("CORS_ORIGIN_DENIED", 403, allowedRendererOrigin, allowCredentials);
  }
  const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
  const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = backend.mode === "attach" ? ATTACH_ALLOWED_HEADERS : EMBEDDED_ALLOWED_HEADERS;
  if (!requestedMethod || requestedHeaders.some((name) => !allowedHeaders.has(name))) {
    return forbidden(
      "CORS_PREFLIGHT_DENIED",
      403,
      allowedRendererOrigin,
      allowCredentials,
    );
  }
  const routeAllowed = backend.mode === "attach"
    ? isAttachDataRoute(requestedMethod, pathname)
    : pathname.startsWith("/api/")
      || pathname === "/health"
      || pathname === "/__telemetry/send";
  if (!routeAllowed) {
    return forbidden("CORS_ROUTE_DENIED", 403, allowedRendererOrigin, allowCredentials);
  }
  const headers = corsHeaders(allowedRendererOrigin, {
    "Access-Control-Allow-Methods": requestedMethod,
    "Access-Control-Allow-Headers": requestedHeaders.join(", "),
    "Cache-Control": "no-store",
  }, true, allowCredentials);
  return new Response(null, { status: 204, headers });
}

function responseHeaders(
  upstream: Response,
  pathname: string,
  allowedRendererOrigin: string,
): Headers | null {
  const headers = new Headers();
  let byteCount = 0;
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower === "set-cookie"
      || lower === "location"
      || lower === "www-authenticate"
      || lower === "authorization"
      || lower.startsWith("access-control-")
    ) return;
    byteCount += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (byteCount <= RESPONSE_HEADER_LIMIT) headers.append(name, value);
  });
  if (byteCount > RESPONSE_HEADER_LIMIT) return null;
  const contentLength = Number(headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RESPONSE_BODY_LIMIT) return null;

  const upstreamType = (headers.get("content-type") ?? "").toLowerCase();
  if (pathname === "/api/v1/events" || upstreamType.startsWith("text/event-stream")) {
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
  } else if (pathname.startsWith("/api/v1/materials/") && pathname.endsWith("/text")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  } else if (ACTIVE_CONTENT_TYPES.some((type) => upstreamType.startsWith(type))) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", "attachment");
  } else if (!upstreamType) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  if (pathname.startsWith("/api/v1/export/")) headers.set("Content-Disposition", "attachment");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  headers.set("Cache-Control", "no-store");
  return corsHeaders(allowedRendererOrigin, headers);
}

function limitResponseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > RESPONSE_BODY_LIMIT) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error("response body limit exceeded"));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function embeddedResponse(
  upstream: Response,
  requestMethod: string,
  allowedRendererOrigin: string,
): Response {
  const headers = corsHeaders(allowedRendererOrigin, upstream.headers, false, true);
  const noBody = requestMethod === "HEAD" || [204, 205, 304].includes(upstream.status);
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function createDesktopDataProtocolHandler(
  backend: BackendConnection,
  allowedRendererOrigin = DESKTOP_APP_ORIGIN,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const allowCredentials = backend.mode === "embedded";
    let url: URL;
    try { url = new URL(request.url); } catch {
      return forbidden("DATA_URL_INVALID", 404, allowedRendererOrigin, allowCredentials);
    }
    if (url.protocol !== `${DESKTOP_DATA_SCHEME}:` || url.host !== DESKTOP_DATA_HOST) {
      return forbidden("DATA_ORIGIN_DENIED", 404, allowedRendererOrigin, allowCredentials);
    }
    if (request.method === "OPTIONS") {
      return preflightResponse(request, backend, url.pathname, allowedRendererOrigin);
    }
    const requestOrigin = request.headers.get("origin");
    // 无 Origin 仅用于浏览器无法读取响应体的 no-cors 图片/媒体子资源。
    if (requestOrigin !== null && requestOrigin !== allowedRendererOrigin) {
      return forbidden("CORS_ORIGIN_DENIED", 403, allowedRendererOrigin, allowCredentials);
    }
    if (backend.mode === "attach" && !isAttachDataRoute(request.method, url.pathname)) {
      return forbidden("ATTACH_ROUTE_DENIED", 403, allowedRendererOrigin, allowCredentials);
    }
    let upstream: Response;
    try {
      upstream = await backend.forwardDataRequest(request);
    } catch {
      return forbidden("BACKEND_UNAVAILABLE", 502, allowedRendererOrigin, allowCredentials);
    }
    if (upstream.status < 200) {
      void upstream.body?.cancel().catch(() => undefined);
      return forbidden(
        "UPSTREAM_STATUS_DENIED",
        502,
        allowedRendererOrigin,
        allowCredentials,
      );
    }
    if (backend.mode === "embedded") {
      return embeddedResponse(upstream, request.method, allowedRendererOrigin);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => undefined);
      return forbidden("UPSTREAM_REDIRECT_DENIED", 502, allowedRendererOrigin);
    }
    const headers = responseHeaders(upstream, url.pathname, allowedRendererOrigin);
    if (!headers) {
      void upstream.body?.cancel().catch(() => undefined);
      return forbidden("UPSTREAM_LIMIT_EXCEEDED", 502, allowedRendererOrigin);
    }
    const noBody = request.method === "HEAD" || [204, 205, 304].includes(upstream.status);
    const responseBody = noBody || !upstream.body
      ? null
      : url.pathname === "/api/v1/events"
        ? upstream.body
        : limitResponseBody(upstream.body);
    return new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
}
