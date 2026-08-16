import type { MiddlewareHandler } from "hono";
import { getRequestPrincipal } from "./principal";

export {
  AUTH_COOKIE_NAME,
  extractAuthToken,
  tokensMatch,
} from "./authCredentials";

/**
 * 既有全局鉴权兼容层只消费 principal。未配置全局 token 时仍维持本机 API 的历史开放
 * 语义；attach/external 的边界已由前置路由授权层完成，不能在这里重新猜 bearer。
 */
export const authTokenMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/v1/external/")) return next();
  if (path === "/api/v1/attach/handshake") return next();
  if (path === "/api/v1/auth/session") return next();
  if (!process.env.QINGAGENT_AUTH_TOKEN) return next();
  const principal = getRequestPrincipal(c);
  if (principal.kind === "global" || principal.kind === "attachSession") return next();
  return c.json({ error: "unauthorized" }, 401);
};
