import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "qa_auth";

// 定长常量时间比较:先 sha256 成定长摘要再 timingSafeEqual,避免 timingSafeEqual 因长度不等抛错,
// 也避免"提前按长度返回"泄漏 token 长度。
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// 凭据三来源优先级:Authorization: Bearer <token> -> cookie qa_auth -> query ?auth=<token>(逃生舱)。
function extractToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const cookie = getCookie(c, AUTH_COOKIE_NAME);
  if (cookie) return cookie;
  const q = c.req.query("auth");
  if (q) return q;
  return null;
}

// 可选 token 鉴权:QINGAGENT_AUTH_TOKEN 未设则直通(本机/桌面零配置)。设了才对 /api/* 校验。
// 豁免:OPTIONS(CORS 预检)、external 子树(由 externalTokenMiddleware 独立鉴权)、
// POST /api/v1/auth/session(拿 token 换 HttpOnly cookie 的入口)。
export const authTokenMiddleware: MiddlewareHandler = async (c, next) => {
  const expected = process.env.QINGAGENT_AUTH_TOKEN;
  if (!expected) return next();
  if (c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/v1/external/")) return next();
  if (path === "/api/v1/auth/session") return next();
  const provided = extractToken(c);
  if (provided && tokensMatch(provided, expected)) return next();
  return c.json({ error: "unauthorized" }, 401);
};
