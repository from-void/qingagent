import type { Context, MiddlewareHandler } from "hono";

// CSRF 防护:敏感写操作挡掉跨站请求(恶意网页向本机后端发 POST/DELETE)。
// 浏览器跨站请求一定带 Origin 头;受信来源=本机(localhost/127.0.0.1 任意端口)+
// QINGAGENT_TRUSTED_ORIGINS 配置的生产域。无 Origin(同源/curl)放行。
export function isTrustedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      return true;
    }
    const trusted = (process.env.QINGAGENT_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return trusted.includes(origin) || trusted.includes(url.host);
  } catch {
    return false;
  }
}

export function requireTrustedOrigin(c: Context): Response | null {
  const origin = c.req.header("Origin");
  if (!origin) return null; // 同源/curl 无 Origin
  // 同源放行:浏览器同源 POST 也带 Origin,但其 host 必等于请求 Host;恶意跨站的 Origin
  // host 与后端 Host 不等。这样站点自身请求无需配 QINGAGENT_TRUSTED_ORIGINS 即放行
  // (生产 nginx 透传 Host=$host,后端 Host 即公网域名,与 Origin 同源)。
  const host = c.req.header("Host");
  if (host) {
    try {
      if (new URL(origin).host === host) return null;
    } catch {
      // origin 非法 URL → 落到下面 isTrustedOrigin 判定/拒绝
    }
  }
  if (!isTrustedOrigin(origin)) {
    return c.json({ error: "跨站请求被拒绝" }, 403);
  }
  return null;
}

// 全站写方法(POST/PUT/DELETE/PATCH)统一 CSRF 守卫:挂在 /api/* 上,消灭"逐路由人工挂"的遗漏面
// (真实遗漏是 POST /skills/:name/:action)。GET 等读方法不拦(SSE 等仍由各自路由内联守卫按需处理)。
const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
export const csrfMutationGuard: MiddlewareHandler = async (c, next) => {
  if (MUTATION_METHODS.has(c.req.method)) {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;
  }
  return next();
};
