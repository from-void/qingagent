import type { MiddlewareHandler } from "hono";
import { externalError } from "./externalError";
import { getRequestPrincipal } from "./principal";

export const externalTokenMiddleware: MiddlewareHandler = async (c, next) => {
  const principal = getRequestPrincipal(c);
  if (principal.kind === "externalInstance") return next();
  // attachPolicy 已在前一层按 docEditing capability 精确放行此单一路由。
  if (
    principal.kind === "attachSession"
    && c.req.method === "POST"
    && /^\/api\/v1\/external\/sessions\/[^/]+\/turn-signal$/.test(c.req.path)
  ) {
    return next();
  }
  return externalError(c, 401, "AUTH_FAILED", "unauthorized");
};
