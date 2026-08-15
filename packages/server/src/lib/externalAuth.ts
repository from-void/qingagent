import type { MiddlewareHandler } from "hono";
import { externalError } from "./externalError";
import { getRequestPrincipal } from "./principal";

export const externalTokenMiddleware: MiddlewareHandler = async (c, next) => {
  if (getRequestPrincipal(c).kind === "externalInstance") return next();
  return externalError(c, 401, "AUTH_FAILED", "unauthorized");
};
