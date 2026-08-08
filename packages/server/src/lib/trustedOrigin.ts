import type { Context, MiddlewareHandler } from "hono";
import { isCommandMutationPath } from "./commandsAuth";

// CSRF 防护:敏感写操作挡掉跨站请求(恶意网页向本机后端发 POST/DELETE)。
// 浏览器跨站请求一定带 Origin 头;受信来源=精确的本机 Web Origin+
// QINGAGENT_TRUSTED_ORIGINS 配置的生产 Origin。其余路由为兼容旧同源/CLI 请求仍允许
// 无 Origin；commands mutation 必须显式带 Origin，并另有 token 主防线。
const DEFAULT_LOCAL_WEB_PORTS = ["5173", "6173", "5191", "8090", "8091"];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function addPort(ports: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{1,5}$/.test(trimmed)) return;
  const port = Number(trimmed);
  if (port >= 1 && port <= 65_535) ports.add(String(port));
}

function addUrlPort(ports: Set<string>, value: string | undefined): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return;
    addPort(ports, url.port || "80");
  } catch {
    // 非法开发 URL 不扩大白名单。
  }
}

function localWebOrigins(): Set<string> {
  const ports = new Set(DEFAULT_LOCAL_WEB_PORTS);
  // 端口来源与 Web/Vite 配置保持一致:
  // - QINGAGENT_WEB_PORT / QINGAGENT_PREVIEW_PORT 是显式 dev/preview 端口;
  // - Vite 在未设 QINGAGENT_WEB_PORT 时读取 PORT;
  // - 桌面开发可通过 QINGAGENT_DESKTOP_DEV_URL 指向当前 worktree 的真实 Web 端口。
  addPort(ports, process.env.QINGAGENT_WEB_PORT);
  addPort(ports, process.env.QINGAGENT_PREVIEW_PORT);
  addPort(ports, process.env.PORT);
  addUrlPort(ports, process.env.QINGAGENT_DESKTOP_DEV_URL);

  const origins = new Set<string>();
  for (const port of ports) {
    for (const host of LOOPBACK_HOSTS) {
      const origin = normalizeExactOrigin(`http://${host}:${port}`);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

function normalizeExactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of (process.env.QINGAGENT_TRUSTED_ORIGINS ?? "").split(",")) {
    const origin = normalizeExactOrigin(value.trim());
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isTrustedOrigin(origin: string): boolean {
  const normalized = normalizeExactOrigin(origin);
  if (!normalized) return false;
  return localWebOrigins().has(normalized) || configuredOrigins().has(normalized);
}

export function requireTrustedOrigin(
  c: Context,
  options: { allowMissing?: boolean } = {},
): Response | null {
  const origin = c.req.header("Origin");
  if (!origin) {
    return options.allowMissing === false
      ? c.json({ error: "跨站请求被拒绝" }, 403)
      : null; // 其余旧同源/CLI 路由维持兼容；高危 command mutation 由中央守卫收紧。
  }
  if (isTrustedOrigin(origin)) return null;

  const normalizedOrigin = normalizeExactOrigin(origin);
  const host = c.req.header("Host");
  if (normalizedOrigin && host) {
    try {
      const hostname = new URL(`http://${host}`).hostname;
      // 仅给 Vite changeOrigin:false 保留下来的同源 loopback 写请求开窄例外:
      // - 跨源本地页的 Origin 端口与 Host 不同，无法通过全 Origin 相等检查；
      // - DNS rebinding / 生产 nginx 的 Host 是公网域名，不是 loopback 字面量；
      // 因而二者都不走此分支，生产仍须显式配置 QINGAGENT_TRUSTED_ORIGINS。
      if (
        LOOPBACK_HOSTS.includes(hostname) &&
        normalizedOrigin === `http://${host}`
      ) {
        return null;
      }
    } catch {
      // 非法 Host 不扩大白名单。
    }
  }

  return c.json({ error: "跨站请求被拒绝" }, 403);
}

// 全站写方法(POST/PUT/DELETE/PATCH)统一 CSRF 守卫:挂在 /api/* 上,消灭"逐路由人工挂"的遗漏面
// (真实遗漏是 POST /skills/:name/:action)。GET 等读方法不拦(SSE 等仍由各自路由内联守卫按需处理)。
const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
export const csrfMutationGuard: MiddlewareHandler = async (c, next) => {
  if (MUTATION_METHODS.has(c.req.method)) {
    const pathname = new URL(c.req.url).pathname;
    const rejected = requireTrustedOrigin(c, {
      allowMissing: !isCommandMutationPath(pathname),
    });
    if (rejected) return rejected;
  }
  return next();
};
